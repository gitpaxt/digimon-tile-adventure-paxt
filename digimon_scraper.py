#!/usr/bin/env python3
"""
Digimon scraper for wikimon.net.

Two-stage pipeline:
  1. Parse "Visual List of Digimon" (HTML) to get every Digimon's canonical
     (Japanese-convention) name, wiki slug and icon thumbnail URL. This also
     builds the whitelist of known Digimon names used to validate/clean the
     "evolves from" / "evolves to" data in stage 2 (the wiki's evolution
     lists include noise like "Any Adventure Lv.2 Digimon from the Digimon
     Card Game", which are not real Digimon and get filtered out).
  2. Pull each Digimon's raw wikitext via the MediaWiki API (api.php),
     batching up to 50 titles per request, and parse the `{{S2|...}}`
     infobox template for level, attribute (Vaccine/Data/Virus/...), English
     dub name, and the "Evolves From" / "Evolves To" lists.

Respects robots.txt: Disallow /Special: and /index.php?, Crawl-delay: 60.
api.php is not disallowed, and batching 50 titles/request keeps total
requests low enough that a 60s delay is actually practical (~1600 Digimon
=> ~35 API requests => well under an hour). Use --delay to override for
personal/one-off use; default stays at 60s to honor the site's stated policy.
"""
import argparse
import json
import re
import sys
import time
import unicodedata
import urllib.parse
import urllib.request
from pathlib import Path

BASE = "https://wikimon.net"
API = BASE + "/api.php"
USER_AGENT = "Mozilla/5.0 (compatible; PersonalDigimonProject/1.0; contact: personal use, low-volume)"

# Wikimon (and the Digimon franchise generally) label evolution stages with
# Japanese-convention terms; English dub fandom uses different names for the
# same stages. Source: https://wikimon.net/Evolution_Stage
LEVEL_EN_DUB = {
    "Digitama": "Digi-Egg",
    "Baby I": "Baby I / Fresh / In-Training I",
    "Baby II": "Baby II / In-Training / In-Training II",
    "Child": "Rookie",
    "Adult": "Champion",
    "Perfect": "Ultimate",
    "Ultimate": "Mega",
    "Super Ultimate": "Ultra / Super Ultimate",
    "Armor": "Armor",
    "Hybrid": "Hybrid",
}
LEVEL_ORDER = {
    "Digitama": 0, "Baby I": 1, "Baby II": 2, "Child": 3, "Adult": 4,
    "Perfect": 5, "Ultimate": 6, "Super Ultimate": 7,
}

NO_DATA_VALUES = {"", "none", "no data", "unknown", "n/a", "-"}


def log(*a):
    print(*a, file=sys.stderr, flush=True)


class RateLimiter:
    def __init__(self, delay):
        self.delay = delay
        self._last = 0.0

    def wait(self):
        now = time.monotonic()
        remaining = self.delay - (now - self._last)
        if remaining > 0:
            time.sleep(remaining)
        self._last = time.monotonic()


def http_get(url, rl):
    rl.wait()
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=30) as resp:
        return resp.read()


# ---------------------------------------------------------------------------
# Stage 1: Visual List of Digimon -> master list of {name, slug, image_url}
# ---------------------------------------------------------------------------

BLOCK_RE = re.compile(
    r'<table style="text-align: center; width: 130px[^"]*">.*?'
    r'<a href="(?P<href>/[^"]+)" title="(?P<title>[^"]+)"><img[^>]*?src="(?P<src>[^"]+)"',
    re.S,
)


def fetch_visual_list(cache_dir, rl, force=False):
    cache_file = cache_dir / "visual_list.html"
    if force or not cache_file.exists():
        log("Fetching Visual List of Digimon ...")
        data = http_get(BASE + "/Visual_List_of_Digimon", rl)
        cache_file.write_bytes(data)
    html = cache_file.read_text(encoding="utf-8")

    entries = []
    seen_slugs = set()
    for m in BLOCK_RE.finditer(html):
        # Derive the name from the href (percent-encoded, cleanly decodable)
        # rather than the title="" attribute: the latter is HTML-entity
        # escaped (quotes/apostrophes show up as &quot;/&#39;) and in a
        # handful of cases carries stray zero-width Unicode marks, both of
        # which make the name fail to resolve against the MediaWiki API.
        href_raw = m.group("href").lstrip("/")
        name = urllib.parse.unquote(href_raw).replace("_", " ")
        name = "".join(c for c in name if unicodedata.category(c) != "Cf")
        src = m.group("src")
        if src.startswith("/"):
            src = BASE + src
        if name in seen_slugs:
            continue
        seen_slugs.add(name)
        entries.append({"slug": href_raw, "name": name, "icon_url": src})
    log(f"Visual list: {len(entries)} Digimon entries found.")
    return entries


# ---------------------------------------------------------------------------
# Stage 2: per-Digimon wikitext via MediaWiki API
# ---------------------------------------------------------------------------

