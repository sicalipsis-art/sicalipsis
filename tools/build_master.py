"""Build the master metadata spreadsheet in CollectionBuilder-CSV format.

Usage: python build_master.py <data_dir> <out_csv>

One row per object. Omeka items keep their Omeka metadata; the file comes from
Box when Box has an identical copy or an OCR'd version, otherwise it is marked
as only on the Omeka server. Box material that Omeka never had is appended:
extra PDFs and gallery images as new objects, novelette page images as children
(parentid) of their novelette. Inventory spreadsheets are left out.

box_path and r2_key keep the exact characters Box uses (some accents are stored
in decomposed form), so they match the stored objects byte for byte.

The URL columns (object_location, image_small, image_thumb) stay empty until the
file store has a public address; r2_key says where each file is in the bucket.
"""
import csv
import re
import sys
import unicodedata
from collections import Counter
from difflib import SequenceMatcher
from pathlib import Path

data = Path(sys.argv[1])
out_csv = Path(sys.argv[2])
rec = data / "reconciliation"

COLUMNS = [
    "objectid", "parentid", "title", "creator", "date", "date_original", "date_basis",
    "description", "subject", "publisher", "contributor", "source", "relation",
    "identifier", "type", "format", "section", "series", "collection",
    "display_template", "object_location", "image_small", "image_thumb",
    "file_status", "r2_key", "box_path", "omeka_item_id", "omeka_url", "file_md5",
]

SECTION_OF_COLLECTION = {
    "Image Gallery": "Image Gallery",
    **{c: "Erotic Magazines" for c in
       ["Flirt", "Cosquillas", "KDT", "La Hoja de Parra", "Mundo Galante", "Sexualidad"]},
    **{c: "Erotic Novelettes" for c in
       ["La novela de hoy", "La novela de noche", "La novela sugestiva", "Novelas sueltas",
        "Erotic Novelettes from Varied Collections"]},
    **{c: "Nudism & Naturism" for c in
       ["Pentalfa", "Biofilia", "Nudist Novel", "Essays on Nudism and Naturism"]},
}
ESSAYS = "Essays on Sexuality, Sexology, and Eugenics"
SECTION_OF_BOX = {
    "1. IMAGE GALLERY": "Image Gallery",
    "2. EROTIC MAGAZINES": "Erotic Magazines",
    "3. EROTIC NOVELETTES": "Erotic Novelettes",
    "3. IMAGES EROTIC NOVELETTES": "Erotic Novelettes",
    "4. ESSAYS ON SEXUALITY, SEXOLOGY, AND EUGENICS": ESSAYS,
    "5. NUDISM AND NATURISM": "Nudism & Naturism",
}
SECTION_OF_TAG = {
    "erotic novelette": "Erotic Novelettes", "essays": ESSAYS, "sexology": ESSAYS,
    "nudism & naturism": "Nudism & Naturism", "erotic magazine": "Erotic Magazines",
}
MONTHS = {}
for i, names in enumerate([
    "enero january jan ene", "febrero february feb", "marzo march mar", "abril april apr abr",
    "mayo may", "junio june jun", "julio july jul", "agosto august aug ago",
    "septiembre setiembre september sept sep", "octubre october oct",
    "noviembre november nov", "diciembre december dec dic"], 1):
    for n in names.split():
        MONTHS[n] = i
YEAR = r"(?<!\d)(18[89]\d|19[0-3]\d)(?!\d)"   # collection period, for guesses from titles
ANY_YEAR = r"(?<!\d)(1[89]\d\d|20[0-2]\d)(?!\d)"  # Omeka's own date field


def read_csv(path):
    with open(path, encoding="utf-8-sig", newline="") as fh:
        return list(csv.DictReader(fh))


def nfc(s):
    return unicodedata.normalize("NFC", s)


def clean(s):
    return " ".join(nfc(s or "").split())


def fold(s):
    s = unicodedata.normalize("NFKD", s)
    s = "".join(c for c in s if not unicodedata.combining(c)).lower()
    return re.sub(r"[^a-z0-9]+", " ", s).strip()


def parse_date(text, year_pattern=YEAR):
    """Return an ISO date (yyyy, yyyy-mm or yyyy-mm-dd) or '' when unsure."""
    t = fold(text)
    if not t:
        return ""
    years = re.findall(year_pattern, t)
    if len(set(years)) != 1:
        return ""  # no year, or a range such as 1932/33: leave for a person
    year = years[0]
    words = t.split()
    month = next((MONTHS[w] for w in words if w in MONTHS), None)
    if month is None:
        return year
    days = [int(w) for w in words if w.isdigit() and 1 <= int(w) <= 31 and len(w) <= 2]
    if len(days) == 1:
        return f"{year}-{month:02d}-{days[0]:02d}"
    return f"{year}-{month:02d}"


