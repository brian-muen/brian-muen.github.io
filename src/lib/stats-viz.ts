/**
 * Build-time payload helpers for the reading-stats viz pages (galaxy, orbits,
 * rhythm). All outputs are plain JSON-serializable objects — no Dates, Maps, or
 * Sets. Coordinates are rounded to 1–2 decimals.
 *
 * Usage (in an Astro frontmatter):
 *   const books = await loadBooks();
 *   const galaxy = buildGalaxy(books);
 */
import {
  type BookRow,
  shortTitle,
  hueOf,
  countMap,
} from './bookshelf-stats';

// ─── shared utils ────────────────────────────────────────────────────────────

function round1(n: number) {
  return Math.round(n * 10) / 10;
}

function round2(n: number) {
  return Math.round(n * 100) / 100;
}

/** Deterministic PRNG (mulberry32). */
function mulberry32(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function yearOf(ms: number) {
  return new Date(ms).getUTCFullYear();
}

function dayOfYear(ms: number) {
  const d = new Date(ms);
  const start = Date.UTC(d.getUTCFullYear(), 0, 0);
  return Math.floor((Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - start) / 86400000);
}

function median(nums: number[]): number {
  if (!nums.length) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function scalePages(pages: number, minR: number, maxR: number, maxPages: number) {
  if (maxPages <= 0) return minR;
  const t = Math.min(1, Math.max(0, pages / maxPages));
  return round1(minR + t * (maxR - minR));
}

function dominantGenre(genres: string[]): string {
  return genres[0] ?? 'other';
}

function setIntersectCount(a: Set<string>, b: Set<string>) {
  let n = 0;
  for (const x of a) if (b.has(x)) n++;
  return n;
}

function firstShared(a: Set<string>, b: Set<string>): string | null {
  for (const x of a) if (b.has(x)) return x;
  return null;
}

// ─── Galaxy ──────────────────────────────────────────────────────────────────

/** A single book node in the knowledge-graph layout. */
export type GalaxyNode = {
  id: string;
  title: string;
  author: string;
  /** Canvas x in ~1200×900 space. */
  x: number;
  /** Canvas y in ~1200×900 space. */
  y: number;
  /** Radius scaled by page count (~4–14). */
  r: number;
  /** Cover hex color, or null. */
  color: string | null;
  cover: string | null;
  rating: number | null;
  /** Calendar year of dateRead. */
  year: number;
  /** Top few genre labels. */
  genres: string[];
  /** Dominant genre used for clustering. */
  cluster: string;
};

/** Link between two book nodes. `a`/`b` are book ids. */
export type GalaxyEdge = {
  a: string;
  b: string;
  /** Relative strength (higher = stronger). */
  w: number;
  /** Short human-readable reason. */
  reason: string;
};

/** Genre-cluster centroid for nebula backdrops. */
export type GalaxyCluster = {
  label: string;
  x: number;
  y: number;
  count: number;
  /** Representative hue 0–360 from member cover colors (or hash fallback). */
  hue: number;
};

export type GalaxyPayload = {
  width: number;
  height: number;
  nodes: GalaxyNode[];
  edges: GalaxyEdge[];
  clusters: GalaxyCluster[];
};

const GALAXY_W = 1200;
const GALAXY_H = 900;
const GALAXY_CX = GALAXY_W / 2;
const GALAXY_CY = GALAXY_H / 2;
const MAX_EDGES_PER_NODE = 3;
const LAYOUT_ITERS = 220;

type CandEdge = { a: string; b: string; w: number; reason: string };

/**
 * Knowledge-graph of every book: genre-clustered force layout with edges for
 * shared authors (strong) and shared subjects/genres + close finish dates (medium).
 * Layout is deterministic across builds (fixed mulberry32 seed).
 */
export function buildGalaxy(books: BookRow[]): GalaxyPayload {
  if (!books.length) {
    return { width: GALAXY_W, height: GALAXY_H, nodes: [], edges: [], clusters: [] };
  }

  const maxPages = Math.max(...books.map((b) => b.pages), 1);
  const clusterOf = new Map<string, string>();
  for (const b of books) clusterOf.set(b.id, dominantGenre(b.genres));

  // Cluster labels ordered by frequency
  const clusterCounts = countMap(books.map((b) => clusterOf.get(b.id)!));
  const clusterLabels = clusterCounts.map(([l]) => l);
  const nClusters = Math.max(clusterLabels.length, 1);
  const clusterAngle = new Map<string, number>();
  clusterLabels.forEach((label, i) => {
    clusterAngle.set(label, (i / nClusters) * Math.PI * 2 - Math.PI / 2);
  });
  const ringR = Math.min(GALAXY_W, GALAXY_H) * 0.32;
  const centroids = new Map<string, { x: number; y: number }>();
  for (const label of clusterLabels) {
    const ang = clusterAngle.get(label)!;
    centroids.set(label, {
      x: GALAXY_CX + Math.cos(ang) * ringR,
      y: GALAXY_CY + Math.sin(ang) * ringR,
    });
  }

  // Candidate edges
  const subjectSets = new Map<string, Set<string>>();
  const genreSets = new Map<string, Set<string>>();
  for (const b of books) {
    subjectSets.set(b.id, new Set(b.subjects.map((s) => s.toLowerCase())));
    genreSets.set(b.id, new Set(b.genres.map((g) => g.toLowerCase())));
  }

  const cands: CandEdge[] = [];
  for (let i = 0; i < books.length; i++) {
    for (let j = i + 1; j < books.length; j++) {
      const A = books[i];
      const B = books[j];
      if (A.author === B.author) {
        cands.push({ a: A.id, b: B.id, w: 3, reason: 'same author' });
        continue;
      }
      const sharedSub = setIntersectCount(subjectSets.get(A.id)!, subjectSets.get(B.id)!);
      if (sharedSub >= 2) {
        const label = firstShared(subjectSets.get(A.id)!, subjectSets.get(B.id)!) ?? 'subjects';
        cands.push({ a: A.id, b: B.id, w: 1.5 + Math.min(sharedSub, 4) * 0.15, reason: `subjects: ${label}` });
        continue;
      }
      const sharedGen = setIntersectCount(genreSets.get(A.id)!, genreSets.get(B.id)!);
      const dayGap = Math.abs(A.dateRead - B.dateRead) / 86400000;
      if (sharedGen >= 1 && dayGap < 60) {
        const g = firstShared(genreSets.get(A.id)!, genreSets.get(B.id)!) ?? 'genre';
        cands.push({
          a: A.id,
          b: B.id,
          w: 1 + Math.min(sharedGen, 3) * 0.2,
          reason: `${g} · ${Math.round(dayGap)}d apart`,
        });
      }
    }
  }

  // Keep strongest edges, cap degree per node
  cands.sort((a, b) => b.w - a.w);
  const degree = new Map<string, number>();
  const edges: GalaxyEdge[] = [];
  for (const e of cands) {
    const da = degree.get(e.a) ?? 0;
    const db = degree.get(e.b) ?? 0;
    if (da >= MAX_EDGES_PER_NODE || db >= MAX_EDGES_PER_NODE) continue;
    edges.push({ a: e.a, b: e.b, w: round2(e.w), reason: e.reason });
    degree.set(e.a, da + 1);
    degree.set(e.b, db + 1);
  }

  // Force layout
  const rand = mulberry32(0x67a1a5e7);
  type Sim = { id: string; x: number; y: number; vx: number; vy: number; cluster: string };
  const sims: Sim[] = books.map((b) => {
    const c = clusterOf.get(b.id)!;
    const cen = centroids.get(c) ?? { x: GALAXY_CX, y: GALAXY_CY };
    return {
      id: b.id,
      x: cen.x + (rand() - 0.5) * 80,
      y: cen.y + (rand() - 0.5) * 80,
      vx: 0,
      vy: 0,
      cluster: c,
    };
  });
  const byId = new Map(sims.map((s) => [s.id, s]));
  const edgePairs = edges.map((e) => ({ a: byId.get(e.a)!, b: byId.get(e.b)!, w: e.w }));

  const n = sims.length;
  for (let iter = 0; iter < LAYOUT_ITERS; iter++) {
    const cool = 1 - iter / LAYOUT_ITERS;

    // Repulsion (O(n²) — fine for a few hundred books)
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const A = sims[i];
        const B = sims[j];
        let dx = A.x - B.x;
        let dy = A.y - B.y;
        let dist2 = dx * dx + dy * dy;
        if (dist2 < 0.01) {
          dx = (rand() - 0.5) * 0.5;
          dy = (rand() - 0.5) * 0.5;
          dist2 = dx * dx + dy * dy;
        }
        const dist = Math.sqrt(dist2);
        const force = (900 / dist2) * cool;
        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;
        A.vx += fx;
        A.vy += fy;
        B.vx -= fx;
        B.vy -= fy;
      }
    }

    // Edge springs
    for (const e of edgePairs) {
      const dx = e.b.x - e.a.x;
      const dy = e.b.y - e.a.y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 1;
      const ideal = 70 + (3 - Math.min(e.w, 3)) * 25;
      const force = (dist - ideal) * 0.04 * e.w;
      const fx = (dx / dist) * force;
      const fy = (dy / dist) * force;
      e.a.vx += fx;
      e.a.vy += fy;
      e.b.vx -= fx;
      e.b.vy -= fy;
    }

    // Cluster attraction + soft bounds
    for (const s of sims) {
      const cen = centroids.get(s.cluster) ?? { x: GALAXY_CX, y: GALAXY_CY };
      s.vx += (cen.x - s.x) * 0.012;
      s.vy += (cen.y - s.y) * 0.012;
      s.vx += (GALAXY_CX - s.x) * 0.0015;
      s.vy += (GALAXY_CY - s.y) * 0.0015;

      s.vx *= 0.78;
      s.vy *= 0.78;
      s.x += s.vx;
      s.y += s.vy;

      const pad = 30;
      if (s.x < pad) s.x = pad;
      if (s.x > GALAXY_W - pad) s.x = GALAXY_W - pad;
      if (s.y < pad) s.y = pad;
      if (s.y > GALAXY_H - pad) s.y = GALAXY_H - pad;
    }
  }

  const pos = new Map(sims.map((s) => [s.id, s]));
  const nodes: GalaxyNode[] = books.map((b) => {
    const p = pos.get(b.id)!;
    const genres = b.genres.slice(0, 3);
    return {
      id: b.id,
      title: shortTitle(b.title),
      author: b.author,
      x: round1(p.x),
      y: round1(p.y),
      r: scalePages(b.pages, 4, 14, maxPages),
      color: b.coverColor,
      cover: b.cover,
      rating: b.rating,
      year: yearOf(b.dateRead),
      genres,
      cluster: clusterOf.get(b.id)!,
    };
  });

  // Cluster centroids from final member positions
  const clusters: GalaxyCluster[] = clusterLabels.map((label) => {
    const members = nodes.filter((n) => n.cluster === label);
    const x = members.reduce((s, n) => s + n.x, 0) / members.length;
    const y = members.reduce((s, n) => s + n.y, 0) / members.length;
    const hues = members.map((n) => (n.color ? hueOf(n.color) : null)).filter((h): h is number => h != null);
    let hue: number;
    if (hues.length) {
      // Circular mean of hues
      let sx = 0;
      let sy = 0;
      for (const h of hues) {
        sx += Math.cos((h * Math.PI) / 180);
        sy += Math.sin((h * Math.PI) / 180);
      }
      hue = ((Math.atan2(sy, sx) * 180) / Math.PI + 360) % 360;
    } else {
      // Stable hash fallback from label
      let h = 0;
      for (let i = 0; i < label.length; i++) h = (h * 31 + label.charCodeAt(i)) >>> 0;
      hue = h % 360;
    }
    return { label, x: round1(x), y: round1(y), count: members.length, hue: round1(hue) };
  });

  return { width: GALAXY_W, height: GALAXY_H, nodes, edges, clusters };
}

