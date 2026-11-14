"""Generate the data-driven parts of the Canopy site from spreadsheet rows.

Usage: python make_site_content.py <rows_csv> <master_csv> <site_dir> <base_url> [--exhibits <dir>]

Writes, inside <site_dir>:
  canopy.yml                         collection address, facets, featured works, theme
  content/collections/<slug>.mdx     one page per section
  content/collections/<slug>/*.mdx   the section's pages (a magazine title, a series, an author)
  content/collections/tree.mdx       every section with its pages
  app/data/sections.json             section cards for the home and collections pages
  app/data/site.json                 the public address of the file bucket's web/ folder

With --exhibits <data_dir>/omeka/exhibits the sections are arranged as the
original site arranged them (tools/harvest_exhibits.py): the same pages inside
each section, the same items on each page, in the same order, and the section's
introduction. Published items that the original did not place come last.

Hand-written pages (home, about, layouts, styles) are not touched.
"""
import csv
import json
import re
import shutil
import sys
from pathlib import Path

rows_csv, master_csv, site, base = sys.argv[1], sys.argv[2], Path(sys.argv[3]), sys.argv[4].rstrip("/")
exhibits_dir = Path(sys.argv[sys.argv.index("--exhibits") + 1]) if "--exhibits" in sys.argv else None

