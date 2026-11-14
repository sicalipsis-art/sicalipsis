"""Build the master metadata spreadsheet in CollectionBuilder-CSV format.

Usage: python build_master.py <data_dir> <out_csv>

One row per object. Omeka items keep their Omeka metadata; the file comes from
Box when Box has an identical copy or an OCR'd version, otherwise it is marked
as only on the Omeka server. Box material that Omeka never had is appended:
extra PDFs and gallery images as new objects, novelette page images as children
(parentid) of their novelette. Inventory spreadsheets are left out.

box_path and r2_key keep the exact characters Box uses (some accents are stored
in decomposed form), so they match the stored objects byte for byte.

Dates are standardised, and missing ones worked out, by dates.py; pass
--texts <dir> (holding text/<objectid>.txt and ocr/<objectid>.txt) to let it also
read dates printed in the documents themselves.

Image tags (tag_* columns) are copied from <data_dir>/tags/image_tags.csv, which
tag_images.py writes; tag_source says whether a picture's tags were given by a
labeller or by the classifier.

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

sys.path.insert(0, str(Path(__file__).resolve().parent))
import dates  # noqa: E402

data = Path(sys.argv[1])
out_csv = Path(sys.argv[2])
text_dir = Path(sys.argv[sys.argv.index("--texts") + 1]) if "--texts" in sys.argv else None
rec = data / "reconciliation"

COLUMNS = [
    "objectid", "parentid", "title", "creator", "date", "date_display", "date_certainty",
    "date_range", "date_basis", "date_original",
    "description", "subject", "publisher", "contributor", "source", "relation",
    "identifier", "type", "format", "section", "series", "collection",
    "tag_type", "tag_figures", "tag_dress", "tag_colour", "tag_themes", "tag_source",
    "display_template", "object_location", "image_small", "image_thumb",
    "file_status", "file_note", "r2_key", "box_path", "omeka_item_id", "omeka_url", "file_md5",
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
# Omeka's own files recovered from the Internet Archive and verified in the bucket.
rescued_path = rec / "rescued_in_bucket.csv"
rescued = {r["stored_name"]: r for r in read_csv(rescued_path)} if rescued_path.exists() else {}

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
    saved = rescued.get(f["stored_name"]) if f else None
    rescued_key = ""
    if saved and status in ("only on Omeka server", "in Box (OCR version, unconfirmed)"):
        # Use Omeka's own file: it is certain to belong to this record.
        box_path, status, rescued_key = "", "rescued from the Internet Archive", saved["r2_key"]
    box = box_by_path.get(box_path)
    collection = clean(it["collection_title"])
    section = SECTION_OF_COLLECTION.get(collection) or (ESSAYS if collection else "")
    if not section and box:
        section = SECTION_OF_BOX.get(box["section"], "")
    if not section:
        section = next((SECTION_OF_TAG[t.lower()] for t in it["tags"].split(" | ")
                        if t.lower() in SECTION_OF_TAG), "")
    title = re.sub(r"\.pdf?$", "", clean(it.get("dc_title", "")), flags=re.I)
    ext = (box["ext"] if box else (f["ext"] if f else ""))
    rows.append({
        "objectid": objectid, "title": title or "[Untitled]",
        "creator": clean(it.get("dc_creator", "")),
        "date_original": clean(it.get("dc_date", "")),
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
        "file_status": status, "r2_key": rescued_key or (f"originals/{box_path}" if box_path else ""),
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
# Dates: standardise what is recorded, then work out what is missing (see dates.py).
texts = {}
if text_dir:
    for kind in ("text", "ocr"):  # OCR text, where it exists, replaces the PDF's own text layer
        for path in sorted((text_dir / kind).glob("*.txt")):
            content = path.read_text(encoding="utf-8", errors="replace")
            if len(content) > 200:
                texts[path.stem] = content
date_tally = dates.resolve(rows + new_rows, texts)
# Files that were already cut short on the Omeka server (reconciliation/damaged_on_omeka.csv).
damaged_path = rec / "damaged_on_omeka.csv"
damaged = {d["stored_name"]: d["note"] for d in read_csv(damaged_path)} if damaged_path.exists() else {}
for r in rows:
    r["file_note"] = damaged.get(r["r2_key"].rsplit("/", 1)[-1], "")
tags_path = data / "tags" / "image_tags.csv"
tagged = {t["objectid"]: t for t in read_csv(tags_path)} if tags_path.exists() else {}
for r in rows + new_rows:
    t = tagged.get(r["objectid"])
    if t:
        r.update({c: t[c] for c in ("tag_type", "tag_figures", "tag_dress", "tag_colour", "tag_themes")})
        r["tag_source"] = t["source"]
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
objects = rows + new_rows
print("dates                     :", date_tally, f"(document text read for {len(texts)} objects)")
print("date precision            :", dict(Counter({4: "year", 7: "month", 10: "day", 0: "none"}[len(r["date"])] for r in objects)))
left = [r["date_original"] for r in objects if r.get("date_original") and not r["date"]]
print(f"recorded dates not usable : {len(left)}  {left[:6]}")
print(f"objects with image tags  : {sum(1 for r in objects if r.get('tag_type') or r.get('tag_themes'))}")
print("compound objects          :", sum(1 for r in rows + new_rows if r["display_template"] == "compound_object"))