// ─── Orbits ──────────────────────────────────────────────────────────────────

export type OrbitYear = {
  year: number;
  /** Ring radius from center (viewBox ~1000×1000, center 500,500). */
  radius: number;
  count: number;
  pages: number;
};

export type OrbitPlanet = {
  id: string;
  title: string;
  author: string;
  year: number;
  /** Radians along the ring, from day-of-year. */
  angle: number;
  /** Radius scaled by pages (~3–16). */
  r: number;
  color: string | null;
  cover: string | null;
  rating: number | null;
  /** dateRead as ms epoch. */
  dateRead: number;
};

export type OrbitsPayload = {
  years: OrbitYear[];
  planets: OrbitPlanet[];
};

const ORBIT_INNER = 70;
const ORBIT_OUTER = 460;

/**
 * Solar-system model: one orbit ring per calendar year of dateRead (oldest
 * innermost). Planet angle = day-of-year around the ring.
 */
export function buildOrbits(books: BookRow[]): OrbitsPayload {
  if (!books.length) return { years: [], planets: [] };

  const byYear = new Map<number, BookRow[]>();
  for (const b of books) {
    const y = yearOf(b.dateRead);
    const list = byYear.get(y) ?? [];
    list.push(b);
    byYear.set(y, list);
  }
  const yearNums = [...byYear.keys()].sort((a, b) => a - b);
  const maxPages = Math.max(...books.map((b) => b.pages), 1);
  const span = Math.max(yearNums.length - 1, 1);

  const years: OrbitYear[] = yearNums.map((year, i) => {
    const list = byYear.get(year)!;
    const radius =
      yearNums.length === 1
        ? (ORBIT_INNER + ORBIT_OUTER) / 2
        : ORBIT_INNER + (i / span) * (ORBIT_OUTER - ORBIT_INNER);
    return {
      year,
      radius: round1(radius),
      count: list.length,
      pages: list.reduce((s, b) => s + b.pages, 0),
    };
  });
  const planets: OrbitPlanet[] = books.map((b) => {
    const year = yearOf(b.dateRead);
    const doy = dayOfYear(b.dateRead);
    const isLeap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const days = isLeap ? 366 : 365;
    return {
      id: b.id,
      title: shortTitle(b.title),
      author: b.author,
      year,
      angle: round2((doy / days) * Math.PI * 2),
      r: scalePages(b.pages, 3, 16, maxPages),
      color: b.coverColor,
      cover: b.cover,
      rating: b.rating,
      dateRead: b.dateRead,
    };
  });

  return { years, planets };
}

