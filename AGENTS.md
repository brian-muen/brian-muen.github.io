# AGENTS.md

## Cursor Cloud specific instructions

This repo is a single **Astro v5 static site** (personal website with a `writing` blog and a `reading`/bookshelf feature). There is no backend, database, or auth — all content is markdown under `src/content/` rendered to static HTML. It deploys to GitHub Pages via `.github/workflows/deploy.yml` (`withastro/action`).

### Commands (see `package.json` scripts and `documentation/setup.md`)
- Dev server: `npm run dev` → serves at `http://localhost:4321/`.
- Build: `npm run build` → static output in `dist/`. This is also the effective type-check: `.astro` pages and the content-collection schema (`src/content.config.ts`) are validated during build.
- Preview built output: `npm run preview`.
- There is **no separate lint or test script** and no `@astrojs/check` installed; `npm run build` is the closest to a full check.

### Non-obvious notes
- During `npm run build` you will see `The collection "reading" does not exist or is empty.` This is **expected** — `src/content/reading/` (featured reviews) is optional and empty by default; the build still completes and exits 0. Do not treat it as a failure.
- The `import:*`, `enrich:bookshelf`, `restore:covers:*`, and `recolor:covers` scripts in `package.json` are one-off content tooling; some require external data files or a `HARDCOVER_API_TOKEN` and are not part of normal dev/build. See `documentation/adding-content.md`.
- Content lives in `src/content/{bookshelf,writing,reading}/` as markdown; reading stats at `/reading/stats` are computed at build time from `src/content/bookshelf/`.
- `documentation/setup.md` mentions a local Node at `~/.local/node`; on Cloud VMs Node 22 is already on `PATH`, so that step is not needed.
