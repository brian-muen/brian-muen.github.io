#!/usr/bin/env node
/**
 * Enrich bookshelf markdown with moods, genres, subjects, places, language,
 * fiction flag, and dominant cover color.
 *
 * Sources (in priority order for moods/genres):
 *   1. Hardcover GraphQL (HARDCOVER_API_TOKEN) — real moods + genres
 *   2. Storygraph CSV moods (optional path arg / default Downloads)
 *   3. Open Library subjects / places
 *   4. Google Books categories
 *
 * Usage:
 *   HARDCOVER_API_TOKEN=... node scripts/enrich-bookshelf.mjs [--force]
 *   node scripts/enrich-bookshelf.mjs [--force] [path/to/storygraph.csv]
 */
import { readFile, writeFile, mkdir, readdir, access, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createReadStream } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parse } from 'csv-parse';
import jpeg from 'jpeg-js';
import { inflateSync } from 'node:zlib';

const execFileAsync = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const outDir = path.join(root, 'src/content/bookshelf');
const coverDir = path.join(root, 'public/covers/bookshelf');
const cacheDir = path.join(root, '.tmp-wp/enrich-cache');

const force = process.argv.includes('--force');
const csvArg = process.argv.find((a) => a.endsWith('.csv'));
const storygraphCsv =
  csvArg ||
  path.join(
    process.env.HOME || '',
    'Downloads/ab3fa717133180bd8a861b0e9bfaf78023eb23c30419db3ff86c724993e2f33f.csv'
  );
const HARDCOVER_TOKEN = process.env.HARDCOVER_API_TOKEN || '';