SECTIONS = [  # (name in the spreadsheet, page slug, short label)
    ("Image Gallery", "image-gallery", "Image Gallery"),
    ("Erotic Magazines", "erotic-magazines", "Erotic Magazines"),
    ("Erotic Novelettes", "erotic-novelettes", "Erotic Novelettes"),
    ("Essays on Sexuality, Sexology, and Eugenics", "essays", "Essays"),
    ("Genetics, Eugenics & Sexual Pedagogy", "genetics", "Genetics & Eugenics"),
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
{''.join(f'  - {name}' + chr(10) for name in tag_facets)}{'  - Text' + chr(10) if any(r.get('text') for r in rows) else ''}featured:
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
collections_dir = site / "content" / "collections"
collections_dir.mkdir(parents=True, exist_ok=True)


def thumb(row):
    return f"{base}/images/{row['objectid']}/thumb.jpg"


def js(value):
    """A value written into an MDX page as a JavaScript literal."""
    return json.dumps(value, ensure_ascii=False)


def paragraphs(text):
    return "\n\n".join(f"<p>{{{js(line)}}}</p>" for line in text.split("\n") if line.strip() and line.strip() != "Save")


def write_page(path, title, description, members, body):
    path.parent.mkdir(parents=True, exist_ok=True)
    works = "referencedManifests:\n" + "".join(f"  - {manifest(r)}\n" for r in members) if members else ""
    path.write_text(f"""---
title: {js(title)}
description: {js(description)}
{works}---

<Container variant="wide">

{body}

</Container>
""", encoding="utf-8", newline="\n")


def header(eyebrow, title, count, back=None):
    link = f'\n  <PageCards variant="nav" items={{{js([back])}}} />' if back else ""
    return f"""<header className="sic-page-header">{link}
  <p className="sic-eyebrow">{eyebrow}</p>
  <h1>{{{js(title)}}}</h1>
  <p className="sic-count">{count}</p>
</header>"""


# The original site's arrangement (tools/harvest_exhibits.py): which pages each
# section had, and which items stood on each page, in order. Pages that only
# continued the one before ("La Saeta (p. 2)") are joined to it.
arrangement = {}
if exhibits_dir and (exhibits_dir / "exhibits.json").exists():
    by_item = {r["omeka_item_id"]: r for r in rows if r["omeka_item_id"]}
    for exhibit in json.loads((exhibits_dir / "exhibits.json").read_text(encoding="utf-8")):
        pages = []
        for page in exhibit["pages"]:
            continued = re.match(r"^(.*) \(p\. \d+\)$", page["title"])
            members = [by_item[str(i)] for i in page["items"] if str(i) in by_item]
            if continued and pages and pages[-1]["title"] == continued.group(1):
                pages[-1]["members"] += members
            else:
                pages.append({"title": page["title"], "slug": page["path"].rstrip("/").rsplit("/", 1)[-1],
                              "members": members})
        arrangement[exhibit["menu_title"]] = {"intro": exhibit["intro_text"], "pages": pages}

tree = []
for name, slug, label in SECTIONS:
    members = [r for r in rows if r["section"] == name]
    if not members:
        continue
    members.sort(key=lambda r: (r["series"], r["date"] or "9999", r["title"]))
    in_section = {r["objectid"] for r in members}
    total = totals.get(name, len(members))
    shown = (f"{len(members)} of {total} items are shown so far."
             if len(members) < total else f"{total} items.")
    shutil.rmtree(collections_dir / slug, ignore_errors=True)       # pages written by an earlier run
    arranged = arrangement.get(name)
    intro = paragraphs(arranged["intro"]) if arranged else ""
    search = f"<CollectionSearch section={{{js(name)}}} />"
    pages, seen = [], set()
    for page in (arranged["pages"] if arranged else []):
        kept = []
        for r in page["members"]:          # an item keeps its first place only
            if r["objectid"] in in_section and r["objectid"] not in seen:
                seen.add(r["objectid"])
                kept.append(r)
        if kept:
            pages.append({**page, "members": kept})
    extra = [r for r in members if r["objectid"] not in seen]
    paginated = bool(pages) and all(re.match(r"^Page \d+$", p["title"]) for p in pages)
    if not pages or paginated:
        # One page: the original's order where it had one (its "Page 1 ... Page n"), then the rest.
        ordered = [r for p in pages for r in p["members"]] + extra if pages else members
        write_page(collections_dir / f"{slug}.mdx", name, f"{name} in the Sicalipsis collection.", ordered,
                   f"{header('Collection', name, shown)}\n\n{intro}\n\n{search}\n\n<ReferencedItems />")
        cover = ordered[0]
        tree.append((name, slug, []))
    else:
        if extra:
            pages.append({"title": "Additional items", "slug": "additional", "members": extra,
                          "note": "Items of this collection that were not on a page of the original site."})
        links = [{"title": p["title"], "href": f"/collections/{slug}/{p['slug']}", "count": len(p["members"]),
                  "image": thumb(p["members"][0])} for p in pages]
        write_page(collections_dir / f"{slug}.mdx", name, f"{name} in the Sicalipsis collection.", [],
                   f"{header('Collection', name, shown)}\n\n{intro}\n\n{search}\n\n"
                   f"<PageCards items={{{js(links)}}} />")
        for n, page in enumerate(pages):
            around = []
            if n > 0:
                around.append({"title": pages[n - 1]["title"], "href": links[n - 1]["href"], "note": "Previous"})
            if n + 1 < len(pages):
                around.append({"title": pages[n + 1]["title"], "href": links[n + 1]["href"], "note": "Next"})
            count = "1 item." if len(page["members"]) == 1 else f"{len(page['members'])} items."
            note = f"\n\n<p>{{{js(page['note'])}}}</p>" if page.get("note") else ""
            back = {"title": name, "href": f"/collections/{slug}", "note": "Back to"}
            write_page(collections_dir / slug / f"{page['slug']}.mdx", f"{page['title']} · {label}",
                       f"{page['title']}, in {name}.", page["members"],
                       f"{header(label, page['title'], count, back)}{note}\n\n{search}\n\n<ReferencedItems />\n\n"
                       f'<PageCards variant="nav" items={{{js(around)}}} />')
        cover = pages[0]["members"][0]
        tree.append((name, slug, links))
    cards.append({
        "name": name, "label": label, "href": f"/collections/{slug}",
        "count": total, "preview": len(members), "image": thumb(cover),
    })

# The collection tree: every section with its pages.
body = ['<header className="sic-page-header">\n  <p className="sic-eyebrow">Sicalipsis</p>\n  <h1>Collection tree</h1>\n</header>']
for name, slug, links in tree:
    top = [{"title": name, "href": f"/collections/{slug}"}]
    body.append(f'<div className="sic-tree__section"><PageCards variant="list" items={{{js(top)}}} /></div>')
    if links:
        inner = [{k: link[k] for k in ("title", "href", "count")} for link in links]
        body.append(f'<PageCards variant="list" items={{{js(inner)}}} />')
write_page(collections_dir / "tree.mdx", "Collection tree", "Every section of the collection with its series and authors.",
           [], "\n\n".join(body))

(site / "app" / "data").mkdir(parents=True, exist_ok=True)
(site / "app" / "data" / "site.json").write_text(
    json.dumps({"webBase": base}, indent=2), encoding="utf-8")
(site / "app" / "data" / "sections.json").write_text(
    json.dumps(cards, ensure_ascii=False, indent=2), encoding="utf-8", newline="\n")
print(f"canopy.yml, {len(cards)} section pages, {sum(len(links) for _, _, links in tree)} pages inside them "
      f"and sections.json written to {site}")
