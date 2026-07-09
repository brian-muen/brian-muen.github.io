#!/usr/bin/env node
/**
 * Restore bookshelf covers (and ISBNs) from an authoritative StoryGraph/Goodreads-style CSV.
 * Prefers Open Library / Google Books covers for the exact ISBN in the CSV over fuzzy title search.
 *
 * Usage:
 *   node scripts/restore-covers-from-csv.mjs [path/to/export.csv]
 */
import { readFile, writeFile, mkdir, access, unlink } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { parse } from 'csv-parse';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const csvPath =
  process.argv[2] ||
  path.join(
    process.env.HOME || '',
    'Downloads/ab3fa717133180bd8a861b0e9bfaf78023eb23c30419db3ff86c724993e2f33f.csv'
  );
const booksDir = path.join(root, 'src/content/bookshelf');
const coverDir = path.join(root, 'public/covers/bookshelf');

await mkdir(coverDir, { recursive: true });

function cleanIsbn(raw) {
  if (!raw) return '';
  return String(raw).replace(/[^\dXx]/g, '').toUpperCase();
}

function isbn10To13(isbn10) {
  const s = cleanIsbn(isbn10);
  if (s.length !== 10) return null;
  const core = '978' + s.slice(0, 9);
  const sum = [...core].reduce((acc, d, i) => acc + Number(d) * (i % 2 === 0 ? 1 : 3), 0);
  const check = (10 - (sum % 10)) % 10;
  return core + String(check);
}

function toIsbn13(isbn) {
  const s = cleanIsbn(isbn);
  if (s.length === 13) return s;
  if (s.length === 10) return isbn10To13(s);
  return null;
}

function sameIsbn(a, b) {
  const a13 = toIsbn13(a);
  const b13 = toIsbn13(b);
  if (a13 && b13 && a13 === b13) return true;
  return cleanIsbn(a) === cleanIsbn(b);
}

function isValidIsbn(isbn) {
  const s = cleanIsbn(isbn);
  if (s.length === 10) return /^\d{9}[\dX]$/.test(s);
  if (s.length === 13) return /^97[89]\d{10}$/.test(s);
  return false;
}

