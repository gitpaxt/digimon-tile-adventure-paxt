#!/usr/bin/env python3
"""One-time (re-runnable) data-prep pipeline, built on request to make it
easy to hand-edit who evolves into whom, without wading through the full
scraped Wikimon dataset.

Stage 1 - extract a minimal file from the raw scrape:
  game/data/digimon_data.json -> game/data/my_digimon_data_nogiga.json
  Keeps only: name, kanji (Japanese name), attribute, level_jp (Japanese
  level, untouched), icon_url, and evolves_to (just the plain list of
  target names this Digimon can evolve into, one line each).

Stage 2 - reclassify mega-tier (level_jp "Ultimate") entries using
  evolves_to as the single source of truth (NOT evolves_from):
    - A "mega" that evolves FROM another "mega" (i.e. some parent whose
      own evolves_to lists it) becomes "giga".
    - A "mega" that evolves from a "giga" becomes "tera".
    - A "mega" that evolves from a "tera" becomes "peta".
    - Each pass snapshots the previous tier's membership before mutating,
      so a 3-long chain cascades correctly across passes. Stops at peta —
      no further tier.
  Every entry that was never "Ultimate" keeps its original Japanese
  level_jp untouched. Result is written to game/data/my_digimon_data.json
  with the (possibly reclassified) level stored as "level" — English
  (mega/giga/tera/peta) for what was Ultimate, untouched Japanese for
  everything else.

Run with: python3 build_my_digimon_data.py

NOTE: the game itself never reads my_digimon_data.json — it reads
game/data/my_official_digimon_data.json, a one-time copy of this script's
output that you then hand-edit directly. This script never writes to that
file, so re-running it can never clobber your edits. To pull a fresh
pipeline run into the game, copy my_digimon_data.json over
my_official_digimon_data.json yourself.
"""
import json
import re
from pathlib import Path

ROOT = Path(__file__).parent
SRC = ROOT / "game" / "data" / "digimon_data.json"
NOGIGA_OUT = ROOT / "game" / "data" / "my_digimon_data_nogiga.json"
FINAL_OUT = ROOT / "game" / "data" / "my_digimon_data.json"

LEVEL_JP_TO_STAGE = {
    "Baby I": "baby1",
    "Baby II": "baby2",
    "Child": "rookie",
    "Adult": "champion",
    "Perfect": "ultimate",
    "Ultimate": "mega",
}


def dump_with_oneline_evolves_to(entries):
    """json.dumps with indent=2, except every "evolves_to" array is
    collapsed onto a single line (so it's easy to scan/hand-edit)."""
    text = json.dumps(entries, indent=2, ensure_ascii=False)

    def collapse(match):
        inner = match.group(1)
        names = re.findall(r'"((?:[^"\\]|\\.)*)"', inner)
        joined = ", ".join(f'"{n}"' for n in names)
        return f'"evolves_to": [{joined}]'

    return re.sub(r'"evolves_to":\s*\[(.*?)\]', collapse, text, flags=re.DOTALL)


def main():
    raw = json.loads(SRC.read_text(encoding="utf-8"))

    # --- Stage 1: minimal nogiga extract ---------------------------------
    nogiga = []
    for e in raw:
        nogiga.append({
            # "name" is the Japanese-origin name (e.g. "Omegamon") — the
            # canonical identifier, also what evolves_to/evolves_from
            # reference. "english_name" is the English dub name (e.g.
            # "Omnimon") — display-only, never used as a lookup key.
            "name": e.get("name"),
            "english_name": e.get("english_name"),
            "attribute": e.get("attribute"),
            "level_jp": e.get("level_jp"),
            "icon_url": e.get("icon_url"),
            "evolves_to": [c["name"] for c in (e.get("evolves_to") or [])],
        })
    NOGIGA_OUT.write_text(dump_with_oneline_evolves_to(nogiga) + "\n", encoding="utf-8")
    print(f"Wrote {NOGIGA_OUT} ({len(nogiga)} entries)")

    # --- Stage 2: mega -> giga -> tera -> peta, via evolves_to only ------
    stage_of = {e["name"]: LEVEL_JP_TO_STAGE.get(e["level_jp"]) for e in nogiga}
    parents_by_child = {}
    for e in nogiga:
        for child in e["evolves_to"]:
            parents_by_child.setdefault(child, []).append(e["name"])

    def names_with_stage(stage):
        return {n for n, s in stage_of.items() if s == stage}

    def promote(from_tier, to_tier):
        tier_set = names_with_stage(from_tier)
        for name, s in list(stage_of.items()):
            if s != "mega":
                continue  # only still-unpromoted "mega" entries are candidates
            if any(p in tier_set for p in parents_by_child.get(name, [])):
                stage_of[name] = to_tier

    promote("mega", "giga")   # mega evolving from mega -> giga
    promote("giga", "tera")   # mega evolving from giga -> tera
    promote("tera", "peta")   # mega evolving from tera -> peta
    # Stops here, per spec — no tier beyond peta.

    final = []
    for e in nogiga:
        s = stage_of[e["name"]]
        level = s if s in ("mega", "giga", "tera", "peta") else e["level_jp"]
        final.append({
            "name": e["name"],
            "english_name": e["english_name"],
            "attribute": e["attribute"],
            "level": level,
            "icon_url": e["icon_url"],
            "evolves_to": e["evolves_to"],
        })
    FINAL_OUT.write_text(dump_with_oneline_evolves_to(final) + "\n", encoding="utf-8")
    print(f"Wrote {FINAL_OUT} ({len(final)} entries)")

    from collections import Counter
    counts = Counter(stage_of.values())
    print("Reclassification counts (mega-tier only):",
          {k: v for k, v in counts.items() if k in ("mega", "giga", "tera", "peta")})


if __name__ == "__main__":
    main()