// ─── Rhythm ──────────────────────────────────────────────────────────────────

export type RhythmYear = {
  year: number;
  /** Books finished per calendar month (index 0 = Jan). */
  months: number[];
  /** Pages finished per calendar month. */
  pages: number[];
  total: number;
};

export type RhythmHalfBin = {
  year: number;
  /** 1 = Jan–Jun, 2 = Jul–Dec. */
  half: 1 | 2;
};

export type RhythmStreamSeries = {
  genre: string;
  /** Counts aligned to `stream.bins`. */
  values: number[];
};

export type RhythmStream = {
  /** Top ~8 genres by count; remainder rolled into 'other'. */
  genres: string[];
  series: RhythmStreamSeries[];
  bins: RhythmHalfBin[];
};

export type RhythmStats = {
  /** `month` is 0–11 (Jan–Dec). */
  busiestMonth: { year: number; month: number; count: number };
  longestGapDays: number;
  medianGapDays: number;
};

export type RhythmPayload = {
  years: RhythmYear[];
  stream: RhythmStream;
  stats: RhythmStats;
};

/**
 * Reading cadence: per-year monthly histograms, a half-year genre stream
 * (top ~8 genres + 'other'), and gap / busiest-month stats.
 */
export function buildRhythm(books: BookRow[]): RhythmPayload {
  if (!books.length) {
    return {
      years: [],
      stream: { genres: [], series: [], bins: [] },
      stats: {
        busiestMonth: { year: 0, month: 0, count: 0 },
        longestGapDays: 0,
        medianGapDays: 0,
      },
    };
  }

  const yearMap = new Map<number, { months: number[]; pages: number[] }>();
  let busiest = { year: 0, month: 0, count: 0 };

  for (const b of books) {
    const d = new Date(b.dateRead);
    const year = d.getUTCFullYear();
    const month = d.getUTCMonth(); // 0–11
    let row = yearMap.get(year);
    if (!row) {
      row = { months: Array(12).fill(0), pages: Array(12).fill(0) };
      yearMap.set(year, row);
    }
    row.months[month] += 1;
    row.pages[month] += b.pages;
    if (row.months[month] > busiest.count) {
      busiest = { year, month, count: row.months[month] };
    }
  }

  const years: RhythmYear[] = [...yearMap.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([year, row]) => ({
      year,
      months: row.months,
      pages: row.pages,
      total: row.months.reduce((s, n) => s + n, 0),
    }));

  // Gaps between consecutive finishes
  const sorted = [...books].sort((a, b) => a.dateRead - b.dateRead);
  const gaps: number[] = [];
  for (let i = 1; i < sorted.length; i++) {
    gaps.push((sorted[i].dateRead - sorted[i - 1].dateRead) / 86400000);
  }
  const longestGapDays = gaps.length ? round1(Math.max(...gaps)) : 0;
  const medianGapDays = gaps.length ? round1(median(gaps)) : 0;

  // Half-year bins spanning first→last read
  const firstY = yearOf(sorted[0].dateRead);
  const lastY = yearOf(sorted[sorted.length - 1].dateRead);
  const bins: RhythmHalfBin[] = [];
  for (let y = firstY; y <= lastY; y++) {
    bins.push({ year: y, half: 1 });
    bins.push({ year: y, half: 2 });
  }

  const genreCounts = countMap(books.flatMap((b) => (b.genres.length ? b.genres : ['other'])));
  const top = genreCounts.slice(0, 8).map(([g]) => g);
  const topSet = new Set(top);
  const genres = top.includes('other') ? top : [...top, 'other'];

  const seriesMap = new Map<string, number[]>(genres.map((g) => [g, bins.map(() => 0)]));

  for (const b of books) {
    const d = new Date(b.dateRead);
    const year = d.getUTCFullYear();
    const half: 1 | 2 = d.getUTCMonth() < 6 ? 1 : 2;
    const bi = bins.findIndex((bn) => bn.year === year && bn.half === half);
    if (bi < 0) continue;
    const bookGenres = b.genres.length ? b.genres : ['other'];
    // Attribute to first matching top genre, else other (once per book)
    const hit = bookGenres.find((g) => topSet.has(g));
    const key = hit ?? 'other';
    const arr = seriesMap.get(key);
    if (arr) arr[bi] += 1;
  }

  const series: RhythmStreamSeries[] = genres.map((genre) => ({
    genre,
    values: seriesMap.get(genre) ?? bins.map(() => 0),
  }));

  return {
    years,
    stream: { genres, series, bins },
    stats: {
      busiestMonth: busiest,
      longestGapDays,
      medianGapDays,
    },
  };
}

