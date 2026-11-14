"""Generate the data-driven parts of the Canopy site from spreadsheet rows.

Usage: python make_site_content.py <rows_csv> <master_csv> <site_dir> <base_url>

Writes, inside <site_dir>:
  canopy.yml                         collection address, facets, featured works, theme
  content/collections/<slug>.mdx     one page per section, listing its works
  app/data/sections.json             section cards for the home and collections pages
  app/data/site.json                 the public address of the file bucket's web/ folder

Hand-written pages (home, about, layouts, styles) are not touched.
"""
import csv
import json
import sys
from pathlib import Path

rows_csv, master_csv, site, base = sys.argv[1], sys.argv[2], Path(sys.argv[3]), sys.argv[4].rstrip("/")

SECTIONS = [  # (name in the spreadsheet, page slug, short label)
    ("Image Gallery", "image-gallery", "Image Gallery"),
    ("Erotic Magazines", "erotic-magazines", "Erotic Magazines"),
    ("Erotic Novelettes", "erotic-novelettes", "Erotic Novelettes"),
    ("Essays on Sexuality, Sexology, and Eugenics", "essays", "Essays"),
    ("Nudism & Naturism", "nudism-and-naturism", "Nudism & Naturism"),
]


def read_csv(path):
    with open(path, encoding="utf-8-sig", newline="") as fh:
        return list(csv.DictReader(fh))


def manifest(row):
    return f"{base}/iiif/{row['objectid']}/manifest.json"


rows = read_csv(rows_csv)
totals = {}
for r in read_csv(master_csv):
    if not r["parentid"]:
        totals[r["section"]] = totals.get(r["section"], 0) + 1

# The home page rotates through these. Magazine covers are the default; the
# project team should choose the final set.
featured = [r for r in rows if r["section"] in ("Erotic Magazines", "Nudism & Naturism")][:6]
# Image tags become search filters once any published picture has them.
tag_facets = ["Image type", "Figures", "Dress", "Themes", "Colour"] if any(r.get("tag_type") for r in rows) else []
canopy_yml = f"""title: Sicalipsis
collection:
  - {base}/iiif/collection.json
metadata:
  - Section
  - Series
  - Subject
  - Creator
  - Year
  - Type
{''.join(f'  - {name}' + chr(10) for name in tag_facets)}featured:
{''.join(f'  - {manifest(r)}' + chr(10) for r in featured)}search:
  page:
    title: Search
    description: Search the whole collection.
  results:
    work:
      layout: grid
      result: figure
    page:
      layout: list
      result: article
  index:
    metadata:
      enabled: true
      all: true
    summary:
      enabled: true
    annotations:
      enabled: false
theme:
  appearance: dark
  accentColor: amber
  grayColor: sand
"""
(site / "canopy.yml").write_text(canopy_yml, encoding="utf-8", newline="\n")

cards = []
(site / "content" / "collections").mkdir(parents=True, exist_ok=True)
for name, slug, label in SECTIONS:
    members = [r for r in rows if r["section"] == name]
    if not members:
        continue
    members.sort(key=lambda r: (r["series"], r["date"] or "9999", r["title"]))
    total = totals.get(name, len(members))
    shown = (f"{len(members)} of {total} items are in this preview."
             if len(members) < total else f"{total} items.")
    page = f"""---
title: {json.dumps(name, ensure_ascii=False)}
description: {json.dumps(f"{name} in the Sicalipsis collection.", ensure_ascii=False)}
referencedManifests:
{''.join(f'  - {manifest(r)}' + chr(10) for r in members)}---

<Container variant="wide">

<header className="sic-page-header">
  <p className="sic-eyebrow">Collection</p>
  <h1>{name}</h1>
  <p className="sic-count">{shown}</p>
</header>

<ReferencedItems />

</Container>
"""
    (site / "content" / "collections" / f"{slug}.mdx").write_text(page, encoding="utf-8", newline="\n")
    cover = members[0]
    cards.append({
        "name": name, "label": label, "href": f"/collections/{slug}",
        "count": total, "preview": len(members),
        "image": f"{base}/images/{cover['objectid']}/thumb.jpg",
    })

(site / "app" / "data").mkdir(parents=True, exist_ok=True)
(site / "app" / "data" / "site.json").write_text(
    json.dumps({"webBase": base}, indent=2), encoding="utf-8")
(site / "app" / "data" / "sections.json").write_text(
    json.dumps(cards, ensure_ascii=False, indent=2), encoding="utf-8", newline="\n")
print(f"canopy.yml, {len(cards)} section pages and sections.json written to {site}")
