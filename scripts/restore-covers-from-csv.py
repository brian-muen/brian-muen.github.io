#!/usr/bin/env python3
"""
Restore bookshelf covers (and ISBNs) from an authoritative StoryGraph CSV.
Prefers Open Library / Google Books covers for the exact ISBN in the CSV.
"""
from __future__ import annotations

import csv
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_CSV = Path.home() / "Downloads/ab3fa717133180bd8a861b0e9bfaf78023eb23c30419db3ff86c724993e2f33f.csv"
BOOKS_DIR = ROOT / "src/content/bookshelf"
COVER_DIR = ROOT / "public/covers/bookshelf"

UA = "bookshelf-cover-restore/1.0"


def clean_isbn(raw: str | None) -> str:
    if not raw:
        return ""
    return re.sub(r"[^0-9Xx]", "", str(raw)).upper()


def isbn10_to_13(isbn10: str) -> str | None:
    s = clean_isbn(isbn10)
    if len(s) != 10:
        return None
    core = "978" + s[:9]
    total = sum(int(d) * (1 if i % 2 == 0 else 3) for i, d in enumerate(core))
    check = (10 - (total % 10)) % 10
    return core + str(check)


def to_isbn13(isbn: str | None) -> str | None:
    s = clean_isbn(isbn)
    if len(s) == 13:
        return s
    if len(s) == 10:
        return isbn10_to_13(s)
    return None


def same_isbn(a: str | None, b: str | None) -> bool:
    a13, b13 = to_isbn13(a), to_isbn13(b)
    if a13 and b13 and a13 == b13:
        return True
    return clean_isbn(a) == clean_isbn(b)


def is_valid_isbn(isbn: str | None) -> bool:
    s = clean_isbn(isbn)
    if len(s) == 10:
        return bool(re.match(r"^\d{9}[\dX]$", s))
    if len(s) == 13:
        return bool(re.match(r"^97[89]\d{10}$", s))
    return False


def title_key(s: str | None) -> str:
    t = (s or "").lower()
    t = re.sub(r"\(.*?\)", "", t)
    t = re.sub(r":.*$", "", t)
    t = re.sub(r"[^a-z0-9]+", " ", t)
    t = re.sub(r"\b(the|a|an)\b", " ", t)
    return re.sub(r"\s+", " ", t).strip()


def titles_match(a: str, b: str) -> bool:
    q, c = title_key(a), title_key(b)
    if not q or not c:
        return False
    return q == c or q.startswith(c) or c.startswith(q)


def fetch(url: str, timeout: float = 25.0) -> tuple[int, bytes, str]:
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as res:
            return res.status, res.read(), res.headers.get("Content-Type", "")
    except urllib.error.HTTPError as e:
        return e.code, e.read() if e.fp else b"", e.headers.get("Content-Type", "") if e.headers else ""
    except Exception:
        return 0, b"", ""


def save_cover_from_url(url: str, dest: Path) -> bool:
    status, body, ctype = fetch(url)
    if status != 200:
        return False
    if "image" not in ctype and not url.lower().endswith((".jpg", ".jpeg", ".png", ".webp")):
        # Open Library sometimes omits content-type; accept if body looks like JPEG
        if not (body[:3] == b"\xff\xd8\xff" or body[:8] == b"\x89PNG\r\n\x1a\n"):
            return False
    if len(body) < 1500:
        return False
    dest.write_bytes(body)
    return True


def cover_from_google(isbn: str) -> str | None:
    url = f"https://www.googleapis.com/books/v1/volumes?q=isbn:{isbn}&maxResults=1"
    status, body, _ = fetch(url)
    if status != 200:
        return None
    import json

    try:
        data = json.loads(body.decode("utf-8"))
    except Exception:
        return None
    info = (data.get("items") or [{}])[0].get("volumeInfo", {}).get("imageLinks") or {}
    raw = info.get("extraLarge") or info.get("large") or info.get("medium") or info.get("thumbnail") or info.get("smallThumbnail")
    if not raw:
        return None
    return raw.replace("http://", "https://").replace("&edge=curl", "").replace("zoom=1", "zoom=2")


def cover_from_ol_search(title: str, author: str) -> str | None:
    clean = re.sub(r"\(.*?\)", "", title or "").split(":")[0].strip()
    if not clean:
        return None
    author_last = re.sub(r"[^a-z]", "", (author or "").split(",")[0].strip().split()[-1].lower()) if author else ""
    params = urllib.parse.urlencode({"title": clean, "limit": "10", **({"author": author.split(",")[0].strip()} if author else {})})
    status, body, _ = fetch(f"https://openlibrary.org/search.json?{params}")
    if status != 200:
        return None
    import json

    try:
        docs = json.loads(body.decode("utf-8")).get("docs") or []
    except Exception:
        return None

    def author_ok(d: dict) -> bool:
        if not author_last:
            return True
        return author_last in " ".join(d.get("author_name") or []).lower()

    pick = next((d for d in docs if d.get("cover_i") and author_ok(d) and titles_match(clean, d.get("title") or "")), None)
    if not pick:
        pick = next((d for d in docs if d.get("cover_i") and author_ok(d)), None)
    if not pick:
        return None
    return f"https://covers.openlibrary.org/b/id/{pick['cover_i']}-L.jpg"