// ─── Evolution (taste over years) ────────────────────────────────────────────

export type EvolutionYear = {
  year: number;
  n: number;
  avgRating: number | null;
  medianPages: number | null;
  medianPub: number | null;
  medianLag: number | null;
  fictionShare: number | null; // 0–1 among classified
  topGenres: { label: string; n: number }[];
  topMoods: { label: string; n: number }[];
  topAuthors: { label: string; n: number }[];
};

export type EvolutionEra = {
  id: string;
  label: string;
  years: number[];
  blurb: string;
  n: number;
  signature: string[];
};

export type EvolutionPayload = {
  years: EvolutionYear[];
  eras: EvolutionEra[];
  /** Cumulative unique authors after each year. */
  authorGrowth: { year: number; unique: number }[];
  /** Genre share matrix: rows = years, cols = top genres. */
  genreShare: { genres: string[]; rows: { year: number; shares: number[] }[] };
};

function medianOrNull(nums: number[]): number | null {
  return nums.length ? round1(median(nums)) : null;
}

function yearBucket(books: BookRow[]): Map<number, BookRow[]> {
  const m = new Map<number, BookRow[]>();
  for (const b of books) {
    const y = yearOf(b.dateRead);
    if (!m.has(y)) m.set(y, []);
    m.get(y)!.push(b);
  }
  return m;
}