def year_in(text):
    years = set(re.findall(YEAR, fold(text)))
    return years.pop() if len(years) == 1 else ""


items = read_csv(data / "omeka" / "items.csv")
omeka_files = {f["item_id"]: f for f in read_csv(data / "omeka" / "files.csv")}
box_files = read_csv(rec / "box_files.csv")
box_by_path = {b["box_path"]: b for b in box_files}

identical = {}  # omeka item id -> box path
for b in box_files:
    if b["status"] == "in Omeka":
        for item_id in b["omeka_item_ids"].split(" | "):
            identical.setdefault(item_id, b["box_path"])
titled = {m["omeka_item_id"]: m for m in read_csv(rec / "title_matches.csv")}

rows, object_of_box = [], {}
for it in sorted(items, key=lambda r: int(r["item_id"])):
    iid = it["item_id"]
    f = omeka_files.get(iid)
    objectid = f"sic{int(iid):05d}"
    box_path, status = "", "no file"
    if iid in identical:
        box_path, status = identical[iid], "in Box (identical)"
    elif iid in titled:
        box_path = titled[iid]["box_path"]
        status = "in Box (OCR version)" if titled[iid]["confidence"] == "high" \
            else "in Box (OCR version, unconfirmed)"
    elif f:
        status = "only on Omeka server"
    if box_path:
        object_of_box[box_path] = objectid
    box = box_by_path.get(box_path)
    collection = clean(it["collection_title"])
    section = SECTION_OF_COLLECTION.get(collection) or (ESSAYS if collection else "")
    if not section and box:
        section = SECTION_OF_BOX.get(box["section"], "")
    if not section:
        section = next((SECTION_OF_TAG[t.lower()] for t in it["tags"].split(" | ")
                        if t.lower() in SECTION_OF_TAG), "")
    title = re.sub(r"\.pdf?$", "", clean(it.get("dc_title", "")), flags=re.I)
    date = parse_date(it.get("dc_date", ""), ANY_YEAR)
    basis = "Omeka date field" if date else ""
    if not date and year_in(title):
        date, basis = year_in(title), "year in Omeka title"
    if not date and box and year_in(box["box_path"].rsplit("/", 1)[-1]):
        name = box["box_path"].rsplit("/", 1)[-1].rsplit(".", 1)[0].replace("_", " ")
        date, basis = parse_date(name) or year_in(name), "Box file name"
    ext = (box["ext"] if box else (f["ext"] if f else ""))
    rows.append({
        "objectid": objectid, "title": title or "[Untitled]",
        "creator": clean(it.get("dc_creator", "")), "date": date,
        "date_original": clean(it.get("dc_date", "")), "date_basis": basis,
        "description": clean(it.get("dc_description", "")),
        "subject": "; ".join(x for x in [clean(it.get("dc_subject", "")).replace(" | ", "; "),
                                         clean(it["tags"]).replace(" | ", "; ")] if x),
        "publisher": clean(it.get("dc_publisher", "")),
        "contributor": clean(it.get("dc_contributor", "")),
        "source": clean(it.get("dc_source", "")), "relation": clean(it.get("dc_relation", "")),
        "identifier": clean(it.get("dc_identifier", "")),
        "type": clean(it.get("dc_type", "")) or it["item_type"],
        "format": {"pdf": "application/pdf", "jpg": "image/jpeg"}.get(ext, ""),
        "section": section, "series": nfc(box["series"]) if box and box["series"] else collection,
        "collection": collection,
        "display_template": {"pdf": "pdf", "jpg": "image"}.get(ext, "record"),
        "file_status": status, "r2_key": f"originals/{box_path}" if box_path else "",
        "box_path": box_path, "omeka_item_id": iid, "omeka_url": it["url"],
        "file_md5": box["md5"] if box else (f["omeka_md5"] if f else ""),
    })

# Box material Omeka never had.
novelette_pdfs = [b for b in box_files if b["section"] == "3. EROTIC NOVELETTES" and b["ext"] == "pdf"]
new_rows, children, orphans = [], [], 0
for b in box_files:
    if b["ext"] == "xlsx" or b["box_path"] in object_of_box or b["status"] == "in Omeka":
        continue
    if b["section"] == "3. IMAGES EROTIC NOVELETTES":
        continue  # handled below, once every possible parent has an objectid
    stem = b["box_path"].rsplit("/", 1)[-1].rsplit(".", 1)[0]
    title = stem.split("_", 1)[1] if "_" in stem and b["ext"] == "pdf" else stem
    objectid = f"sicb{b['sha1'][:8]}"
    object_of_box[b["box_path"]] = objectid
    name = stem.replace("_", " ")
    new_rows.append({
        "objectid": objectid, "title": clean(title.replace("_", " ")),
        "date": parse_date(name) or year_in(name),
        "date_basis": "Box file name" if year_in(name) else "",
        "format": {"pdf": "application/pdf", "jpg": "image/jpeg"}[b["ext"]],
        "section": SECTION_OF_BOX[b["section"]], "series": nfc(b["series"]),
        "display_template": {"pdf": "pdf", "jpg": "image"}[b["ext"]],
        "file_status": "in Box (not in Omeka)", "r2_key": f"originals/{b['box_path']}",
        "box_path": b["box_path"], "file_md5": b["md5"],
    })

