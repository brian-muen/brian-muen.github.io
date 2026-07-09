#!/usr/bin/env node
/**
 * Import books scraped from a Storygraph books-read page into
 * src/content/bookshelf/, skipping books that already exist (matched by
 * normalized title). Storygraph's public profile only exposes the year a
 * book was finished, so imported books get a synthetic date within that
 * year (preserving reading order) and are marked `approx: true`.
 *
 * Input JSON: [{ year, rank, id, title, author, pages, pub, cover, rating }]
 *
 * Usage:
 *   node scripts/import-storygraph.mjs [path/to/storygraph-books.json]
 */
import { readFile, readdir, writeFile, mkdir, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const jsonPath = process.argv[2] || path.join(root, '.tmp-wp/storygraph-books.json');
const outDir = path.join(root, 'src/content/bookshelf');
const coverDir = path.join(root, 'public/covers/bookshelf');

await mkdir(outDir, { recursive: true });
await mkdir(coverDir, { recursive: true });

const numberWords = {
  one: '1', two: '2', three: '3', four: '4', five: '5',
  six: '6', seven: '7', eight: '8', nine: '9', ten: '10',
};

function normalize(title) {
  return title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/favourite/g, 'favorite')
    .replace(/\(.*?\)/g, '')
    .replace(/:.*$/, '') // subtitles differ between sites
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\b(the|a|an)\b/g, ' ')
    .replace(/\b(one|two|three|four|five|six|seven|eight|nine|ten)\b/g, (w) => numberWords[w])
    .replace(/\s+/g, ' ')
    .trim();
}

// Titles match if either normalized form starts with the other
// (covers subtitle and edition-name differences).
function matches(a, b) {
  if (!a || !b) return false;
  return a === b || a.startsWith(b) || b.startsWith(a) || a.includes(b) || b.includes(a);
}

function slugify(title, id) {
  const base = title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
  return `${base || 'book'}-sg-${id.slice(0, 8)}`;
}

function yamlEscape(s) {
  return `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

async function fileExists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function downloadCover(url, slug) {
  if (!url) return null;
  const dest = path.join(coverDir, `${slug}.jpg`);
  if (await fileExists(dest)) return `/covers/bookshelf/${slug}.jpg`;
  try {
    const res = await fetch(url, { redirect: 'follow' });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 1000) return null;
    await writeFile(dest, buf);
    return `/covers/bookshelf/${slug}.jpg`;
  } catch {
    return null;
  }
}

// Collect normalized titles of everything already on the shelf
const existing = [];
for (const file of await readdir(outDir)) {
  if (!file.endsWith('.md')) continue;
  const src = await readFile(path.join(outDir, file), 'utf8');
  const m = src.match(/^title:\s*"?(.+?)"?\s*$/m);
  if (m) existing.push(normalize(m[1].replace(/\\"/g, '"')));
}
console.log(`Existing shelf: ${existing.length} books`);

const scraped = JSON.parse(await readFile(jsonPath, 'utf8'));

// Books within a year are ordered latest-read-first (rank 0 = most recent).
// Spread synthetic dates across the year to preserve that order.
const now = new Date();
const byYear = new Map();
for (const b of scraped) {
  if (!byYear.has(b.year)) byYear.set(b.year, []);
  byYear.get(b.year).push(b);
}

let written = 0;
let skipped = 0;
const importedTitles = [];

for (const [year, items] of byYear) {
  items.sort((a, b) => a.rank - b.rank);
  const monthMax = year === now.getFullYear() ? now.getMonth() + 1 : 12;
  const n = items.length;
  for (let i = 0; i < n; i++) {
    const b = items[i];
    const norm = normalize(b.title);
    if (existing.some((e) => matches(e, norm)) || importedTitles.some((e) => matches(e, norm))) {
      skipped += 1;
      continue;
    }
    const month = Math.max(1, monthMax - Math.round((i * (monthMax - 1)) / Math.max(1, n - 1)));
    const dateRead = `${year}-${String(month).padStart(2, '0')}-15`;
    const slug = slugify(b.title, b.id);

    process.stdout.write(`  + ${b.title} (${year}) ... `);
    const cover = await downloadCover(b.cover, slug);
    console.log(cover ? 'cover' : 'no cover');

    const lines = [
      '---',
      `title: ${yamlEscape(b.title)}`,
      `author: ${yamlEscape(b.author || 'Unknown')}`,
      `dateRead: ${dateRead}`,
      'approx: true',
    ];
    if (b.rating) lines.push(`rating: ${b.rating}`);
    if (b.pages) lines.push(`pages: ${b.pages}`);
    if (b.pub) lines.push(`pubYear: ${b.pub}`);
    if (cover) lines.push(`cover: ${cover}`);
    lines.push('---', '');

    await writeFile(path.join(outDir, `${slug}.md`), lines.join('\n'));
    importedTitles.push(norm);
    written += 1;
  }
}

console.log(`\nImported ${written} new books; skipped ${skipped} already on the shelf.`);