/**
 * Year-by-year taste fingerprint + named eras + genre-share river data.
 */
export function buildEvolution(books: BookRow[]): EvolutionPayload {
  const byYear = yearBucket(books);
  const yearsAsc = [...byYear.keys()].sort((a, b) => a - b);

  const years: EvolutionYear[] = yearsAsc.map((year) => {
    const list = byYear.get(year)!;
    const rated = list.map((b) => b.rating).filter((r): r is number => r != null);
    const pages = list.map((b) => b.pages).filter((p) => p > 0);
    const pubs = list.map((b) => b.pubYear).filter((y) => y > 0);
    const lags = list.filter((b) => b.pubYear > 0).map((b) => year - b.pubYear);
    const fic = list.filter((b) => b.fiction === true).length;
    const non = list.filter((b) => b.fiction === false).length;
    const classified = fic + non;
    return {
      year,
      n: list.length,
      avgRating: rated.length ? round2(rated.reduce((s, r) => s + r, 0) / rated.length) : null,
      medianPages: medianOrNull(pages),
      medianPub: medianOrNull(pubs),
      medianLag: medianOrNull(lags),
      fictionShare: classified ? round2(fic / classified) : null,
      topGenres: countMap(list.flatMap((b) => b.genres)).slice(0, 4).map(([label, n]) => ({ label, n })),
      topMoods: countMap(list.flatMap((b) => b.moods)).slice(0, 4).map(([label, n]) => ({ label, n })),
      topAuthors: countMap(list.map((b) => b.author)).slice(0, 3).map(([label, n]) => ({ label, n })),
    };
  });

  // Eras: hand-tuned narrative from the actual arc (nonfiction → classics → fiction/fantasy)
  const eras: EvolutionEra[] = [];
  const pushEra = (id: string, label: string, ys: number[], blurb: string, signature: string[]) => {
    const list = ys.flatMap((y) => byYear.get(y) ?? []);
    if (!list.length) return;
    eras.push({ id, label, years: ys, blurb, n: list.length, signature });
  };
  pushEra(
    'bootcamp',
    'Self-improvement bootcamp',
    yearsAsc.filter((y) => y === 2020),
    'Nonfiction-heavy year: productivity, philosophy, and how-to energy. The shelf was still mostly advice.',
    ['Nonfiction', 'Philosophy', 'Young Adult']
  );
  pushEra(
    'classics',
    'Classics binge',
    yearsAsc.filter((y) => y === 2021),
    'The pivot: fiction and classics take over. Chandler, Hemingway, and the long dead crowd the nightstand.',
    ['Fiction', 'Classics', 'Young Adult']
  );
  pushEra(
    'wander',
    'Wandering fiction',
    yearsAsc.filter((y) => y >= 2022 && y <= 2024),
    'Shorter years, wider taste — fantasy arcs, literary experiments, and a slower, more selective pace.',
    ['Fiction', 'Fantasy', 'Classics']
  );
  pushEra(
    'now',
    'The present tense',
    yearsAsc.filter((y) => y >= 2025),
    'Fewer books, thicker ones. Recent reads lean long and literary — quality over volume.',
    ['Fiction', 'Literary Fiction', 'Science Fiction']
  );

  // Cumulative unique authors
  const seen = new Set<string>();
  const authorGrowth: { year: number; unique: number }[] = [];
  for (const y of yearsAsc) {
    for (const b of byYear.get(y)!) seen.add(b.author);
    authorGrowth.push({ year: y, unique: seen.size });
  }

  // Genre mix for top genres across years.
  // Books can carry multiple genres, so raw "share of books tagged X" can sum well
  // over 100%. Normalize within each year so the river is a relative mix of top tags.
  const globalGenres = countMap(books.flatMap((b) => b.genres)).slice(0, 7).map(([g]) => g);
  const genreShare = {
    genres: globalGenres,
    rows: yearsAsc.map((year) => {
      const list = byYear.get(year)!;
      const raw = globalGenres.map((g) => list.filter((b) => b.genres.includes(g)).length);
      const total = raw.reduce((s, n) => s + n, 0);
      const shares = raw.map((n) => (total > 0 ? round2(n / total) : 0));
      return { year, shares };
    }),
  };

  return { years, eras, authorGrowth, genreShare };
}

