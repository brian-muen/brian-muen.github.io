#!/usr/bin/env node
/**
 * Overwrite bookshelf covers with the editions from a StoryGraph scrape JSON
 * (cdn.thestorygraph.com URLs from the books-read page).
 *
 * Usage:
 *   node scripts/restore-covers-from-storygraph.mjs [path/to/storygraph-books.json]
 */
import { readFile, readdir, writeFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const jsonPath = process.argv[2] || path.join(root, '.tmp-wp/storygraph-books.json');
const booksDir = path.join(root, 'src/content/bookshelf');
const coverDir = path.join(root, 'public/covers/bookshelf');

const numberWords = {
  one: '1', two: '2', three: '3', four: '4', five: '5',
  six: '6', seven: '7', eight: '8', nine: '9', ten: '10',
};

function normalize(title) {
  return String(title || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/favourite/g, 'favorite')
    .replace(/\(.*?\)/g, '')
    .replace(/:.*$/, '')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\b(the|a|an)\b/g, ' ')
    .replace(/\b(one|two|three|four|five|six|seven|eight|nine|ten)\b/g, (w) => numberWords[w])
    .replace(/\s+/g, ' ')
    .trim();
}

function titlesMatch(a, b) {
  if (!a || !b) return false;
  return a === b || a.startsWith(b) || b.startsWith(a) || a.includes(b) || b.includes(a);
}

function getFmField(block, key) {
  const m = block.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'));
  if (!m) return null;
  return m[1].trim().replace(/^["']|["']$/g, '');
}

function setFmField(block, key, value) {
  const line = `${key}: ${value}`;
  if (new RegExp(`^${key}:`, 'm').test(block)) {
    return block.replace(new RegExp(`^${key}:.*$`, 'm'), line);
  }
  return block.replace(/\n---\s*$/, `\n${line}\n---`);
}

function removeFmField(block, key) {
  return block.replace(new RegExp(`^${key}:.*\n`, 'm'), '');
}

function splitFrontmatter(src) {
  const m = src.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return null;
  return { block: m[1], body: m[2] };
}

async function download(url, dest) {
  const res = await fetch(url, {
    redirect: 'follow',
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; bookshelf-cover-restore/1.0)',
      Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
      Referer: 'https://app.thestorygraph.com/',
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 1000) throw new Error(`too small (${buf.length}b)`);
  const tmp = `${dest}.tmp`;
  await writeFile(tmp, buf);
  await rename(tmp, dest);
  return buf.length;
}

const scraped = JSON.parse(await readFile(jsonPath, 'utf8'));
const byNorm = new Map();
for (const b of scraped) {
  const key = normalize(b.title);
  if (!key || !b.cover) continue;
  // Prefer first occurrence (scrape order); keep list for fuzzy fallback
  if (!byNorm.has(key)) byNorm.set(key, []);
  byNorm.get(key).push(b);
}

function findStorygraph(title) {
  const key = normalize(title);
  if (byNorm.has(key)) return byNorm.get(key)[0];
  for (const [k, list] of byNorm) {
    if (titlesMatch(key, k)) return list[0];
  }
  return null;
}

const files = (await readdir(booksDir)).filter((f) => f.endsWith('.md')).sort();
let ok = 0;
let miss = 0;
let fail = 0;
const missing = [];

console.log(`Restoring ${files.length} covers from StoryGraph scrape (${scraped.length} entries)…\n`);

for (const file of files) {
  const full = path.join(booksDir, file);
  const src = await readFile(full, 'utf8');
  const parts = splitFrontmatter(src);
  if (!parts) {
    console.log(`skip ${file} (no frontmatter)`);
    continue;
  }
  let { block, body } = parts;
  const title = getFmField(block, 'title');
  const cover = getFmField(block, 'cover');
  const sg = findStorygraph(title);
  if (!sg?.cover) {
    miss += 1;
    missing.push(title || file);
    console.log(`MISS  ${title}`);
    continue;
  }

  const dest = cover?.startsWith('/covers/bookshelf/')
    ? path.join(root, 'public', cover)
    : path.join(coverDir, `${file.replace(/\.md$/, '')}.jpg`);

  try {
    const bytes = await download(sg.cover, dest);
    const coverPath = `/covers/bookshelf/${path.basename(dest)}`;
    block = setFmField(block, 'cover', coverPath);
    block = removeFmField(block, 'coverColor');
    await writeFile(full, `---\n${block}\n---\n${body}`);
    ok += 1;
    console.log(`OK    ${title}  (${(bytes / 1024).toFixed(0)}kb)`);
  } catch (e) {
    fail += 1;
    console.log(`FAIL  ${title}  ${e.message}`);
    try {
      await unlink(`${dest}.tmp`);
    } catch {
      /* ignore */
    }
  }
}

console.log(`\nDone: ${ok} restored, ${miss} unmatched, ${fail} failed.`);
if (missing.length) {
  console.log('Unmatched titles:');
  for (const t of missing) console.log(`  - ${t}`);
}