def extract_balanced_template(content, start_idx):
    depth = 0
    i = start_idx
    n = len(content)
    while i < n - 1:
        two = content[i:i + 2]
        if two == "{{":
            depth += 1
            i += 2
            continue
        if two == "}}":
            depth -= 1
            i += 2
            if depth == 0:
                return content[start_idx:i]
            continue
        i += 1
    return content[start_idx:]


FIELD_RE = re.compile(r"\n\|([A-Za-z]+\d*)=([^\n]*)")
WIKILINK_LINE_RE = re.compile(r"^\*\s*('''?)?\[\[([^\]|]+)(?:\|[^\]]*)?\]\]'''?")
REF_TAG_RE = re.compile(r"<ref[^>]*/>|<ref[^>]*>.*?</ref>", re.S)
SIMPLE_TEMPLATE_RE = re.compile(r"\{\{[^{}]*\}\}")


def clean_field(value):
    """Some wikitext fields (esp. `dub=`) have citation refs/templates appended
    inline with no newline separator, e.g. 'Aegisdramon{{DD|a|x}}<ref>...</ref>'."""
    if not value:
        return None
    value = REF_TAG_RE.sub("", value)
    value = SIMPLE_TEMPLATE_RE.sub("", value)
    value = value.strip()
    return value or None


def parse_evo_section(body, heading):
    """Extract the bullet list under '==<heading>==' up to the next '=' line."""
    m = re.search(r"==\s*" + re.escape(heading) + r"\s*==\n(.*?)(?:\n=|\Z)", body, re.S)
    if not m:
        return []
    out = []
    for line in m.group(1).split("\n"):
        lm = WIKILINK_LINE_RE.match(line.strip())
        if not lm:
            continue
        primary = bool(lm.group(1))
        name = lm.group(2).strip()
        out.append({"name": name, "primary": primary})
    return out


def parse_digimon_wikitext(title, content):
    idx = content.find("{{S2")
    if idx == -1:
        idx = content.find("{{S3")  # fallback, seen on some non-Digimon pages
    if idx == -1:
        return None
    block = extract_balanced_template(content, idx)

    fields = {}
    for fm in FIELD_RE.finditer(block):
        key, val = fm.group(1), fm.group(2).strip()
        fields.setdefault(key, val)

    def first_present(prefix, limit=6):
        for i in range(1, limit + 1):
            v = fields.get(f"{prefix}{i}")
            if v is not None and v.strip().lower() not in NO_DATA_VALUES:
                return v.strip()
        return None

    level_raw = first_present("l")
    attribute = first_present("a")
    species_type = first_present("t")
    dub_name = clean_field(fields.get("dub"))
    kanji = clean_field(fields.get("kan"))
    romaji = clean_field(fields.get("rom"))

    evolves_from = parse_evo_section(content, "Evolves From")
    evolves_to = parse_evo_section(content, "Evolves To")

    return {
        "name": title,
        "dub_name": dub_name,
        "kanji": kanji,
        "romaji": romaji,
        "level_jp": level_raw,
        "level_en": LEVEL_EN_DUB.get(level_raw) if level_raw else None,
        "level_order": LEVEL_ORDER.get(level_raw),
        "attribute": attribute,
        "species_type": species_type,
        "evolves_from_raw": evolves_from,
        "evolves_to_raw": evolves_to,
    }


def fetch_wikitext_batch(titles, rl):
    joined = "|".join(titles)
    url = (
        API + "?action=query&prop=revisions&rvprop=content&rvslots=main"
        "&redirects=1&format=json&titles=" + urllib.parse.quote(joined)
    )
    raw = http_get(url, rl)
    data = json.loads(raw)
    query = data.get("query", {})
    pages = query.get("pages", {})

    # some titles from the visual list are redirects (e.g. "Gargamon" ->
    # "Gaagamon"); without following them the page has no revisions. Map
    # the redirect target's content back onto the originally-requested title.
    redirect_from = {r["to"]: r["from"] for r in query.get("redirects", [])}

    out = {}
    for _, p in pages.items():
        t = p.get("title")
        revs = p.get("revisions")
        if not revs:
            out[t] = None
            continue
        content = revs[0]["slots"]["main"]["*"]
        out[t] = content
        orig = redirect_from.get(t)
        if orig:
            out[orig] = content
    return out


def chunked(seq, n):
    for i in range(0, len(seq), n):
        yield seq[i:i + n]


# ---------------------------------------------------------------------------
# Validation of evolution links against the master whitelist
# ---------------------------------------------------------------------------

def build_whitelist(entries):
    names = {e["name"] for e in entries}
    names.add("Digitama")  # the Digi-Egg "origin" for Baby I forms; not a monster but a valid answer
    return names