// ─── Fossils (abandoned / one-off tastes) ────────────────────────────────────

export type Fossil = {
  kind: 'genre' | 'mood' | 'author';
  label: string;
  count: number;
  firstYear: number;
  lastYear: number;
  dormantYears: number;
  blurb: string;
  samples: { id: string; title: string; year: number }[];
};

export type FossilsPayload = {
  fossils: Fossil[];
  /** Genres that appeared, vanished, then returned. */
  revivals: { label: string; gap: number; first: number; returnYear: number }[];
};

/**
 * Things you used to read that went quiet — extinct genres, one-season moods,
 * authors you never returned to.
 */
export function buildFossils(books: BookRow[], nowYear = new Date().getFullYear()): FossilsPayload {
  type Hit = { id: string; title: string; year: number };
  const track = (key: string, hit: Hit, map: Map<string, Hit[]>) => {
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(hit);
  };

  const genres = new Map<string, Hit[]>();
  const moods = new Map<string, Hit[]>();
  const authors = new Map<string, Hit[]>();

  for (const b of books) {
    const year = yearOf(b.dateRead);
    const hit = { id: b.id, title: shortTitle(b.title), year };
    for (const g of b.genres) track(g, hit, genres);
    for (const m of b.moods) track(m, hit, moods);
    track(b.author, hit, authors);
  }

  function toFossil(
    kind: Fossil['kind'],
    label: string,
    hits: Hit[],
    minCount: number,
    minDormant: number
  ): Fossil | null {
    if (hits.length < minCount) return null;
    const years = hits.map((h) => h.year).sort((a, b) => a - b);
    const firstYear = years[0];
    const lastYear = years[years.length - 1];
    const dormantYears = nowYear - lastYear;
    if (dormantYears < minDormant) return null;
    // Prefer things that had a real run, then stopped
    const span = lastYear - firstYear;
    if (hits.length >= 3 && span === 0 && dormantYears < 3) return null;
    const samples = [...hits]
      .sort((a, b) => b.year - a.year)
      .filter((h, i, arr) => arr.findIndex((x) => x.id === h.id) === i)
      .slice(0, 4);
    const blurb =
      kind === 'author'
        ? `${hits.length} books, last in ${lastYear} — ${dormantYears} year${dormantYears === 1 ? '' : 's'} quiet.`
        : kind === 'mood'
          ? `Showed up on ${hits.length} books through ${lastYear}, then went dark.`
          : `${hits.length} books tagged ${label.toLowerCase()}, last sighted ${lastYear}.`;
    return { kind, label, count: hits.length, firstYear, lastYear, dormantYears, blurb, samples };
  }

  const fossils: Fossil[] = [];
  for (const [label, hits] of genres) {
    const f = toFossil('genre', label, hits, 2, 2);
    if (f) fossils.push(f);
  }
  for (const [label, hits] of moods) {
    const f = toFossil('mood', label, hits, 3, 2);
    if (f) fossils.push(f);
  }
  for (const [label, hits] of authors) {
    // one-and-done authors with at least 2 books, or 3+ then abandoned
    const f = toFossil('author', label, hits, 2, 2);
    if (f) fossils.push(f);
  }

  fossils.sort((a, b) => b.dormantYears - a.dormantYears || b.count - a.count);

  // Revivals: gap of ≥2 years inside the history
  const revivals: FossilsPayload['revivals'] = [];
  for (const [label, hits] of genres) {
    const ys = [...new Set(hits.map((h) => h.year))].sort((a, b) => a - b);
    for (let i = 1; i < ys.length; i++) {
      const gap = ys[i] - ys[i - 1];
      if (gap >= 3) {
        revivals.push({ label, gap, first: ys[0], returnYear: ys[i] });
        break;
      }
    }
  }
  revivals.sort((a, b) => b.gap - a.gap);

  return { fossils: fossils.slice(0, 24), revivals: revivals.slice(0, 8) };
}

