#!/usr/bin/env node
/**
 * Re-extract coverColor for every bookshelf entry using the improved
 * extractor in enrich-bookshelf.mjs (PNG-aware, prefers field color over ink).
 *
 * Usage: node scripts/recolor-covers.mjs
 */
import { readFile, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const outDir = path.join(root, 'src/content/bookshelf');

// Import helpers by evaluating the enrich module's coverColorFor via dynamic
// re-export: we duplicate the minimal frontmatter helpers here and import
 // extract via spawning would be heavy — instead import the enrich file's
 // functions by temporarily patching. Simpler: duplicate call by importing
 // after making coverColorFor exportable.
const enrichUrl = pathToFileURL(path.join(__dirname, 'enrich-bookshelf.mjs')).href;

// enrich-bookshelf.mjs runs on import (side effects). To avoid that, we
 // inline a thin runner that only uses the shared extract by reading the
 // file as a library. Prefer: extract the color functions into a shared
 // module. For now, call coverColorFor by re-implementing a tiny driver
 // that imports jpeg + copies the extract — actually the cleanest path is
 // to export coverColorFor from enrich. Let's do that with a guard.
process.env.ENRICH_AS_LIB = '1';

const { coverColorFor, parseFrontmatter, serializeFrontmatter } = await import(enrichUrl);

const files = (await readdir(outDir)).filter((f) => f.endsWith('.md')).sort();
let updated = 0;
let failed = 0;
let unchanged = 0;

for (const file of files) {
  const fp = path.join(outDir, file);
  const src = await readFile(fp, 'utf8');
  const { data, body } = parseFrontmatter(src);
  if (!data.cover) {
    failed += 1;
    console.log(`  ${file}: no cover`);
    continue;
  }
  const nextColor = await coverColorFor(data.cover);
  if (!nextColor) {
    failed += 1;
    console.log(`  ${file}: extract failed (was ${data.coverColor || 'none'})`);
    continue;
  }
  if (data.coverColor === nextColor) {
    unchanged += 1;
    continue;
  }
  const prev = data.coverColor || 'none';
  data.coverColor = nextColor;
  await writeFile(fp, serializeFrontmatter(data, body));
  updated += 1;
  console.log(`  ${file}: ${prev} → ${nextColor}`);
}

console.log(`\nUpdated ${updated}; unchanged ${unchanged}; failed ${failed}.`);
