import { getCollection, type CollectionEntry } from 'astro:content';

export type BookRow = {
  id: string;
  title: string;
  author: string;
  dateRead: number;
  dateAdded: number | null;
  rating: number | null;
  pages: number;
  pubYear: number;
  cover: string | null;
  coverColor: string | null;
  genres: string[];
  subjects: string[];
  places: string[];
  moods: string[];
  fiction: boolean | null;
  review: string;
  series: string | null;
  seriesIndex: number | null;
};

const SERIES_RE = /\(([^)#]+),\s*#([\d.–\-]+)\)\s*$/;

export function parseSeries(title: string): { series: string | null; seriesIndex: number | null } {
  const m = title.match(SERIES_RE);
  if (!m) return { series: null, seriesIndex: null };
  const raw = m[2].split(/[.–\-]/)[0];
  const n = Number(raw);
  // Normalize "The Reckoners" / "Reckoners" (and "The Rat" / "Rat") to one key.
  const series = m[1].trim().replace(/^the\s+/i, '');
  return { series: series || null, seriesIndex: Number.isFinite(n) ? n : null };
}

/** Site-relative cover path only (optional cache-bust query). */
export function sanitizeCover(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = String(raw).trim();
  if (!/^\/covers\/bookshelf\/[a-z0-9._-]+\.(jpe?g|png|webp|gif)(\?v=\d+)?$/i.test(s)) {
    return null;
  }
  return s;
}

/** Hex color only — blocks CSS/attribute breakout via coverColor. */
export function sanitizeCoverColor(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = String(raw).trim();
  if (!/^#[0-9a-fA-F]{6}$/.test(s)) return null;
  return s;
}

/**
 * JSON for embedding in <script type="application/json"> via set:html.
 * Escapes < and > so a string like "</script><script>…" cannot break out.
 */
export function safeJsonForScript(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e');
}

export function toRow(b: CollectionEntry<'bookshelf'>): BookRow {
  const { series, seriesIndex } = parseSeries(b.data.title);
  return {
    id: b.id,
    title: b.data.title,
    author: b.data.author,
    dateRead: b.data.dateRead.valueOf(),
    dateAdded: b.data.dateAdded ? b.data.dateAdded.valueOf() : null,
    rating: b.data.rating && b.data.rating > 0 ? b.data.rating : null,
    pages: b.data.pages ?? 0,
    pubYear: b.data.pubYear ?? 0,
    cover: sanitizeCover(b.data.cover),
    coverColor: sanitizeCoverColor(b.data.coverColor),
    genres: b.data.genres ?? [],
    subjects: b.data.subjects ?? [],
    places: b.data.places ?? [],
    moods: (b.data.moods ?? []).filter((m) => !/paced$/i.test(m)),
    fiction: typeof b.data.fiction === 'boolean' ? b.data.fiction : null,
    review: typeof b.body === 'string' ? b.body.trim() : '',
    series,
    seriesIndex,
  };
}

export async function loadBooks(): Promise<BookRow[]> {
  const books = await getCollection('bookshelf');
  return books.map(toRow).sort((a, b) => a.dateRead - b.dateRead);
}

export function countMap(items: string[]): [string, number][] {
  const m = new Map<string, number>();
  for (const x of items) m.set(x, (m.get(x) ?? 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

export function pct(n: number, max: number) {
  return `${Math.max(2, Math.round((n / Math.max(max, 1)) * 100))}%`;
}

export function shortTitle(title: string) {
  return title.replace(/\s*\([^)]*\)\s*$/, '').replace(/:.*$/, '').trim();
}

export function hexToRgb(hex: string): [number, number, number] | null {
  const h = hex.replace('#', '');
  if (h.length !== 6) return null;
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

export function luminance(hex: string): number {
  const rgb = hexToRgb(hex);
  if (!rgb) return 0.5;
  const [r, g, b] = rgb.map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function hueOf(hex: string): number {
  const rgb = hexToRgb(hex);
  if (!rgb) return 0;
  const [r, g, b] = rgb.map((c) => c / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  if (d === 0) return 0;
  let h = 0;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h *= 60;
  if (h < 0) h += 360;
  return h;
}

export function colorFamily(hex: string): string {
  const rgb = hexToRgb(hex);
  if (!rgb) return 'unknown';
  const [r, g, b] = rgb;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const sat = max === 0 ? 0 : (max - min) / max;
  const light = max / 255;
  if (sat < 0.12) return light < 0.25 ? 'black' : light > 0.78 ? 'white' : 'gray';
  const h = hueOf(hex);
  if (h < 20 || h >= 340) return 'red';
  if (h < 45) return 'orange';
  if (h < 70) return 'yellow';
  if (h < 160) return 'green';
  if (h < 200) return 'teal';
  if (h < 255) return 'blue';
  if (h < 300) return 'purple';
  return 'pink';
}

const STOP = new Set(
  `the a an and or but in on of to for with as is was were be been being it this that these those i my me we you he she they his her their from at by not so if then than about into over after before when while just very really also more most some any all can could would should will may might have has had do does did am are was were been being which who what how why where your our its it's i'm i've i'll don't didn't doesn't it's that's there's here's what's who's there's we're you're they're there's because through between against without within upon each both few other such only own same too than once here there when where why how all any both each few more most other some such no nor not only own same so than too very s t can will just don should now d ll m o re ve y ain aren couldn didn doesn hadn hasn haven isn ma mightn mustn needn shan shouldn wasn weren won wouldn`.split(
    /\s+/
  )
);

export function tokenizeReview(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/\[(?:b|a):[^\]]+\]/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[^a-z'\s-]/g, ' ')
    .split(/\s+/)
    .map((w) => w.replace(/^'+|'+$/g, ''))
    .filter((w) => w.length >= 4 && !STOP.has(w) && !/^\d+$/.test(w));
}

export function wordCounts(texts: string[], limit = 60): [string, number][] {
  const m = new Map<string, number>();
  for (const t of texts) {
    for (const w of tokenizeReview(t)) m.set(w, (m.get(w) ?? 0) + 1);
  }
  return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, limit);
}

export function readingStreaks(dates: number[]): {
  current: number;
  longest: number;
  longestEnd: number | null;
} {
  if (!dates.length) return { current: 0, longest: 0, longestEnd: null };
  // Consecutive finishes within 14 days of each other
  const sorted = [...dates].sort((a, b) => a - b);
  let best = 1;
  let bestEnd: number | null = sorted[0];
  let cur = 1;
  for (let i = 1; i < sorted.length; i++) {
    const gap = (sorted[i] - sorted[i - 1]) / 86400000;
    if (gap <= 14) {
      cur += 1;
      if (cur > best) {
        best = cur;
        bestEnd = sorted[i];
      }
    } else cur = 1;
  }
  let current = 1;
  for (let i = sorted.length - 1; i > 0; i--) {
    if ((sorted[i] - sorted[i - 1]) / 86400000 <= 14) current += 1;
    else break;
  }
  return { current, longest: best, longestEnd: bestEnd };
}

export const STATS_LINKS = [
  { href: '/reading/stats', label: 'Overview' },
  { href: '/reading/stats/atlas', label: 'Atlas' },
  { href: '/reading/stats/constellation', label: 'Constellation' },
  { href: '/reading/stats/galaxy', label: 'Galaxy' },
  { href: '/reading/stats/orbit', label: 'Orbits' },
  { href: '/reading/stats/evolution', label: 'Evolution' },
  { href: '/reading/stats/metamorphosis', label: 'Metamorphosis' },
  { href: '/reading/stats/fossils', label: 'Fossils' },
  { href: '/reading/stats/lag', label: 'Time lag' },
  { href: '/reading/stats/rhythm', label: 'Rhythm' },
] as const;