// ─── Metamorphosis (before/after taste morph) ────────────────────────────────

export type MorphHalf = {
  label: string;
  years: string;
  n: number;
  avgRating: number | null;
  medianPages: number | null;
  fictionShare: number | null;
  medianLag: number | null;
  topGenres: { label: string; n: number; share: number }[];
  topMoods: { label: string; n: number }[];
  topAuthors: { label: string; n: number }[];
  sampleCovers: { id: string; title: string; cover: string | null; color: string | null }[];
};

export type MorphDelta = {
  key: string;
  label: string;
  before: number | null;
  after: number | null;
  unit: string;
  /** Positive = grew in the later half. */
  delta: number | null;
};

export type MetamorphosisPayload = {
  before: MorphHalf;
  after: MorphHalf;
  deltas: MorphDelta[];
  /** Genres that rose or fell the most (share points). */
  genreShifts: { label: string; before: number; after: number; delta: number }[];
};

function summarizeHalf(label: string, yearsLabel: string, list: BookRow[]): MorphHalf {
  const rated = list.map((b) => b.rating).filter((r): r is number => r != null);
  const pages = list.map((b) => b.pages).filter((p) => p > 0);
  const lags = list
    .filter((b) => b.pubYear > 0)
    .map((b) => yearOf(b.dateRead) - b.pubYear);
  const fic = list.filter((b) => b.fiction === true).length;
  const non = list.filter((b) => b.fiction === false).length;
  const classified = fic + non;
  const genres = countMap(list.flatMap((b) => b.genres)).slice(0, 6);
  return {
    label,
    years: yearsLabel,
    n: list.length,
    avgRating: rated.length ? round2(rated.reduce((s, r) => s + r, 0) / rated.length) : null,
    medianPages: medianOrNull(pages),
    fictionShare: classified ? round2(fic / classified) : null,
    medianLag: medianOrNull(lags),
    topGenres: genres.map(([label, n]) => ({ label, n, share: round2(n / Math.max(1, list.length)) })),
    topMoods: countMap(list.flatMap((b) => b.moods)).slice(0, 5).map(([label, n]) => ({ label, n })),
    topAuthors: countMap(list.map((b) => b.author)).slice(0, 5).map(([label, n]) => ({ label, n })),
    sampleCovers: [...list]
      .sort((a, b) => b.dateRead - a.dateRead)
      .slice(0, 8)
      .map((b) => ({ id: b.id, title: shortTitle(b.title), cover: b.cover, color: b.coverColor })),
  };
}