await mkdir(cacheDir, { recursive: true });

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function yamlEscape(s) {
  return `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function yamlList(arr) {
  if (!arr?.length) return null;
  return `[${arr.map((s) => yamlEscape(s)).join(', ')}]`;
}

function normalize(title) {
  return title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/favourite/g, 'favorite')
    .replace(/\(.*?\)/g, '')
    .replace(/:.*$/, '')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\b(the|a|an)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function matches(a, b) {
  if (!a || !b) return false;
  return a === b || a.startsWith(b) || b.startsWith(a) || a.includes(b) || b.includes(a);
}

function parseFrontmatter(src) {
  const m = src.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { data: {}, body: src };
  const data = {};
  for (const line of m[1].split('\n')) {
    const i = line.indexOf(':');
    if (i < 0) continue;
    const key = line.slice(0, i).trim();
    let val = line.slice(i + 1).trim();
    if (val.startsWith('[') && val.endsWith(']')) {
      data[key] = val
        .slice(1, -1)
        .split(',')
        .map((s) => s.trim().replace(/^"|"$/g, '').replace(/\\"/g, '"'))
        .filter(Boolean);
    } else if (val === 'true' || val === 'false') {
      data[key] = val === 'true';
    } else if (/^-?\d+(\.\d+)?$/.test(val)) {
      data[key] = Number(val);
    } else {
      data[key] = val.replace(/^"|"$/g, '').replace(/\\"/g, '"');
    }
  }
  return { data, body: m[2] };
}

function serializeFrontmatter(data, body) {
  const order = [
    'title',
    'author',
    'dateRead',
    'dateAdded',
    'approx',
    'rating',
    'pages',
    'pubYear',
    'readCount',
    'cover',
    'isbn',
    'moods',
    'genres',
    'subjects',
    'places',
    'language',
    'coverColor',
    'fiction',
    'pace',
  ];
  const keys = [...order.filter((k) => data[k] !== undefined && data[k] !== null && data[k] !== ''), ...Object.keys(data).filter((k) => !order.includes(k))];
  const lines = ['---'];
  for (const key of keys) {
    const val = data[key];
    if (Array.isArray(val)) {
      const list = yamlList(val);
      if (list) lines.push(`${key}: ${list}`);
    } else if (typeof val === 'boolean') {
      lines.push(`${key}: ${val}`);
    } else if (typeof val === 'number') {
      lines.push(`${key}: ${val}`);
    } else if (typeof val === 'string') {
      if (['title', 'author', 'isbn', 'cover', 'language', 'coverColor', 'pace'].includes(key) || /[:#"']/.test(val)) {
        lines.push(`${key}: ${yamlEscape(val)}`);
      } else {
        lines.push(`${key}: ${val}`);
      }
    }
  }
  lines.push('---', '');
  return lines.join('\n') + (body || '').replace(/^\n/, '');
}

async function fileExists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function cacheGet(key) {
  const p = path.join(cacheDir, `${key}.json`);
  if (!(await fileExists(p))) return null;
  try {
    return JSON.parse(await readFile(p, 'utf8'));
  } catch {
    return null;
  }
}

async function cacheSet(key, value) {
  await writeFile(path.join(cacheDir, `${key}.json`), JSON.stringify(value));
}

async function fetchJson(url, opts = {}) {
  let lastErr;
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const res = await fetch(url, {
        ...opts,
        headers: {
          'User-Agent': 'brian-personal-site-enricher/1.0',
          Accept: 'application/json',
          ...(opts.headers || {}),
        },
      });
      if (res.status === 429 || res.status === 503) {
        const wait = Math.min(60_000, 1500 * 2 ** attempt);
        console.warn(`  ${res.status} — waiting ${Math.round(wait / 1000)}s`);
        await sleep(wait);
        continue;
      }
      if (!res.ok) throw new Error(`${res.status} ${url}`);
      return res.json();
    } catch (e) {
      lastErr = e;
      if (String(e.message).startsWith('429') || String(e.message).startsWith('503')) {
        continue;
      }
      // network blip
      if (attempt < 5 && /fetch failed|ECONNRESET|ETIMEDOUT/i.test(String(e))) {
        await sleep(1000 * (attempt + 1));
        continue;
      }
      throw e;
    }
  }
  throw lastErr || new Error(`failed ${url}`);
}

function uniq(arr, limit = 12) {
  const seen = new Set();
  const out = [];
  for (const raw of arr || []) {
    const s = String(raw).trim();
    if (!s) continue;
    const k = s.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(s);
    if (out.length >= limit) break;
  }
  return out;
}

function titleCase(s) {
  return s.replace(/\w\S*/g, (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
}

function inferFiction(subjects = [], genres = [], categories = []) {
  const blob = [...subjects, ...genres, ...categories].join(' ').toLowerCase();
  if (!blob) return undefined;
  const nonficHints = [
    'biography',
    'autobiography',
    'history',
    'science',
    'business',
    'self-help',
    'self help',
    'philosophy',
    'religion',
    'politics',
    'economics',
    'psychology',
    'memoir',
    'essays',
    'nonfiction',
    'non-fiction',
    'computers',
    'technology',
    'mathematics',
    'medicine',
    'health',
  ];
  const ficHints = ['fiction', 'novel', 'fantasy', 'science fiction', 'mystery', 'thriller', 'romance', 'horror', 'literary'];
  const non = nonficHints.some((h) => blob.includes(h));
  const fic = ficHints.some((h) => blob.includes(h));
  if (fic && !non) return true;
  if (non && !fic) return false;
  if (blob.includes('fiction') && !blob.includes('nonfiction') && !blob.includes('non-fiction')) return true;
  if (non) return false;
  return undefined;
}

/* ---------- Storygraph CSV seed ---------- */

async function loadStorygraphMoods(csvPath) {
  const map = new Map();
  if (!(await fileExists(csvPath))) {
    console.log(`No Storygraph CSV at ${csvPath}`);
    return map;
  }
  const rows = [];
  await new Promise((resolve, reject) => {
    createReadStream(csvPath)
      .pipe(parse({ columns: true, relax_quotes: true, relax_column_count: true }))
      .on('data', (row) => rows.push(row))
      .on('error', reject)
      .on('end', resolve);
  });
  for (const row of rows) {
    if ((row['Read Status'] || '').toLowerCase() !== 'read') continue;
    const moods = (row.Moods || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map(titleCase);
    const pace = (row.Pace || '').trim().toLowerCase() || undefined;
    if (!moods.length && !pace) continue;
    map.set(normalize(row.Title || ''), { moods, pace });
  }
  console.log(`Storygraph mood seeds: ${map.size}`);
  return map;
}

/* ---------- Hardcover ---------- */

const HC_JUNK_TITLE = /study guide|summary &|cliffnotes|sparknotes|bookrags|bright summaries/i;
const HC_GENRE_ALLOW = new Set([
  'Fiction',
  'Nonfiction',
  'Literary Fiction',
  'Science Fiction',
  'Fantasy',
  'Mystery',
  'Thriller',
  'Horror',
  'Romance',
  'Historical Fiction',
  'Contemporary',
  'Classics',
  'Young Adult',
  'Graphic Novel',
  'Poetry',
  'Drama',
  'Short Stories',
  'Essays',
  'Biography',
  'Memoir',
  'History',
  'Philosophy',
  'Psychology',
  'Science',
  'Business',
  'Self-Help',
  'Humor',
  'Adventure',
  'Crime',
  'Literary',
]);

function cleanHcGenres(genres = []) {
  const out = [];
  for (const g of genres) {
    const s = String(g).trim();
    if (!s) continue;
    // Drop noisy subject-like genres from Hardcover search facets
    if (/man-woman|relationships|college students|fiction -|literature &|general/i.test(s)) continue;
    if (HC_GENRE_ALLOW.has(s) || HC_GENRE_ALLOW.has(titleCase(s))) {
      out.push(HC_GENRE_ALLOW.has(s) ? s : titleCase(s));
      continue;
    }
    // Keep a few common variants
    if (/^sci-?fi$/i.test(s)) out.push('Science Fiction');
    else if (/historical fiction/i.test(s)) out.push('Historical Fiction');
    else if (/^non-?fiction$/i.test(s)) out.push('Nonfiction');
    else if (/^memoir$/i.test(s)) out.push('Memoir');
  }
  return uniq(out, 8);
}

function scoreHardcoverHit(doc, title, author) {
  if (!doc?.title) return -1;
  if (HC_JUNK_TITLE.test(doc.title)) return -1;
  const tNorm = normalize(doc.title);
  const wantT = normalize(title);
  const authors = (doc.author_names || []).map((a) => normalize(a));
  const wantA = normalize(author).split(' ').filter((w) => w.length > 2);
  let score = 0;
  if (tNorm === wantT) score += 50;
  else if (tNorm.startsWith(wantT) || wantT.startsWith(tNorm)) score += 30;
  else if (matches(tNorm, wantT)) score += 15;
  else return -1;
  const authorHit = authors.some((a) => wantA.every((w) => a.includes(w)) || matches(a, normalize(author)));
  if (authorHit) score += 40;
  else if (authors.length && wantA.some((w) => authors.some((a) => a.includes(w)))) score += 10;
  else score -= 20;
  const moods = doc.moods?.length || 0;
  const genres = doc.genres?.length || 0;
  score += Math.min(moods, 8) + Math.min(genres, 5);
  if ((doc.users_read_count || 0) > 100) score += 5;
  return score;
}

async function hardcoverSearch(title, author, isbn) {
  if (!HARDCOVER_TOKEN) return null;
  const cacheKey = `hc2-${normalize(title).slice(0, 40)}-${normalize(author).slice(0, 20)}`;
  const cached = await cacheGet(cacheKey);
  if (cached) return cached;

  const query = `
    query SearchBooks($query: String!) {
      search(query: $query, query_type: "Book", per_page: 8, page: 1) {
        results
      }
    }
  `;
  const queries = [
    `title:${title.replace(/"/g, '')} author:${author.replace(/"/g, '')}`,
  ];
  // Only try plain query if title/author form fails
  const fallbacks = [`${title} ${author}`.trim()];
  if (isbn) queries.unshift(`isbn:${isbn}`);

  try {
    let bestData = null;
    let bestParsed = null;
    for (const q of [...queries, ...fallbacks]) {
      const data = await fetchJson('https://api.hardcover.app/v1/graphql', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: HARDCOVER_TOKEN.startsWith('Bearer ')
            ? HARDCOVER_TOKEN
            : `Bearer ${HARDCOVER_TOKEN}`,
        },
        body: JSON.stringify({ query, variables: { query: q } }),
      });
      await sleep(600);
      const parsed = parseHardcover(data, title, author);
      if (parsed && (parsed.moods.length || parsed.genres.length)) {
        bestData = data;
        bestParsed = parsed;
        break;
      }
      if (!bestParsed && parsed) {
        bestData = data;
        bestParsed = parsed;
      }
    }
    const out = { raw: bestData, parsed: bestParsed };
    await cacheSet(cacheKey, out);
    return out;
  } catch (e) {
    console.warn(`  Hardcover fail: ${e.message}`);
    return null;
  }
}

function parseHardcover(data, title = '', author = '') {
  const results = data?.data?.search?.results;
  let hits = [];
  if (Array.isArray(results)) hits = results;
  else if (results?.hits) hits = results.hits.map((h) => h.document || h);
  else if (typeof results === 'object' && results !== null) {
    hits = results.books || [];
  }
  if (!hits.length) return null;

  let best = null;
  let bestScore = -1;
  for (const doc of hits) {
    const score = scoreHardcoverHit(doc, title, author);
    if (score > bestScore) {
      bestScore = score;
      best = doc;
    }
  }
  if (!best || bestScore < 20) return null;

  const moods = uniq(
    (best.moods || []).map((m) => titleCase(String(m))),
    8
  );
  const genres = cleanHcGenres(best.genres || []);
  const tags = best.cached_tags || {};
  const tagMoods = (tags.Mood || []).map((t) => titleCase(t.tag || t.name || '')).filter(Boolean);
  const tagGenres = cleanHcGenres((tags.Genre || []).map((t) => t.tag || t.name || ''));

  let fiction;
  const gblob = genres.join(' ').toLowerCase();
  if (/\bnonfiction\b|\bbiography\b|\bmemoir\b|\bhistory\b|\bessay/.test(gblob) && !/\bfiction\b/.test(gblob)) {
    fiction = false;
  } else if (/\bfiction\b|\bfantasy\b|\bmystery\b|\bthriller\b|\bromance\b|\bhorror\b/.test(gblob)) {
    fiction = true;
  } else if (genres.includes('Nonfiction')) {
    fiction = false;
  } else if (genres.includes('Fiction') || genres.includes('Literary Fiction')) {
    fiction = true;
  }

  return {
    moods: uniq([...moods, ...tagMoods], 8),
    genres: uniq([...genres, ...tagGenres], 8),
    fiction,
    title: best.title,
    score: bestScore,
  };
}

/* ---------- Open Library ---------- */

async function openLibraryLookup(isbn, title, author) {
  const cacheKey = `ol-${isbn || normalize(title).slice(0, 40)}`;
  const cached = await cacheGet(cacheKey);
  if (cached) return cached;

  try {
    let data = null;
    if (isbn) {
      data = await fetchJson(
        `https://openlibrary.org/api/books?bibkeys=ISBN:${isbn}&format=json&jscmd=data`
      );
      data = data[`ISBN:${isbn}`] || null;
    }
    if (!data) {
      const q = encodeURIComponent(`title:${title} author:${author}`);
      const search = await fetchJson(
        `https://openlibrary.org/search.json?q=${q}&limit=1`
      );
      const doc = search.docs?.[0];
      if (doc?.key) {
        const workKey = doc.key; // /works/OL...
        data = await fetchJson(`https://openlibrary.org${workKey}.json`);
        // normalize to similar shape
        data = {
          subjects: data.subjects,
          subject_places: data.subject_places,
          subject_people: data.subject_people,
          subject_times: data.subject_times,
          title: data.title,
          number_of_pages: doc.number_of_pages_median,
          identifiers: { isbn_13: doc.isbn },
        };
      }
    }
    await cacheSet(cacheKey, data);
    await sleep(150);
    return data;
  } catch (e) {
    console.warn(`  Open Library fail: ${e.message}`);
    return null;
  }
}

