# Adding content

How to add essays, bookshelf entries, featured reviews, and keep stats up to date.

There is no “add book” UI on the live site. Content is markdown in the repo; push to `main` and GitHub Actions rebuilds [brian-muen.github.io](https://brian-muen.github.io).

---

## Quick map

| What | Folder | Shows up where |
|------|--------|----------------|
| Essay | `src/content/writing/` | Writing page |
| Old / archived essay | `src/content/writing/archive/` | Writing page (hidden “Archive” easter egg) |
| Finished book (shelf + stats) | `src/content/bookshelf/` | Spines, book pages, `/reading/stats` |
| Featured review (under the shelf) | `src/content/reading/` | Reading page, below the bookshelf |
| Cover image | `public/covers/bookshelf/` | Book pages / atlas (path must be `/covers/bookshelf/…`) |

Stats do **not** need a separate update. They rebuild from `src/content/bookshelf/` on every deploy.

---

## Essays

Create `src/content/writing/my-slug.md`:

```markdown
---
title: My Essay Title
date: 2026-07-07
description: Optional one-line summary.
---

Essay text in markdown…
```

- Filename → URL: `why-i-write.md` → `/writing/why-i-write`
- Put older posts in `src/content/writing/archive/` if you don’t want them in the main list (Archive is intentionally hard to see)

---

## Bookshelf (finished books)

These power the virtual shelf, individual book pages, and all reading stats.

### Option A — Import from a list (usual path)

1. Mark the book read in Goodreads (or Storygraph).
2. Export:
   - Goodreads: My Books → Import/Export → export CSV
   - Storygraph: scrape / JSON into something like `.tmp-wp/storygraph-books.json`
3. Import (skips books that already exist):

```bash
export PATH="$HOME/.local/node/bin:$PATH"

# Goodreads
npm run import:goodreads -- ~/Downloads/goodreads_library_export.csv

# or Storygraph
npm run import:storygraph -- .tmp-wp/storygraph-books.json
```

4. Enrich genres, moods, subjects, cover colors (Hardcover token optional but best):

```bash
export HARDCOVER_API_TOKEN='your-token'   # hardcover.app → Account → API
npm run enrich:bookshelf
```

Use `--force` only when you want to refresh tags that already exist.

5. Commit + push `main` → site deploys. Spines and stats update automatically.

### Option B — Add one book by hand

1. Drop a cover at `public/covers/bookshelf/my-book.jpg` (optional).
2. Create `src/content/bookshelf/my-book-slug.md`:

```markdown
---
title: "Dance Dance Dance (The Rat, #4)"
author: "Haruki Murakami"
dateRead: 2021-03-15
rating: 4
pages: 393
pubYear: 1988
cover: "/covers/bookshelf/my-book.jpg"
fiction: true
genres: ["Fiction", "Literary Fiction"]
---

Optional review body in markdown…
```

Useful frontmatter fields: `dateRead` (required), `rating`, `pages`, `pubYear`, `dateAdded`, `isbn`, `cover`, `coverColor` (`#rrggbb`), `fiction`, `genres`, `moods`, `subjects`, `places`.

### Series arcs (Constellation page)

Series grouping is parsed from the **title**, not a separate field:

```text
Book Name (Series Name, #N)
```

Examples that work:

- `Steelheart (Reckoners, #1)`
- `Calamity (The Reckoners, #3)` — leading “The” is normalized away
- `The Lady in the Lake (Philip Marlowe, #4)`
- `Dance Dance Dance (The Rat, #4)`

If the export omits `(Series, #N)`, the book still appears on the shelf and in stats, but **not** in that series track until you fix the title.

---

## Featured reviews (under the bookshelf)

Separate from the spine archive. Files in `src/content/reading/` show as cover + writeup **below** the shelf on `/reading`.

```markdown
---
title: Dune
author: Frank Herbert
cover: /covers/bookshelf/dune.jpg
dateRead: 2026-05-10
---

Your thoughts on the book…
```

Cover paths must match the schema: `/covers/bookshelf/…` (not `/covers/…` alone).

Importing Goodreads/Storygraph does **not** create these. Add them only when you want a featured writeup.

---

## After you add content

```bash
npm run build    # optional local check
git add -A
git commit -m "Add …"
git push origin main
```

GitHub Actions builds and deploys. Reading stats live at `/reading/stats` (also via the *How to Lie* spine easter egg on the Reading page).

---

## Common gotchas

- **Stats look stale** — you didn’t push, or the Actions deploy hasn’t finished.
- **Book missing from a series** — title lacks `(Series, #N)` or uses a different series string than siblings.
- **Genre counts disagree across pages** — Galaxy uses the *first* genre as the cluster; other charts count every tag on a book. Tags mostly come from Hardcover (with Storygraph / Google Books / Open Library fallbacks).
- **Featured list empty** — `src/content/reading/` has no reviews yet; bookshelf imports don’t fill it.
- **Cover rejected** — must live under `public/covers/bookshelf/` and be referenced as `/covers/bookshelf/filename.ext`.