/**
 * Split the shelf at the midpoint in time and compare the two halves —
 * a before/after of reading taste.
 */
export function buildMetamorphosis(books: BookRow[]): MetamorphosisPayload {
  const sorted = [...books].sort((a, b) => a.dateRead - b.dateRead);
  const mid = Math.floor(sorted.length / 2);
  const early = sorted.slice(0, mid);
  const late = sorted.slice(mid);
  const y0 = yearOf(early[0]?.dateRead ?? 0);
  const y1 = yearOf(early[early.length - 1]?.dateRead ?? 0);
  const y2 = yearOf(late[0]?.dateRead ?? 0);
  const y3 = yearOf(late[late.length - 1]?.dateRead ?? 0);

  const before = summarizeHalf('Then', y0 === y1 ? `${y0}` : `${y0}–${y1}`, early);
  const after = summarizeHalf('Now', y2 === y3 ? `${y2}` : `${y2}–${y3}`, late);

  const deltas: MorphDelta[] = [
    {
      key: 'fiction',
      label: 'Fiction share',
      before: before.fictionShare,
      after: after.fictionShare,
      unit: '%',
      delta:
        before.fictionShare != null && after.fictionShare != null
          ? round2(after.fictionShare - before.fictionShare)
          : null,
    },
    {
      key: 'rating',
      label: 'Average rating',
      before: before.avgRating,
      after: after.avgRating,
      unit: '★',
      delta:
        before.avgRating != null && after.avgRating != null
          ? round2(after.avgRating - before.avgRating)
          : null,
    },
    {
      key: 'pages',
      label: 'Median length',
      before: before.medianPages,
      after: after.medianPages,
      unit: 'p',
      delta:
        before.medianPages != null && after.medianPages != null
          ? round1(after.medianPages - before.medianPages)
          : null,
    },
    {
      key: 'lag',
      label: 'Median pub→read lag',
      before: before.medianLag,
      after: after.medianLag,
      unit: 'y',
      delta:
        before.medianLag != null && after.medianLag != null
          ? round1(after.medianLag - before.medianLag)
          : null,
    },
  ];

  const genreKeys = new Set([
    ...before.topGenres.map((g) => g.label),
    ...after.topGenres.map((g) => g.label),
  ]);
  const beforeShare = new Map(before.topGenres.map((g) => [g.label, g.share]));
  const afterShare = new Map(after.topGenres.map((g) => [g.label, g.share]));
  // also compute share for any genre in either half
  const earlyN = Math.max(1, early.length);
  const lateN = Math.max(1, late.length);
  for (const g of genreKeys) {
    if (!beforeShare.has(g)) {
      beforeShare.set(g, round2(early.filter((b) => b.genres.includes(g)).length / earlyN));
    }
    if (!afterShare.has(g)) {
      afterShare.set(g, round2(late.filter((b) => b.genres.includes(g)).length / lateN));
    }
  }
  const genreShifts = [...genreKeys]
    .map((label) => {
      const b = beforeShare.get(label) ?? 0;
      const a = afterShare.get(label) ?? 0;
      return { label, before: b, after: a, delta: round2(a - b) };
    })
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
    .slice(0, 8);

  return { before, after, deltas, genreShifts };
}