function parseOpenLibrary(data) {
  if (!data) return null;
  const subjects = uniq(
    (data.subjects || []).map((s) => (typeof s === 'string' ? s : s.name || s)).filter(Boolean),
    16
  );
  const places = uniq(
    (data.subject_places || []).map((s) => (typeof s === 'string' ? s : s.name || s)).filter(Boolean),
    8
  );
  return { subjects, places };
}

/* ---------- Google Books ---------- */

async function googleBooksLookup(isbn, title, author) {
  const cacheKey = `gb-${isbn || normalize(title).slice(0, 40)}`;
  const cached = await cacheGet(cacheKey);
  if (cached) return cached;
  try {
    const q = isbn
      ? `isbn:${isbn}`
      : `intitle:${title} inauthor:${author}`;
    const data = await fetchJson(
      `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(q)}&maxResults=1`
    );
    await cacheSet(cacheKey, data);
    await sleep(120);
    return data;
  } catch (e) {
    console.warn(`  Google Books fail: ${e.message}`);
    return null;
  }
}

function parseGoogleBooks(data) {
  const info = data?.items?.[0]?.volumeInfo;
  if (!info) return null;
  const categories = uniq(info.categories || [], 8);
  // Derive coarse genres from categories like "Fiction / Literary"
  const genres = uniq(
    categories.flatMap((c) =>
      c
        .split('/')
        .map((p) => p.trim())
        .filter((p) => p && !/^general$/i.test(p))
    ),
    8
  );
  return {
    categories,
    genres,
    language: info.language || undefined,
  };
}