def download_cover(isbn: str, dest: Path, title: str, author: str) -> str | None:
    urls: list[str] = []
    if is_valid_isbn(isbn):
        for size in ("L", "M"):
            urls.append(f"https://covers.openlibrary.org/b/isbn/{isbn}-{size}.jpg?default=false")
        as13 = to_isbn13(isbn)
        if as13 and as13 != isbn:
            for size in ("L", "M"):
                urls.append(f"https://covers.openlibrary.org/b/isbn/{as13}-{size}.jpg?default=false")

    for url in urls:
        if save_cover_from_url(url, dest):
            return "openlibrary-isbn"

    if is_valid_isbn(isbn):
        gb = cover_from_google(isbn)
        if gb and save_cover_from_url(gb, dest):
            return "google-isbn"

    search = cover_from_ol_search(title, author)
    if search and save_cover_from_url(search, dest):
        return "openlibrary-search"
    return None


def parse_fm(text: str) -> tuple[str, str] | None:
    if not text.startswith("---"):
        return None
    end = text.find("\n---", 3)
    if end < 0:
        return None
    return text[4:end], text[end + 4 :]


def get_field(block: str, key: str) -> str | None:
    m = re.search(rf"^{re.escape(key)}:\s*(.*)$", block, re.M)
    if not m:
        return None
    return m.group(1).strip().strip('"').strip("'")


def set_field(block: str, key: str, value: str) -> str:
    line = f"{key}: {value}"
    if re.search(rf"^{re.escape(key)}:\s*.*$", block, re.M):
        return re.sub(rf"^{re.escape(key)}:\s*.*$", line, block, count=1, flags=re.M)
    if re.search(r"^author:\s*.*$", block, re.M):
        return re.sub(r"^(author:\s*.*)$", rf"\1\n{line}", block, count=1, flags=re.M)
    return block.rstrip() + "\n" + line + "\n"


def remove_field(block: str, key: str) -> str:
    return re.sub(rf"^{re.escape(key)}:\s*.*\n?", "", block, count=1, flags=re.M)


def yaml_escape(s: str) -> str:
    return '"' + s.replace("\\", "\\\\").replace('"', '\\"') + '"'


def find_csv(csv_by_title: dict, title: str | None, author: str | None):
    key = title_key(title)
    cands = csv_by_title.get(key)
    if not cands:
        cands = csv_by_title.get(title_key((title or "").split(":")[0]))
    if not cands:
        for k, v in csv_by_title.items():
            if key and (key.startswith(k) or k.startswith(key)) and min(len(key), len(k)) > 10:
                cands = v
                break
    if not cands:
        return None
    if len(cands) == 1:
        return cands[0]
    author_l = (author or "").lower()
    for c in cands:
        if author_l and any(p in c["authors"].lower() for p in author_l.split() if len(p) > 2):
            return c
    return cands[0]


def main() -> int:
    csv_path = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_CSV
    COVER_DIR.mkdir(parents=True, exist_ok=True)

    with csv_path.open(newline="", encoding="utf-8") as f:
        rows = list(csv.DictReader(f))

    csv_by_title: dict[str, list] = {}
    for r in rows:
        isbn = clean_isbn(r.get("ISBN/UID"))
        title = (r.get("Title") or "").strip()
        if not title:
            continue
        key = title_key(title)
        entry = {
            "title": title,
            "authors": r.get("Authors") or "",
            "isbn": isbn if is_valid_isbn(isbn) else None,
        }
        csv_by_title.setdefault(key, []).append(entry)

    files = sorted(BOOKS_DIR.glob("*.md"))
    updated_isbn = replaced = failed = 0

    print(f"CSV: {len(rows)} rows; bookshelf: {len(files)} books")
    print("Restoring covers for ISBN mismatches / missing ISBNs…\n")

    for fp in files:
        text = fp.read_text(encoding="utf-8")
        parsed = parse_fm(text)
        if not parsed:
            continue
        block, body = parsed
        title = get_field(block, "title")
        author = get_field(block, "author")
        md_isbn = clean_isbn(get_field(block, "isbn"))
        cover = get_field(block, "cover")
        slug = fp.stem

        match = find_csv(csv_by_title, title, author)
        if not match or not match["isbn"]:
            continue

        target = match["isbn"]
        if md_isbn and same_isbn(md_isbn, target):
            continue

        block = set_field(block, "isbn", yaml_escape(target))
        updated_isbn += 1

        if cover and cover.startswith("/covers/bookshelf/"):
            dest = ROOT / "public" / cover.lstrip("/")
        else:
            dest = COVER_DIR / f"{slug}.jpg"

        print(f"{slug[:52]:52} {target} ", end="", flush=True)
        tmp = dest.with_suffix(dest.suffix + ".tmp")
        source = download_cover(target, tmp, title or "", author or "")
        if source:
            if dest.exists():
                dest.unlink()
            tmp.rename(dest)
            cover_path = f"/covers/bookshelf/{dest.name}"
            block = set_field(block, "cover", cover_path)
            block = remove_field(block, "coverColor")
            replaced += 1
            print(f"✓ {source}")
        else:
            if tmp.exists():
                tmp.unlink()
            failed += 1
            print("✗ keep existing")

        new_text = f"---\n{block.rstrip()}\n---{body if body.startswith(chr(10)) else chr(10) + body}"
        fp.write_text(new_text, encoding="utf-8")
        time.sleep(0.12)

    print("\nDone.")
    print(f"  ISBNs updated:      {updated_isbn}")
    print(f"  Covers replaced:    {replaced}")
    print(f"  Download failures:  {failed}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
