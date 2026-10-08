#!/usr/bin/env python3
"""
Download the Digimon icon thumbnails referenced in the Visual List of Digimon.

Images are static assets served by MediaWiki's thumb handler (already
pre-rendered on disk server-side), which is a much lighter operation for the
server than rendering a wiki page — so unlike the per-page data scrape (which
honors the site's Crawl-delay: 60 from robots.txt), this uses a modest fixed
delay instead of the full 60s. Still resumable/cacheable: existing files are
skipped on re-run.
"""
import argparse
import time
import urllib.request
from pathlib import Path

from digimon_scraper import fetch_visual_list, RateLimiter, USER_AGENT


def safe_filename(name, ext):
    # avoid ':' and other characters that are invalid on Windows filesystems,
    # since these icons will likely end up imported into a game engine project
    keep = "".join(c if c.isalnum() or c in " ()_-." else "_" for c in name)
    return keep.strip() + ext


def main():
    ap = argparse.ArgumentParser(description="Download Digimon icon thumbnails")
    ap.add_argument("--cache-dir", default="wikimon_cache")
    ap.add_argument("--out-dir", default="digimon_icons")
    ap.add_argument("--delay", type=float, default=0.4,
                     help="seconds between image requests (static assets, lighter than page renders)")
    ap.add_argument("--limit", type=int, default=None)
    args = ap.parse_args()

    cache_dir = Path(args.cache_dir)
    cache_dir.mkdir(parents=True, exist_ok=True)
    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    rl_list = RateLimiter(60.0)  # only matters if visual_list.html isn't cached yet
    entries = fetch_visual_list(cache_dir, rl_list)
    if args.limit:
        entries = entries[:args.limit]

    rl = RateLimiter(args.delay)
    ok, skipped, failed = 0, 0, []
    manifest = []

    for i, e in enumerate(entries, 1):
        url = e["icon_url"]
        ext = Path(url).suffix or ".jpg"
        fname = safe_filename(e["name"], ext)
        dest = out_dir / fname
        manifest.append({"name": e["name"], "slug": e["slug"], "file": fname, "icon_url": url})

        if dest.exists() and dest.stat().st_size > 0:
            skipped += 1
            continue

        rl.wait()
        try:
            req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
            with urllib.request.urlopen(req, timeout=30) as resp:
                dest.write_bytes(resp.read())
            ok += 1
        except Exception as ex:
            failed.append((e["name"], str(ex)))

        if i % 50 == 0 or i == len(entries):
            print(f"[{i}/{len(entries)}] downloaded={ok} skipped(cached)={skipped} failed={len(failed)}", flush=True)

    import json
    (out_dir / "_manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")

    print(f"Done. downloaded={ok} skipped(cached)={skipped} failed={len(failed)}")
    if failed:
        print("Failed downloads:")
        for name, err in failed[:20]:
            print(f"  {name}: {err}")
        if len(failed) > 20:
            print(f"  ... and {len(failed) - 20} more")


if __name__ == "__main__":
    main()