/* ---------- Cover color ---------- */

function rgbToHex(r, g, b) {
  const clamp = (x) => Math.max(0, Math.min(255, Math.round(x)));
  return `#${[r, g, b].map((x) => clamp(x).toString(16).padStart(2, '0')).join('')}`;
}

/** Decode a basic 8-bit RGB/RGBA PNG (no interlacing) into RGBA pixels. */
function decodePng(buf) {
  if (buf[0] !== 0x89 || buf[1] !== 0x50) return null;
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 8;
  let colorType = 2;
  const idats = [];
  while (offset + 8 <= buf.length) {
    const len = buf.readUInt32BE(offset);
    const type = buf.toString('ascii', offset + 4, offset + 8);
    const data = buf.subarray(offset + 8, offset + 8 + len);
    offset += 12 + len;
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      if (data[10] !== 0 || data[11] !== 0 || data[12] !== 0) return null; // compression/filter/interlace
    } else if (type === 'IDAT') {
      idats.push(data);
    } else if (type === 'IEND') {
      break;
    }
  }
  if (!width || !height || bitDepth !== 8 || (colorType !== 2 && colorType !== 6)) return null;
  const bpp = colorType === 6 ? 4 : 3;
  const raw = inflateSync(Buffer.concat(idats));
  const stride = width * bpp;
  const rgba = new Uint8Array(width * height * 4);
  let src = 0;
  let prev = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[src++];
    const row = raw.subarray(src, src + stride);
    src += stride;
    const out = new Uint8Array(stride);
    for (let i = 0; i < stride; i++) {
      const x = row[i];
      const a = i >= bpp ? out[i - bpp] : 0;
      const b = prev[i];
      const c = i >= bpp ? prev[i - bpp] : 0;
      let val = x;
      if (filter === 1) val = (x + a) & 255;
      else if (filter === 2) val = (x + b) & 255;
      else if (filter === 3) val = (x + ((a + b) >> 1)) & 255;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        const pr = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
        val = (x + pr) & 255;
      } else if (filter !== 0) return null;
      out[i] = val;
    }
    for (let x = 0; x < width; x++) {
      const si = x * bpp;
      const di = (y * width + x) * 4;
      rgba[di] = out[si];
      rgba[di + 1] = out[si + 1];
      rgba[di + 2] = out[si + 2];
      rgba[di + 3] = bpp === 4 ? out[si + 3] : 255;
    }
    prev = out;
  }
  return { width, height, data: rgba };
}

function decodeCoverImage(buf) {
  if (buf[0] === 0x89 && buf[1] === 0x50) return decodePng(buf);
  try {
    return jpeg.decode(buf, { useTArray: true, formatAsRGBA: true });
  } catch {
    return null;
  }
}

function bucketTone(r, g, b) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const light = max / 255;
  const sat = max === 0 ? 0 : (max - min) / max;
  return { light, sat };
}

function isNearWhite(r, g, b) {
  const { light, sat } = bucketTone(r, g, b);
  return light > 0.78 && sat < 0.18;
}

function isNearBlack(r, g, b) {
  return r + g + b < 48;
}

function quantizeKey(r, g, b) {
  return `${Math.min(240, Math.round(r / 24) * 24)},${Math.min(240, Math.round(g / 24) * 24)},${Math.min(240, Math.round(b / 24) * 24)}`;
}