def squash(text):
    return fold(text).replace(" ", "")


pdf_keys = []  # (full name, title part, box row) for every novelette PDF
for b in novelette_pdfs:
    stem = b["box_path"].rsplit("/", 1)[-1].rsplit(".", 1)[0]
    stem = re.sub(r"_REP$", "", stem)
    pdf_keys.append((squash(stem), squash(stem.split("_", 1)[1] if "_" in stem else stem), b))


def find_parent(work):
    w = squash(work)
    if not w:
        return None
    hits = [b for full, title, b in pdf_keys
            if w in (full, title) or full.endswith(w) or (len(title) >= 6 and w.endswith(title))]
    if not hits:
        scored = sorted(((SequenceMatcher(None, w, title).ratio(), b) for _, title, b in pdf_keys),
                        key=lambda x: -x[0])
        if scored and scored[0][0] >= 0.85 and (len(scored) == 1 or scored[0][0] - scored[1][0] > 0.03):
            hits = [scored[0][1]]
    paths = {b["box_path"] for b in hits}
    return hits[0] if len(paths) == 1 else None


row_of = {r["objectid"]: r for r in rows + new_rows}
for b in box_files:
    if b["section"] != "3. IMAGES EROTIC NOVELETTES":
        continue
    parts = b["box_path"].split("/")
    stem = parts[-1].rsplit(".", 1)[0]
    work = parts[2] if len(parts) >= 4 else re.sub(r"_Page.*$", "", stem, flags=re.I)
    hit = find_parent(work)
    parent = object_of_box.get(hit["box_path"], "") if hit else ""
    orphans += not parent
    page = re.search(r"Page[_ ]?(\d+)", stem, flags=re.I)
    base = row_of[parent]["title"] if parent else clean(work.title())
    children.append({
        "objectid": f"sicb{b['sha1'][:8]}", "parentid": parent,
        "title": f"{base}, page {int(page.group(1))}" if page else clean(stem.replace("_", " ")),
        "identifier": f"p. {int(page.group(1))}" if page else "",
        "format": "image/jpeg", "section": "Erotic Novelettes", "series": nfc(b["series"]),
        "type": "Still Image", "display_template": "image",
        "file_status": "in Box (not in Omeka)", "r2_key": f"originals/{b['box_path']}",
        "box_path": b["box_path"], "file_md5": b["md5"],
    })
for r in rows + new_rows:
    if any(c["parentid"] == r["objectid"] for c in children):
        r["display_template"] = "compound_object"

everything = rows + new_rows + children
seen = Counter(r["objectid"] for r in everything)
for r in everything:  # identical files stored twice in Box share a hash; keep ids unique
    if seen[r["objectid"]] > 1:
        seen[r["objectid"]] -= 1
        r["objectid"] = f"{r['objectid']}x{seen[r['objectid']]}"
out_csv.parent.mkdir(parents=True, exist_ok=True)
with open(out_csv, "w", encoding="utf-8-sig", newline="") as fh:
    w = csv.DictWriter(fh, fieldnames=COLUMNS, restval="")
    w.writeheader()
    w.writerows(everything)

print(f"rows written              : {len(everything)}  ->  {out_csv}")
print(f"  Omeka items             : {len(rows)}")
print(f"  new objects from Box    : {len(new_rows)}")
print(f"  novelette page images   : {len(children)} ({orphans} without a parent found)")
print(f"unique objectids          : {len({r['objectid'] for r in everything})}")
print("file status               :", dict(Counter(r["file_status"] for r in rows)))
print("section (Omeka items)     :", dict(Counter(r["section"] or "(none)" for r in rows)))
print("dates (Omeka items)       :", dict(Counter(r["date_basis"] or "no date" for r in rows)))
print("date precision            :", dict(Counter({4: "year", 7: "month", 10: "day", 0: "none"}[len(r["date"])] for r in rows)))
bad = [r["date_original"] for r in rows if r["date_original"] and r["date_basis"] != "Omeka date field"]
print(f"Omeka dates not parsed    : {len(bad)}  e.g. {bad[:8]}")
print("compound objects          :", sum(1 for r in rows + new_rows if r["display_template"] == "compound_object"))