def clean_evo_list(raw_list, whitelist):
    cleaned = []
    for item in raw_list:
        if item["name"] in whitelist:
            cleaned.append(item)
    return cleaned


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser(description="Scrape Digimon icons/levels/attributes/evolutions from wikimon.net")
    ap.add_argument("--out", default="digimon_data.json", help="output JSON path")
    ap.add_argument("--csv", default=None, help="optional CSV output path")
    ap.add_argument("--cache-dir", default="wikimon_cache", help="directory for cached HTTP responses")
    ap.add_argument("--delay", type=float, default=60.0,
                     help="seconds between HTTP requests (site's robots.txt specifies Crawl-delay: 60)")
    ap.add_argument("--limit", type=int, default=None, help="only process the first N Digimon (for testing)")
    ap.add_argument("--batch-size", type=int, default=50, help="titles per API request (MediaWiki default cap)")
    ap.add_argument("--refresh-list", action="store_true", help="re-download the visual list even if cached")
    args = ap.parse_args()

    cache_dir = Path(args.cache_dir)
    cache_dir.mkdir(parents=True, exist_ok=True)
    rl = RateLimiter(args.delay)

    entries = fetch_visual_list(cache_dir, rl, force=args.refresh_list)
    whitelist = build_whitelist(entries)

    if args.limit:
        entries = entries[:args.limit]

    by_name = {e["name"]: e for e in entries}
    titles = [e["name"] for e in entries]

    detail_cache_file = cache_dir / "wikitext_cache.json"
    wikitext_cache = {}
    if detail_cache_file.exists():
        wikitext_cache = json.loads(detail_cache_file.read_text(encoding="utf-8"))

    to_fetch = [t for t in titles if t not in wikitext_cache]
    log(f"{len(titles)} total, {len(to_fetch)} need fetching "
        f"(delay={args.delay}s, batch={args.batch_size} -> "
        f"~{max(1, -(-len(to_fetch)//args.batch_size))} requests, "
        f"~{max(1, -(-len(to_fetch)//args.batch_size)) * args.delay:.0f}s)")

    for batch_num, batch in enumerate(chunked(to_fetch, args.batch_size), 1):
        log(f"  batch {batch_num}: fetching {len(batch)} pages ...")
        try:
            result = fetch_wikitext_batch(batch, rl)
        except Exception as e:
            log(f"  ERROR fetching batch {batch_num}: {e}")
            continue
        wikitext_cache.update(result)
        detail_cache_file.write_text(json.dumps(wikitext_cache, ensure_ascii=False), encoding="utf-8")

    results = []
    missing = []
    for name in titles:
        entry = by_name[name]
        content = wikitext_cache.get(name)
        if not content:
            missing.append(name)
            results.append({
                "name": name, "english_name": name, "icon_url": entry["icon_url"], "slug": entry["slug"],
                "dub_name": None, "level_jp": None, "level_en": None, "level_order": None,
                "attribute": None, "species_type": None,
                "evolves_from": [], "evolves_to": [], "parse_error": "no wikitext",
            })
            continue
        parsed = parse_digimon_wikitext(name, content)
        if parsed is None:
            missing.append(name)
            results.append({
                "name": name, "english_name": name, "icon_url": entry["icon_url"], "slug": entry["slug"],
                "dub_name": None, "level_jp": None, "level_en": None, "level_order": None,
                "attribute": None, "species_type": None,
                "evolves_from": [], "evolves_to": [], "parse_error": "no S2 template found",
            })
            continue

        evolves_from = clean_evo_list(parsed["evolves_from_raw"], whitelist)
        evolves_to = clean_evo_list(parsed["evolves_to_raw"], whitelist)

        results.append({
            "name": name,
            # Wikimon omits `dub=` when the English dub name is identical to
            # the Japanese-convention name, so fall back to `name` here to
            # always have a usable English label.
            "english_name": parsed["dub_name"] or name,
            "icon_url": entry["icon_url"],
            "slug": entry["slug"],
            "dub_name": parsed["dub_name"],
            "kanji": parsed["kanji"],
            "romaji": parsed["romaji"],
            "level_jp": parsed["level_jp"],
            "level_en": parsed["level_en"],
            "level_order": parsed["level_order"],
            "attribute": parsed["attribute"],
            "species_type": parsed["species_type"],
            "evolves_from": evolves_from,
            "evolves_to": evolves_to,
        })

    Path(args.out).write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8")
    log(f"Wrote {len(results)} Digimon to {args.out}")
    if missing:
        log(f"{len(missing)} entries had no parseable infobox (kept with nulls): "
            f"{', '.join(missing[:15])}{' ...' if len(missing) > 15 else ''}")

    if args.csv:
        import csv
        with open(args.csv, "w", newline="", encoding="utf-8") as f:
            w = csv.writer(f)
            w.writerow(["name", "english_name", "dub_name", "level_jp", "level_en", "attribute",
                        "species_type", "evolves_from", "evolves_to", "icon_url"])
            for r in results:
                w.writerow([
                    r["name"], r.get("english_name"), r.get("dub_name"), r.get("level_jp"), r.get("level_en"),
                    r.get("attribute"), r.get("species_type"),
                    "; ".join(e["name"] for e in r["evolves_from"]),
                    "; ".join(e["name"] for e in r["evolves_to"]),
                    r["icon_url"],
                ])
        log(f"Wrote CSV to {args.csv}")


if __name__ == "__main__":
    main()