function winnerFromBuckets(buckets) {
  let best = null;
  let bestN = -1;
  for (const [key, n] of buckets) {
    if (n > bestN) {
      bestN = n;
      best = key;
    }
  }
  if (!best) return null;
  const [r, g, b] = best.split(',').map(Number);
  return { r, g, b, n: bestN };
}

/**
 * First column that is actually printed cover (opaque), including white.
 * Do NOT skip white covers (Dance Dance Dance) — but do skip a thin white
 * letterbox when non-white cover content starts immediately after.
 */
function findCoverLeftEdge(width, height, data) {
  const y0 = Math.floor(height * 0.12);
  const y1 = Math.floor(height * 0.88);
  const yStep = Math.max(1, Math.floor(height / 64));
  const maxScan = Math.min(width, Math.floor(width * 0.15));

  const columnStats = (x) => {
    let opaque = 0;
    let white = 0;
    let samples = 0;
    for (let y = y0; y < y1; y += yStep) {
      const i = (y * width + x) * 4;
      samples += 1;
      if (data[i + 3] < 200) continue;
      opaque += 1;
      if (isNearWhite(data[i], data[i + 1], data[i + 2])) white += 1;
    }
    return { opaque, white, samples };
  };

  let firstOpaque = 0;
  for (let x = 0; x < maxScan; x++) {
    const s = columnStats(x);
    if (s.samples > 0 && s.opaque / s.samples > 0.6) {
      firstOpaque = x;
      break;
    }
  }

  const first = columnStats(firstOpaque);
  if (first.opaque > 0 && first.white / first.opaque > 0.7) {
    const peek = Math.min(width, firstOpaque + Math.max(4, Math.round(width * 0.03)));
    for (let x = firstOpaque + 1; x < peek; x++) {
      const s = columnStats(x);
      if (s.opaque / Math.max(1, s.samples) <= 0.6) continue;
      if (s.white / Math.max(1, s.opaque) < 0.45) return x;
    }
  }
  return firstOpaque;
}

function mergeEdgeBuckets(buckets) {
  const merged = [];
  const used = new Set();
  const near = (a, b) => {
    const [ar, ag, ab] = a.split(',').map(Number);
    const [br, bg, bb] = b.split(',').map(Number);
    return Math.max(Math.abs(ar - br), Math.abs(ag - bg), Math.abs(ab - bb)) <= 24;
  };
  for (const [key] of buckets) {
    if (used.has(key)) continue;
    let sumR = 0;
    let sumG = 0;
    let sumB = 0;
    let mass = 0;
    for (const [other, on] of buckets) {
      if (used.has(other)) continue;
      if (other !== key && !near(key, other)) continue;
      used.add(other);
      const [r, g, b] = other.split(',').map(Number);
      sumR += r * on;
      sumG += g * on;
      sumB += b * on;
      mass += on;
    }
    const r = Math.round(sumR / mass);
    const g = Math.round(sumG / mass);
    const b = Math.round(sumB / mass);
    const { light, sat } = bucketTone(r, g, b);
    merged.push({ r, g, b, mass, light, sat });
  }
  return merged;
}

function scoreEdgeColors(merged) {
  return merged
    .map((c) => {
      let score = c.mass;
      // Prefer real ink/cloth over paper white / crop black when both present.
      if (c.sat >= 0.18 && c.light >= 0.12 && c.light <= 0.9) score *= 2.4 + c.sat;
      else if (isNearWhite(c.r, c.g, c.b)) score *= 0.55;
      else if (isNearBlack(c.r, c.g, c.b)) score *= 0.7;
      return { ...c, score };
    })
    .sort((a, b) => b.score - a.score);
}

function sampleEdgeBand(width, height, data, x0, x1, y0, y1) {
  const buckets = new Map();
  let total = 0;
  const xStart = Math.max(0, x0);
  const xEnd = Math.min(width, x1);
  for (let y = y0; y < y1; y++) {
    for (let x = xStart; x < xEnd; x++) {
      const i = (y * width + x) * 4;
      if (data[i + 3] < 200) continue;
      const key = quantizeKey(data[i], data[i + 1], data[i + 2]);
      buckets.set(key, (buckets.get(key) || 0) + 1);
      total += 1;
    }
  }
  return { buckets, total };
}

/**
 * Color of the strip that would abut a physical spine.
 * Sample the center-third left edge, tally total presence (not longest run),
 * and prefer chromatic colors when white/black share the edge with them —
 * so Dance Dance Dance stays white, but Stamped's blue/red collage wins
 * over fragmented title-band white.
 *
 * Thin black frames (Miso Soup) peek just inward for cloth color; deep black
 * borders that meet cream fields (Dubliners) stay black.
 */
