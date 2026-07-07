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

## Adding a book

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

`cover` and `dateRead` are optional — without a cover, a plain placeholder box
is shown. Books are sorted by `dateRead`, newest first.

## Editing the pages

- Home page: `src/pages/index.astro`
- Writing list: `src/pages/writing/index.astro`, essay layout: `src/pages/writing/[slug].astro`
- Reading page: `src/pages/reading.astro`
- Styles: `src/styles/global.css`
- Sidebar / shared layout: `src/layouts/Layout.astro`
