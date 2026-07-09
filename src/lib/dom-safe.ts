/**
 * Client-side escaping helpers for stats pages that build HTML with innerHTML.
 * Import from bundled <script> blocks (not is:inline).
 */

export function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Safe path segment for /reading/books/:id links and data-id attributes. */
export function bookId(id: unknown): string {
  const s = String(id ?? '');
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(s)) return '';
  return encodeURIComponent(s);
}

export function bookHref(id: unknown): string {
  const safe = bookId(id);
  return safe ? `/reading/books/${safe}` : '#';
}

export function safeCoverSrc(raw: unknown): string | null {
  if (raw == null || raw === '') return null;
  const s = String(raw).trim();
  if (!/^\/covers\/bookshelf\/[a-z0-9._-]+\.(jpe?g|png|webp|gif)(\?v=\d+)?$/i.test(s)) {
    return null;
  }
  return s;
}

export function safeHex(raw: unknown): string | null {
  if (raw == null || raw === '') return null;
  const s = String(raw).trim();
  if (!/^#[0-9a-fA-F]{6}$/.test(s)) return null;
  return s;
}