function extractEdgeColor(width, height, data) {
  const left = findCoverLeftEdge(width, height, data);
  const band = Math.max(2, Math.min(6, Math.round(width * 0.02)));
  const y0 = Math.floor(height * 0.33);
  const y1 = Math.floor(height * 0.67);

  const { buckets, total } = sampleEdgeBand(width, height, data, left, left + band, y0, y1);
  if (!total) return null;

  const scored = scoreEdgeColors(mergeEdgeBuckets(buckets));
  let best = scored[0];
  if (!best) return null;

  // Black only if it still owns a solid share after chroma preference.
  if (isNearBlack(best.r, best.g, best.b) && best.mass < total * 0.35) {
    const alt = scored.find(
      (c) => !isNearBlack(c.r, c.g, c.b) && c.mass >= total * 0.12
    );
    if (alt) best = alt;
    else return null;
  }

  // Thin black frame only (Miso Soup): peek just inside for cloth/ink.
  // Deep black borders/covers (Dubliners, Persepolis) stay black.
  if (isNearBlack(best.r, best.g, best.b)) {
    const thinMax = Math.max(6, Math.round(width * 0.025));
    let frameEnd = null;
    for (let x = left; x < left + thinMax + 2 && x < width; x++) {
      let black = 0;
      let seen = 0;
      for (let y = y0; y < y1; y++) {
        const i = (y * width + x) * 4;
        if (data[i + 3] < 200) continue;
        seen += 1;
        if (isNearBlack(data[i], data[i + 1], data[i + 2])) black += 1;
      }
      if (seen > 0 && black / seen < 0.45) {
        frameEnd = x;
        break;
      }
    }
    if (frameEnd != null && frameEnd - left <= thinMax) {
      const inward = sampleEdgeBand(
        width,
        height,
        data,
        frameEnd,
        frameEnd + Math.max(band + 8, Math.round(width * 0.06)),
        y0,
        y1
      );
      if (inward.total > 0) {
        const inwardScored = scoreEdgeColors(mergeEdgeBuckets(inward.buckets));
        const cloth = inwardScored.find(
          (c) =>
            c.sat >= 0.2 &&
            c.light >= 0.12 &&
            c.light <= 0.9 &&
            !isNearWhite(c.r, c.g, c.b) &&
            !isNearBlack(c.r, c.g, c.b) &&
            c.mass >= inward.total * 0.06
        );
        if (cloth) best = cloth;
      }
    }
  }

  return rgbToHex(best.r, best.g, best.b);
}

/**
 * Fallback: field/accent color from the full cover when the left edge is
 * blank or inconclusive.
 */
function extractFieldColor(width, height, data) {
  const buckets = new Map();
  let totalMass = 0;
  const step = Math.max(1, Math.floor(Math.min(width, height) / 48));
  const cx = width / 2;
  const cy = height / 2;
  for (let y = Math.floor(height * 0.06); y < height * 0.94; y += step) {
    for (let x = Math.floor(width * 0.06); x < width * 0.94; x += step) {
      const i = (y * width + x) * 4;
      let r = data[i];
      let g = data[i + 1];
      let b = data[i + 2];
      if (data[i + 3] < 200) continue;
      const max = Math.max(r, g, b);
      if (max < 12) continue;
      const { light, sat } = bucketTone(r, g, b);
      const dx = (x - cx) / (width / 2);
      const dy = (y - cy) / (height / 2);
      const dist = Math.sqrt(dx * dx + dy * dy);
      const centerW = Math.max(0.4, 1 - dist * 0.5);
      let toneW = 1;
      if (light < 0.12) toneW = 0.04 + sat * 0.25;
      else if (light < 0.2) toneW = 0.15 + sat * 0.4;
      else if (light < 0.3 && sat < 0.15) toneW = 0.4;
      if (light > 0.86 && sat < 0.12) toneW *= 0.35;
      else if (light > 0.78 && sat < 0.15) toneW *= 0.55;
      const w = centerW * toneW * (0.45 + sat * 2.8);
      totalMass += w;
      const key = quantizeKey(r, g, b);
      buckets.set(key, (buckets.get(key) || 0) + w);
    }
  }
  if (!buckets.size || totalMass <= 0) return null;

  const ranked = [...buckets.entries()]
    .map(([key, n]) => {
      const [r, g, b] = key.split(',').map(Number);
      const { light, sat } = bucketTone(r, g, b);
      let score = n;
      if (sat > 0.22 && light > 0.18 && light < 0.88) score *= 1.45 + sat;
      if (sat > 0.4 && light > 0.25 && light < 0.8) score *= 1.25;
      if (light > 0.86 && sat < 0.12) score *= 0.25;
      else if (light > 0.78 && sat < 0.18) score *= 0.45;
      if (light < 0.18 && sat < 0.2) score *= 0.4;
      return { r, g, b, n, score, light, sat };
    })
    .sort((a, b) => b.score - a.score);

  const best = ranked[0];
  if (!best) return null;
  if (isNearWhite(best.r, best.g, best.b)) {
    const accent = ranked.find(
      (c) =>
        c.sat >= 0.18 &&
        c.light >= 0.12 &&
        c.light <= 0.9 &&
        c.n >= totalMass * 0.035 &&
        c.score >= best.score * 0.18
    );
    if (accent) return rgbToHex(accent.r, accent.g, accent.b);
  }
  return rgbToHex(best.r, best.g, best.b);
}

/**
 * Spine color from the cover image: prefer the left-edge strip that would
 * abut a physical spine (e.g. Dubliners' black border), else field/accent.
 */