function titleKey(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\(.*?\)/g, '')
    .replace(/:.*$/, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\b(the|a|an)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function titlesMatch(a, b) {
  const q = titleKey(a);
  const c = titleKey(b);
  if (!q || !c) return false;
  return q === c || q.startsWith(c) || c.startsWith(q);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fileExists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function saveCoverFromUrl(url, dest) {
  const res = await fetch(url, {
    redirect: 'follow',
    headers: { 'User-Agent': 'bookshelf-cover-restore/1.0' },
  });
  if (!res.ok) return false;
  const type = res.headers.get('content-type') || '';
  if (!type.includes('image')) return false;
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 1500) return false;
  await writeFile(dest, buf);
  return true;
}

async function coverFromGoogleBooks(isbn) {
  try {
    const url = `https://www.googleapis.com/books/v1/volumes?q=isbn:${isbn}&maxResults=1`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const json = await res.json();
    const info = json.items?.[0]?.volumeInfo?.imageLinks;
    if (!info) return null;
    const raw = info.extraLarge || info.large || info.medium || info.thumbnail || info.smallThumbnail;
    if (!raw) return null;
    return raw.replace('http://', 'https://').replace('&edge=curl', '').replace('zoom=1', 'zoom=2');
  } catch {
    return null;
  }
}

async function coverFromOpenLibrarySearch(title, author) {
  const clean = String(title || '')
    .replace(/\(.*?\)/g, '')
    .split(':')[0]
    .trim();
  if (!clean) return null;
  const authorLast = String(author || '')
    .split(',')[0]
    .trim()
    .split(/\s+/)
    .pop()
    ?.toLowerCase()
    .replace(/[^a-z]/g, '');
  const params = new URLSearchParams({ title: clean, limit: '10' });
  if (author) params.set('author', String(author).split(',')[0].trim());
  try {
    const search = await fetch(`https://openlibrary.org/search.json?${params}`);
    if (!search.ok) return null;
    const json = await search.json();
    const docs = json.docs || [];
    const authorOk = (d) => {
      if (!authorLast) return true;
      return (d.author_name || []).join(' ').toLowerCase().includes(authorLast);
    };
    const pick =
      docs.find((d) => d.cover_i && authorOk(d) && titlesMatch(clean, d.title)) ||
      docs.find((d) => d.cover_i && authorOk(d));
    if (!pick?.cover_i) return null;
    return `https://covers.openlibrary.org/b/id/${pick.cover_i}-L.jpg`;
  } catch {
    return null;
  }
}

/** Force-download cover for an ISBN; overwrite existing file. */
async function downloadCoverForIsbn(isbn, dest, title, author) {
  const urls = [];
  if (isbn && isValidIsbn(isbn)) {
    urls.push(
      `https://covers.openlibrary.org/b/isbn/${isbn}-L.jpg?default=false`,
      `https://covers.openlibrary.org/b/isbn/${isbn}-M.jpg?default=false`
    );
    const as13 = toIsbn13(isbn);
    if (as13 && as13 !== isbn) {
      urls.push(
        `https://covers.openlibrary.org/b/isbn/${as13}-L.jpg?default=false`,
        `https://covers.openlibrary.org/b/isbn/${as13}-M.jpg?default=false`
      );
    }
  }

  for (const url of urls) {
    try {
      if (await saveCoverFromUrl(url, dest)) return { ok: true, source: 'openlibrary-isbn' };
    } catch {
      // next
    }
  }

  if (isbn && isValidIsbn(isbn)) {
    const gb = await coverFromGoogleBooks(isbn);
    if (gb) {
      try {
        if (await saveCoverFromUrl(gb, dest)) return { ok: true, source: 'google-isbn' };
      } catch {
        // fall through
      }
    }
  }

  const searchUrl = await coverFromOpenLibrarySearch(title, author);
  if (searchUrl) {
    try {
      if (await saveCoverFromUrl(searchUrl, dest)) return { ok: true, source: 'openlibrary-search' };
    } catch {
      // give up
    }
  }
  return { ok: false, source: null };
}

function parseFrontmatter(text) {
  if (!text.startsWith('---\n') && !text.startsWith('---\r\n')) return null;
  const end = text.indexOf('\n---', 3);
  if (end < 0) return null;
  return {
    block: text.slice(4, end),
    body: text.slice(end + 4),
    full: text,
  };
}

function getFmField(block, key) {
  const re = new RegExp(`^${key}:\\s*(.*)$`, 'm');
  const m = block.match(re);
  if (!m) return null;
  return m[1].trim().replace(/^["']|["']$/g, '');
}

function setFmField(block, key, value) {
  const re = new RegExp(`^${key}:\\s*.*$`, 'm');
  const line = `${key}: ${value}`;
  if (re.test(block)) return block.replace(re, line);
  // insert after author if present, else at end
  if (/^author:/m.test(block)) {
    return block.replace(/^(author:\s*.*)$/m, `$1\n${line}`);
  }
  return `${block.trimEnd()}\n${line}\n`;
}

function removeFmField(block, key) {
  return block.replace(new RegExp(`^${key}:\\s*.*\\n?`, 'm'), '');
}

function yamlEscape(s) {
  return `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

// Load CSV
const rows = [];
await new Promise((resolve, reject) => {
  createReadStream(csvPath)
    .pipe(parse({ columns: true, relax_quotes: true, relax_column_count: true }))
    .on('data', (row) => rows.push(row))
    .on('error', reject)
    .on('end', resolve);
});

const csvByTitle = new Map();
for (const r of rows) {
  const isbn = cleanIsbn(r['ISBN/UID']);
  const title = String(r.Title || '').trim();
  if (!title) continue;
  const key = titleKey(title);
  const entry = {
    title,
    authors: String(r.Authors || ''),
    isbn: isValidIsbn(isbn) ? isbn : null,
  };
  if (!csvByTitle.has(key)) csvByTitle.set(key, []);
  csvByTitle.get(key).push(entry);
}

function findCsv(title, author) {
  const key = titleKey(title);
  let cands = csvByTitle.get(key);
  if (!cands) {
    const short = titleKey(String(title || '').split(':')[0]);
    cands = csvByTitle.get(short);
  }
  if (!cands) {
    for (const [k, v] of csvByTitle) {
      if (key && (key.startsWith(k) || k.startsWith(key)) && Math.min(key.length, k.length) > 10) {
        cands = v;
        break;
      }
    }
  }
  if (!cands?.length) return null;
  if (cands.length === 1) return cands[0];
  const authorL = String(author || '').toLowerCase();
  for (const c of cands) {
    if (authorL && authorL.split(/\s+/).some((p) => p.length > 2 && c.authors.toLowerCase().includes(p))) {
      return c;
    }
  }
  return cands[0];
}

const { readdir } = await import('node:fs/promises');
const files = (await readdir(booksDir)).filter((f) => f.endsWith('.md')).sort();

let updatedIsbn = 0;
let replacedCovers = 0;
let keptCovers = 0;
let failed = 0;
const report = [];

console.log(`CSV: ${rows.length} rows; bookshelf: ${files.length} books`);
console.log(`Restoring covers preferring exact CSV ISBNs…\n`);

for (const file of files) {
  const fp = path.join(booksDir, file);
  const text = await readFile(fp, 'utf8');
  const parsed = parseFrontmatter(text);
  if (!parsed) continue;

  let block = parsed.block;
  const title = getFmField(block, 'title');
  const author = getFmField(block, 'author');
  const mdIsbn = cleanIsbn(getFmField(block, 'isbn'));
  const cover = getFmField(block, 'cover');
  const slug = path.basename(file, '.md');

  const csv = findCsv(title, author);
  if (!csv?.isbn) {
    continue;
  }

  const targetIsbn = csv.isbn;
  const isbnChanged = !mdIsbn || !sameIsbn(mdIsbn, targetIsbn);
  // Only rewrite covers when the preferred edition ISBN differs or was missing
  // (StoryGraph title-search backfill often filled those with the wrong edition).
  if (!isbnChanged) continue;

  block = setFmField(block, 'isbn', yamlEscape(targetIsbn));
  updatedIsbn += 1;

  const dest = cover?.startsWith('/covers/bookshelf/')
    ? path.join(root, 'public', cover)
    : path.join(coverDir, `${slug}.jpg`);

  process.stdout.write(`${slug.slice(0, 52).padEnd(52)} ${targetIsbn} `);

  // Write to temp then replace so a failed download doesn't wipe a good cover
  const tmp = dest + '.tmp';
  const result = await downloadCoverForIsbn(targetIsbn, tmp, title, author);
  if (result.ok) {
    // replace
    try {
      if (await fileExists(dest)) await unlink(dest);
    } catch {
      // ignore
    }
    const { rename } = await import('node:fs/promises');
    await rename(tmp, dest);
    const coverPath = `/covers/bookshelf/${path.basename(dest)}`;
    block = setFmField(block, 'cover', coverPath);
    // drop stale dominant color so enrich can recompute later
    block = removeFmField(block, 'coverColor');
    replacedCovers += 1;
    console.log(`✓ ${result.source}`);
    report.push({ file, title, isbn: targetIsbn, source: result.source, isbnChanged });
  } else {
    try {
      if (await fileExists(tmp)) await unlink(tmp);
    } catch {
      // ignore
    }
    failed += 1;
    keptCovers += 1;
    console.log('✗ keep existing');
    report.push({ file, title, isbn: targetIsbn, source: 'failed', isbnChanged });
  }

  if (block !== parsed.block) {
    await writeFile(fp, `---\n${block.trimEnd()}\n---${parsed.body.startsWith('\n') ? '' : '\n'}${parsed.body}`);
  }

  await sleep(120);
}

console.log(`\nDone.`);
console.log(`  ISBNs updated:     ${updatedIsbn}`);
console.log(`  Covers replaced:   ${replacedCovers}`);
console.log(`  Covers kept (fail): ${keptCovers}`);
console.log(`  Download failures: ${failed}`);
