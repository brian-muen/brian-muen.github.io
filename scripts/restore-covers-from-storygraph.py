#!/usr/bin/env python3
"""Overwrite bookshelf covers with StoryGraph scrape CDN URLs."""
from __future__ import annotations

import json
import re
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
JSON_PATH = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / ".tmp-wp/storygraph-books.json"
BOOKS_DIR = ROOT / "src/content/bookshelf"
COVER_DIR = ROOT / "public/covers/bookshelf"

NUMBER_WORDS = {
    "one": "1", "two": "2", "three": "3", "four": "4", "five": "5",
    "six": "6", "seven": "7", "eight": "8", "nine": "9", "ten": "10",
}


def normalize(title: str | None) -> str:
    t = (title or "").lower()
    t = t.encode("ascii", "ignore").decode("ascii") if False else t
    import unicodedata

    t = unicodedata.normalize("NFKD", t)
    t = "".join(c for c in t if not unicodedata.combining(c))
    t = t.replace("favourite", "favorite")
    t = re.sub(r"\(.*?\)", "", t)
    t = re.sub(r":.*$", "", t)
    t = re.sub(r"[^a-z0-9 ]+", " ", t)
    t = re.sub(r"\b(the|a|an)\b", " ", t)
    t = re.sub(
        r"\b(one|two|three|four|five|six|seven|eight|nine|ten)\b",
        lambda m: NUMBER_WORDS[m.group(0)],
        t,
    )
    return re.sub(r"\s+", " ", t).strip()


def titles_match(a: str, b: str) -> bool:
    if not a or not b:
        return False
    return a == b or a.startswith(b) or b.startswith(a) or a in b or b in a


def get_field(block: str, key: str) -> str | None:
    m = re.search(rf"^{key}:\s*(.+)$", block, re.M)
    if not m:
        return None
    return m.group(1).strip().strip("\"'")


def set_field(block: str, key: str, value: str) -> str:
    line = f"{key}: {value}"
    if re.search(rf"^{key}:", block, re.M):
        return re.sub(rf"^{key}:.*$", line, block, count=1, flags=re.M)
    return re.sub(r"\n---\s*$", f"\n{line}\n---", block)


def remove_field(block: str, key: str) -> str:
    return re.sub(rf"^{key}:.*\n", "", block, flags=re.M)


def split_fm(src: str):
    m = re.match(r"^---\n([\s\S]*?)\n---\n?([\s\S]*)$", src)
    if not m:
        return None
    return m.group(1), m.group(2)


def download(url: str, dest: Path) -> int:
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": "Mozilla/5.0 (compatible; bookshelf-cover-restore/1.0)",
            "Accept": "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
            "Referer": "https://app.thestorygraph.com/",
        },
    )
    with urllib.request.urlopen(req, timeout=30) as res:
        data = res.read()
    if len(data) < 1000:
        raise RuntimeError(f"too small ({len(data)}b)")
    tmp = dest.with_suffix(dest.suffix + ".tmp")
    tmp.write_bytes(data)
    tmp.replace(dest)
    return len(data)


scraped = json.loads(JSON_PATH.read_text())
by_norm: dict[str, list] = {}
for b in scraped:
    key = normalize(b.get("title"))
    if not key or not b.get("cover"):
        continue
    by_norm.setdefault(key, []).append(b)


def find_sg(title: str):
    key = normalize(title)
    if key in by_norm:
        return by_norm[key][0]
    for k, lst in by_norm.items():
        if titles_match(key, k):
            return lst[0]
    return None


files = sorted(BOOKS_DIR.glob("*.md"))
ok = miss = fail = 0
missing: list[str] = []

print(f"Restoring {len(files)} covers from StoryGraph scrape ({len(scraped)} entries)…\n")

for path in files:
    src = path.read_text(encoding="utf-8")
    parts = split_fm(src)
    if not parts:
        print(f"skip {path.name}")
        continue
    block, body = parts
    title = get_field(block, "title") or path.stem
    cover = get_field(block, "cover")
    sg = find_sg(title)
    if not sg or not sg.get("cover"):
        miss += 1
        missing.append(title)
        print(f"MISS  {title}")
        continue

    if cover and cover.startswith("/covers/bookshelf/"):
        dest = ROOT / "public" / cover.lstrip("/")
    else:
        dest = COVER_DIR / f"{path.stem}.jpg"

    try:
        bytes_ = download(sg["cover"], dest)
        cover_path = f"/covers/bookshelf/{dest.name}"
        block = set_field(block, "cover", cover_path)
        block = remove_field(block, "coverColor")
        path.write_text(f"---\n{block}\n---\n{body}", encoding="utf-8")
        ok += 1
        print(f"OK    {title}  ({bytes_ / 1024:.0f}kb)")
    except Exception as e:
        fail += 1
        print(f"FAIL  {title}  {e}")

print(f"\nDone: {ok} restored, {miss} unmatched, {fail} failed.")
if missing:
    print("Unmatched titles:")
    for t in missing:
        print(f"  - {t}")