function extractCoverColor(buf) {
  try {
    const img = decodeCoverImage(buf);
    if (!img) return null;
    const { width, height, data } = img;
    return extractEdgeColor(width, height, data) || extractFieldColor(width, height, data);
  } catch {
    return null;
  }
}

async function coverColorFor(coverPath) {
  if (!coverPath) return null;
  const clean = String(coverPath).split('?')[0];
  const local = clean.startsWith('/')
    ? path.join(root, 'public', clean)
    : path.join(coverDir, path.basename(clean));
  if (!(await fileExists(local))) return null;
  let buf = await readFile(local);
  // Some .jpg files are actually PNGs; decodeCoverImage handles both.
  // If neither works, try converting via sips (macOS) as a last resort.
  let color = extractCoverColor(buf);
  if (color) return color;
  if (process.platform === 'darwin') {
    const tmp = path.join(cacheDir, `cover-color-${path.basename(local)}.jpg`);
    try {
      await execFileAsync('sips', ['-s', 'format', 'jpeg', local, '--out', tmp], { timeout: 15000 });
      buf = await readFile(tmp);
      color = extractCoverColor(buf);
    } catch {
      /* ignore */
    } finally {
      try {
        await unlink(tmp);
      } catch {
        /* ignore */
      }
    }
  }
  return color;
}

/* ---------- Mood inference fallback from subjects ---------- */

const SUBJECT_MOOD_MAP = [
  [/humor|humour|comedy|comic|funny/i, 'Lighthearted'],
  [/horror|terror|gothic/i, 'Dark'],
  [/mystery|detective|crime|noir/i, 'Mysterious'],
  [/romance|love/i, 'Romantic'],
  [/war|tragedy|grief|death/i, 'Emotional'],
  [/philosophy|meditation|spiritual/i, 'Reflective'],
  [/adventure|quest/i, 'Adventurous'],
  [/science fiction|cyberpunk|dystop/i, 'Tense'],
  [/fantasy|magic/i, 'Imaginative'],
  [/memoir|biography|essay/i, 'Reflective'],
];

function moodsFromSubjects(subjects = []) {
  const out = [];
  for (const s of subjects) {
    for (const [re, mood] of SUBJECT_MOOD_MAP) {
      if (re.test(s)) out.push(mood);
    }
  }
  return uniq(out, 5);
}

function genresFromSubjects(subjects = []) {
  const GENRE_MAP = [
    [/science fiction|sci-fi|cyberpunk/i, 'Science Fiction'],
    [/fantasy/i, 'Fantasy'],
    [/mystery|detective|crime|noir/i, 'Mystery'],
    [/thriller|suspense/i, 'Thriller'],
    [/horror|gothic/i, 'Horror'],
    [/romance/i, 'Romance'],
    [/biography|autobiography|memoir/i, 'Biography'],
    [/history|historical/i, 'History'],
    [/philosophy/i, 'Philosophy'],
    [/psychology/i, 'Psychology'],
    [/poetry|poems/i, 'Poetry'],
    [/essay/i, 'Essays'],
    [/short stor/i, 'Short Stories'],
    [/literary|fiction, literary|fiction \/ literary/i, 'Literary Fiction'],
    [/young adult|juvenile/i, 'Young Adult'],
    [/graphic novel|comics/i, 'Graphic Novel'],
    [/self-help|self help|conduct of life/i, 'Self-Help'],
    [/business|economics|entrepreneur/i, 'Business'],
    [/science(?! fiction)|physics|biology|mathematics|calculus/i, 'Science'],
    [/drama|plays|traged/i, 'Drama'],
    [/humor|humour|comedy/i, 'Humor'],
    [/adventure/i, 'Adventure'],
    [/classic/i, 'Classics'],
  ];
  const out = [];
  for (const s of subjects) {
    for (const [re, g] of GENRE_MAP) {
      if (re.test(s)) out.push(g);
    }
  }
  const blob = subjects.join(' ').toLowerCase();
  if (!out.length && /\bfiction\b/.test(blob) && !/nonfiction|non-fiction/.test(blob)) {
    out.push('Fiction');
  }
  return uniq(out, 8);
}

export { coverColorFor, parseFrontmatter, serializeFrontmatter, extractCoverColor };

/* ---------- Main ---------- */

