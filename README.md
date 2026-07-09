# Personal site

Minimal [Astro](https://astro.build) site with three pages: Home, Writing, and Reading.

## Running it

```bash
npm install
npm run dev      # local dev server at http://localhost:4321
npm run build    # static site output in dist/
```

Note: Node.js was installed locally at `~/.local/node`. If `node`/`npm` aren't found
in a new terminal, add it to your PATH:

```bash
export PATH="$HOME/.local/node/bin:$PATH"
```

(Add that line to `~/.zshrc` to make it permanent.)

## Adding an essay

Create a new `.md` file in `src/content/writing/`:

```markdown
---
title: My Essay Title
date: 2026-07-07
description: Optional one-line summary.
---

Essay text in markdown...
```

The filename becomes the URL: `why-i-write.md` → `/writing/why-i-write`.

Old WordPress posts go in `src/content/writing/archive/` — they appear under an
**Archive** toggle at the bottom of the Writing page, separate from newer essays.

## Adding a book review (new / featured)

1. Drop a cover image into `public/covers/` (e.g. `public/covers/dune.jpg`).
2. Create a new `.md` file in `src/content/reading/`:

```markdown
---
title: Dune
author: Frank Herbert
cover: /covers/dune.jpg
dateRead: 2026-05-10
---

Your thoughts on the book, in markdown.
```

These show at the top of the Reading page.

## Bookshelf (archive of finished books)

Finished books with a read date live in `src/content/bookshelf/` and appear as
spines on the Reading page. Click a spine for the cover, rating, and any old
Goodreads review. Stats are at `/reading/stats` (white-on-white link near the
bottom of the Reading page).

To re-import from a Goodreads export CSV:

```bash
npm run import:goodreads -- ~/Downloads/goodreads_library_export.csv
```

To pull missing books from a Storygraph scrape JSON:

```bash
npm run import:storygraph -- .tmp-wp/storygraph-books.json
```

### Enriching moods, genres, subjects, cover colors

```bash
# Optional but best: get a free token at hardcover.app → Account → API
export HARDCOVER_API_TOKEN='your-token'

npm run enrich:bookshelf -- --force ~/Downloads/your-storygraph-export.csv
```

Without a Hardcover token, enrichment still fills subjects/places (Open Library),
categories/language (Google Books), Storygraph mood seeds, inferred moods from
subjects, and dominant cover colors from local JPEGs. Re-run anytime; skip
`--force` to only fill books that are missing enrichment fields.

## Editing the pages

- Home page: `src/pages/index.astro`
- Writing list: `src/pages/writing/index.astro`, essay layout: `src/pages/writing/[...slug].astro`
- Reading page: `src/pages/reading.astro`
- Book detail: `src/pages/reading/books/[slug].astro`
- Reading stats: `src/pages/reading/stats.astro`
- Styles: `src/styles/global.css`
- Sidebar / shared layout: `src/layouts/Layout.astro`
