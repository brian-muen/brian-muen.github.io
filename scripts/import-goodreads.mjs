#!/usr/bin/env node
/**
 * Import Goodreads library export CSV into src/content/bookshelf/
 * and download covers from Open Library into public/covers/bookshelf/.
 *
 * Goodreads exports have no cover URLs. Covers are fetched by ISBN from
 * Open Library, with a title/author search fallback when the ISBN edition
 * has no cover (common for Kindle/export ISBNs).
 *
 * Usage:
 *   node scripts/import-goodreads.mjs [path/to/goodreads_library_export.csv]
 */
import { createReadStream } from 'node:fs';
import { mkdir, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'csv-parse';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const csvPath = process.argv[2] || path.join(process.env.HOME || '', 'Downloads/goodreads_library_export.csv');
const outDir = path.join(root, 'src/content/bookshelf');
const coverDir = path.join(root, 'public/covers/bookshelf');

await mkdir(outDir, { recursive: true });
await mkdir(coverDir, { recursive: true });

function cleanIsbn(raw) {
  if (!raw) return '';
  // Goodreads wraps as ="978..."
  return String(raw).replace(/[^\dXx]/g, '');
}

function slugify(title, bookId) {
  const base = title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
  return `${base || 'book'}-${bookId}`;
}

function yamlEscape(s) {
  return `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function parseDate(raw) {
  // Goodreads: YYYY/MM/DD
  if (!raw || !String(raw).trim()) return null;
  const m = String(raw).trim().match(/^(\d{4})\/(\d{2})\/(\d{2})$/);
  if (!m) return null;
  return `${m[1]}-${m[2]}-${m[3]}`;
}

function htmlToMarkdown(html) {
  if (!html) return '';
  let s = html;
  s = s.replace(/\r\n/g, '\n');
  // Goodreads often emits "<br/>\t<p>..." — tabs/spaces after a newline become
  // Markdown indented code blocks, which swallow **bold** and look truncated.
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<\/p>/gi, '\n\n');
  s = s.replace(/<p[^>]*>/gi, '');
  s = s.replace(/<b>([\s\S]*?)<\/b>/gi, '**$1**');
  s = s.replace(/<strong>([\s\S]*?)<\/strong>/gi, '**$1**');
  s = s.replace(/<i>([\s\S]*?)<\/i>/gi, '*$1*');
  s = s.replace(/<em>([\s\S]*?)<\/em>/gi, '*$1*');
  s = s.replace(/<a[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, href, text) => {
    const h = String(href || '').trim();
    // Allow http(s) and relative paths only — drop javascript:/data:/etc.
    if (!/^(https?:\/\/|\/)[^<\s]*$/i.test(h) || /^\/\//.test(h)) {
      return String(text || '');
    }
    return `[${text}](${h})`;
  });
  s = s.replace(/<[^>]+>/g, '');
  s = s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&mdash;/g, '—')
    .replace(/&ndash;/g, '–')
    .replace(/&hellip;/g, '…');
  // Strip leftover leading indentation so paragraphs stay prose, not code fences.
  s = s
    .split('\n')
    .map((line) => line.replace(/^[ \t]+/, ''))
    .join('\n');
  s = s.replace(/\n{3,}/g, '\n\n').trim();
  return s;
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
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) return false;
  const type = res.headers.get('content-type') || '';
  if (!type.includes('image')) return false;
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 1000) return false; // tiny = missing placeholder
  await writeFile(dest, buf);
  return true;
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

function titlesMatch(query, candidate) {
  const q = titleKey(query);
  const c = titleKey(candidate);
  if (!q || !c) return false;
  return q === c || q.startsWith(c) || c.startsWith(q);
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
      const names = (d.author_name || []).join(' ').toLowerCase();
      return names.includes(authorLast);
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

/**
 * Goodreads CSV has no cover URLs. Prefer Open Library by ISBN; many editions
 * 404 there, so fall back to a title/author search for cover_i.
 */
async function downloadCover(isbn, slug, title, author) {
  const dest = path.join(coverDir, `${slug}.jpg`);
  if (await fileExists(dest)) return `/covers/bookshelf/${slug}.jpg`;

  const urls = [];
  if (isbn && isbn.length >= 10) {
    urls.push(
      `https://covers.openlibrary.org/b/isbn/${isbn}-L.jpg?default=false`,
      `https://covers.openlibrary.org/b/isbn/${isbn}-M.jpg?default=false`,
    );
  }

  for (const url of urls) {
    try {
      if (await saveCoverFromUrl(url, dest)) return `/covers/bookshelf/${slug}.jpg`;
    } catch {
      // try next
    }
  }

  const searchUrl = await coverFromOpenLibrarySearch(title, author);
  if (searchUrl) {
    try {
      if (await saveCoverFromUrl(searchUrl, dest)) return `/covers/bookshelf/${slug}.jpg`;
    } catch {
      // give up
    }
  }
  return null;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

const rows = [];
await new Promise((resolve, reject) => {
  createReadStream(csvPath)
    .pipe(parse({ columns: true, relax_quotes: true, relax_column_count: true }))
    .on('data', (row) => rows.push(row))
    .on('error', reject)
    .on('end', resolve);
});

const withDate = rows.filter((r) => parseDate(r['Date Read']));
console.log(`CSV rows: ${rows.length}; with Date Read: ${withDate.length}`);

let written = 0;
let covers = 0;

for (const row of withDate) {
  const title = (row.Title || '').trim();
  const author = (row.Author || '').trim();
  const bookId = (row['Book Id'] || '').trim();
  const dateRead = parseDate(row['Date Read']);
  const dateAdded = parseDate(row['Date Added']);
  const isbn = cleanIsbn(row.ISBN13) || cleanIsbn(row.ISBN);
  const rating = Number(row['My Rating'] || 0) || 0;
  const pages = Number(row['Number of Pages'] || 0) || undefined;
  const pubYear =
    Number(row['Original Publication Year'] || 0) ||
    Number(row['Year Published'] || 0) ||
    undefined;
  const readCount = Number(row['Read Count'] || 1) || 1;
  const review = htmlToMarkdown(row['My Review'] || '');
  const slug = slugify(title, bookId);

  process.stdout.write(`  ${slug}... `);
  const cover = await downloadCover(isbn, slug, title, author);
  if (cover) covers += 1;
  console.log(cover ? 'cover' : 'no cover');

  const lines = [
    '---',
    `title: ${yamlEscape(title)}`,
    `author: ${yamlEscape(author)}`,
    `dateRead: ${dateRead}`,
  ];
  if (rating > 0) lines.push(`rating: ${rating}`);
  if (pages) lines.push(`pages: ${pages}`);
  if (pubYear) lines.push(`pubYear: ${pubYear}`);
  if (dateAdded) lines.push(`dateAdded: ${dateAdded}`);
  if (readCount) lines.push(`readCount: ${readCount}`);
  if (cover) lines.push(`cover: ${cover}`);
  if (isbn) lines.push(`isbn: ${yamlEscape(isbn)}`);
  lines.push('---', '');
  if (review) {
    lines.push(review, '');
  }

  await writeFile(path.join(outDir, `${slug}.md`), lines.join('\n'));
  written += 1;
  await sleep(120); // be polite to Open Library
}

console.log(`\nWrote ${written} books; downloaded ${covers} covers.`);