if (process.env.ENRICH_AS_LIB === '1') {
  // Imported as a library (e.g. by recolor-covers.mjs) — skip the enrich loop.
} else {

const storyMoods = await loadStorygraphMoods(storygraphCsv);
if (!HARDCOVER_TOKEN) {
  console.log('No HARDCOVER_API_TOKEN — moods will come from Storygraph seeds + subject inference.');
} else {
  console.log('Hardcover token present — will fetch moods/genres.');
}

const files = (await readdir(outDir)).filter((f) => f.endsWith('.md')).sort();
let enriched = 0;
let skipped = 0;

for (const file of files) {
  const fp = path.join(outDir, file);
  const src = await readFile(fp, 'utf8');
  const { data, body } = parseFrontmatter(src);

  const hasEnrichment =
    data.moods?.length || data.genres?.length || data.subjects?.length || data.coverColor;
  // With Hardcover, treat "already enriched" as having real mood tags (3+)
  const hasHardcoverish =
    Array.isArray(data.moods) && data.moods.length >= 3 && Array.isArray(data.genres) && data.genres.length >= 1;
  if (!force && (HARDCOVER_TOKEN ? hasHardcoverish : hasEnrichment)) {
    skipped += 1;
    continue;
  }
  // Soft resume: if forcing but this book already looks Hardcover-enriched, skip
  // unless HARDCOVER_FORCE_ALL=1
  if (force && HARDCOVER_TOKEN && hasHardcoverish && process.env.HARDCOVER_FORCE_ALL !== '1') {
    skipped += 1;
    continue;
  }

  process.stdout.write(`  ${file}... `);

  const title = data.title || '';
  const author = data.author || '';
  const isbn = (data.isbn || '').replace(/[^\dXx]/g, '');
  const norm = normalize(title);

  let moods = force ? [] : [...(data.moods || [])];
  let genres = force ? [] : [...(data.genres || [])];
  let subjects = [...(data.subjects || [])];
  let places = [...(data.places || [])];
  let language = data.language;
  let fiction = force ? undefined : data.fiction;
  let pace = data.pace;
  let coverColor = data.coverColor;
  const prevMoods = [...(data.moods || [])];
  const prevGenres = [...(data.genres || [])];
  const prevFiction = data.fiction;

  // Storygraph seed (only if we don't have Hardcover moods yet)
  const seed = [...storyMoods.entries()].find(([k]) => matches(k, norm))?.[1];

  // Hardcover — preferred source for moods/genres/fiction
  let fromHardcover = false;
  if (HARDCOVER_TOKEN && (force || !moods.length || !genres.length)) {
    const hcRes = await hardcoverSearch(title, author, isbn);
    const hc = hcRes?.parsed || null;
    if (hc && (hc.moods.length || hc.genres.length)) {
      fromHardcover = true;
      if (force || !moods.length) moods = hc.moods;
      else moods = uniq([...moods, ...hc.moods]);
      if (force || !genres.length) genres = hc.genres;
      else genres = uniq([...genres, ...hc.genres]);
      if (hc.fiction !== undefined && (force || fiction === undefined)) {
        fiction = hc.fiction;
      }
    }
  }

  if (!fromHardcover && seed) {
    moods = uniq([...moods, ...seed.moods]);
    if (seed.pace) pace = pace || seed.pace;
  } else if (seed?.pace) {
    pace = pace || seed.pace;
  }

  // Open Library — only fill missing subjects/places (use cache; don't refetch on force)
  if (!subjects.length || !places.length) {
    const ol = parseOpenLibrary(await openLibraryLookup(isbn, title, author));
    if (ol) {
      if (!subjects.length) subjects = uniq(ol.subjects, 16);
      if (!places.length) places = uniq(ol.places, 8);
    }
  }

  // Google Books — only when no Hardcover token (avoid 429 storms)
  if (!HARDCOVER_TOKEN && (!genres.length || !language)) {
    const gb = parseGoogleBooks(await googleBooksLookup(isbn, title, author));
    if (gb) {
      if (!genres.length) genres = uniq([...genres, ...gb.genres]);
      language = language || gb.language;
      if (fiction === undefined) {
        fiction = inferFiction(subjects, genres, gb.categories);
      }
    }
  } else if (data.language && !language) {
    language = data.language;
  }

  if (fiction === undefined) {
    fiction = inferFiction(subjects, genres, []);
  }

  // Subject inference only as last resort when Hardcover missed
  if (!fromHardcover && !moods.length) {
    moods = moodsFromSubjects(subjects);
  }

  if (!fromHardcover && !genres.length) {
    genres = genresFromSubjects(subjects);
  }

  // If force wipe + Hardcover miss, keep previous good tags rather than junk inference
  if (force && !fromHardcover) {
    if (!moods.length && prevMoods.length) moods = prevMoods;
    if ((!genres.length || genresFromSubjects(subjects).join() === genres.join()) && prevGenres.length) {
      // prefer previous over subject-inferred junk when we had something
      if (prevGenres.length) genres = prevGenres;
    }
    if (fiction === undefined && prevFiction !== undefined) fiction = prevFiction;
  }

  if (!coverColor) {
    coverColor = (await coverColorFor(data.cover)) || undefined;
  } else if (coverColor && !/^#[0-9a-fA-F]{6}$/.test(coverColor)) {
    // fix previously-bugged colors
    coverColor = (await coverColorFor(data.cover)) || undefined;
  }

  const next = {
    ...data,
    ...(moods.length ? { moods } : {}),
    ...(genres.length ? { genres } : {}),
    ...(subjects.length ? { subjects } : {}),
    ...(places.length ? { places } : {}),
    ...(language ? { language } : {}),
    ...(coverColor ? { coverColor } : {}),
    ...(fiction !== undefined ? { fiction } : {}),
    ...(pace ? { pace } : {}),
  };

  await writeFile(fp, serializeFrontmatter(next, body));
  enriched += 1;
  console.log(
    [
      moods.length && `${moods.length} moods`,
      genres.length && `${genres.length} genres`,
      subjects.length && `${subjects.length} subjects`,
      coverColor && coverColor,
    ]
      .filter(Boolean)
      .join(', ') || 'no new data'
  );
}

console.log(`\nEnriched ${enriched}; skipped ${skipped} (already enriched).`);

} // end ENRICH_AS_LIB guard
