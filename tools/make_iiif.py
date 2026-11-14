"""Turn spreadsheet rows plus their original files into web images and IIIF manifests.

Usage: python make_iiif.py <rows_csv> <originals_dir> <out_dir> <base_url>

For each row: JPEGs are resized; PDFs are rendered one image per page and their
text layer is saved. Then one IIIF Presentation 3 manifest per object and one
collection are written. Everything lands under <out_dir>, laid out exactly as it
will be served from <base_url>:

  images/<objectid>/0001.jpg ...   page images (long side up to FULL px)
  images/<objectid>/thumb.jpg      thumbnail
  files/<objectid>.pdf             the PDF itself, for download
  text/<objectid>.txt              text layer of the PDF, page by page
  iiif/<objectid>/manifest.json    manifest
  iiif/collection.json             collection of every manifest

Safe to re-run: objects whose images already exist are not rendered again.
"""
import csv
import json
import shutil
import sys
from pathlib import Path

import fitz  # PyMuPDF
from PIL import Image, ImageOps

FULL, THUMB, QUALITY = 1800, 520, 82
rows_csv, originals, out, base = sys.argv[1], Path(sys.argv[2]), Path(sys.argv[3]), sys.argv[4].rstrip("/")

# (manifest label, spreadsheet column, split on ";")
FIELDS = [
    ("Creator", "creator", False), ("Date", "date_display", False), ("Year", "year", False),
    ("Section", "section", False), ("Series", "series", False), ("Publisher", "publisher", False),
    ("Contributor", "contributor", False), ("Source", "source", False),
    ("Relation", "relation", False), ("Identifier", "identifier", False),
    ("Type", "type", False), ("Format", "format", False), ("Subject", "subject", True),
]


def save_jpeg(img, path, long_side):
    img = ImageOps.exif_transpose(img).convert("RGB")
    img.thumbnail((long_side, long_side), Image.LANCZOS)
    path.parent.mkdir(parents=True, exist_ok=True)
    img.save(path, "JPEG", quality=QUALITY, optimize=True, progressive=True)
    return img.size


def render(row):
    """Create page images and a thumbnail; return [(file name, width, height)]."""
    oid = row["objectid"]
    img_dir = out / "images" / oid
    done = img_dir / "pages.json"
    if done.exists():
        return json.loads(done.read_text())
    src = originals / row["box_path"]
    pages = []
    if row["format"] == "image/jpeg":
        with Image.open(src) as im:
            w, h = save_jpeg(im, img_dir / "0001.jpg", FULL)
            save_jpeg(im, img_dir / "thumb.jpg", THUMB)
        pages.append(["0001.jpg", w, h])
    else:
        doc = fitz.open(src)
        text = []
        for n, page in enumerate(doc, 1):
            zoom = FULL / max(page.rect.width, page.rect.height)
            pix = page.get_pixmap(matrix=fitz.Matrix(zoom, zoom), alpha=False)
            im = Image.frombytes("RGB", (pix.width, pix.height), pix.samples)
            w, h = save_jpeg(im, img_dir / f"{n:04d}.jpg", FULL)
            if n == 1:
                save_jpeg(im, img_dir / "thumb.jpg", THUMB)
            pages.append([f"{n:04d}.jpg", w, h])
            text.append(f"=== page {n} ===\n{page.get_text().strip()}")
        doc.close()
        (out / "text").mkdir(parents=True, exist_ok=True)
        (out / "text" / f"{oid}.txt").write_text("\n\n".join(text), encoding="utf-8")
        (out / "files").mkdir(parents=True, exist_ok=True)
        shutil.copyfile(src, out / "files" / f"{oid}.pdf")
    done.write_text(json.dumps(pages))
    return pages


def manifest(row, pages):
    oid = row["objectid"]
    mid = f"{base}/iiif/{oid}/manifest.json"
    with Image.open(out / "images" / oid / "thumb.jpg") as t:
        tw, th = t.size
    row = dict(row, year=row["date"][:4], date_display=row["date_original"] or row["date"])
    metadata = []
    for label, col, split in FIELDS:
        values = [v.strip() for v in row[col].split(";")] if split else [row[col].strip()]
        values = [v for v in values if v]
        if values:
            metadata.append({"label": {"en": [label]}, "value": {"none": values}})
    canvases = []
    for n, (name, w, h) in enumerate(pages, 1):
        cid = f"{base}/iiif/{oid}/canvas/{n}"
        canvases.append({
            "id": cid, "type": "Canvas", "width": w, "height": h,
            "label": {"none": [str(n)]} if len(pages) > 1 else {"none": [row["title"]]},
            "items": [{
                "id": f"{cid}/page", "type": "AnnotationPage",
                "items": [{
                    "id": f"{cid}/page/image", "type": "Annotation", "motivation": "painting",
                    "target": cid,
                    "body": {"id": f"{base}/images/{oid}/{name}", "type": "Image",
                             "format": "image/jpeg", "width": w, "height": h},
                }],
            }],
        })
    m = {
        "@context": "http://iiif.io/api/presentation/3/context.json",
        "id": mid, "type": "Manifest", "label": {"none": [row["title"]]},
        "metadata": metadata,
        "thumbnail": [{"id": f"{base}/images/{oid}/thumb.jpg", "type": "Image",
                       "format": "image/jpeg", "width": tw, "height": th}],
        "items": canvases,
    }
    if row["description"]:
        m["summary"] = {"none": [row["description"]]}
    if len(row["date"]) >= 4:
        m["navDate"] = (row["date"] + "-01-01")[:10] + "T00:00:00Z"
    if row["format"] == "application/pdf":
        m["rendering"] = [{"id": f"{base}/files/{oid}.pdf", "type": "Text",
                           "label": {"en": ["Download PDF"]}, "format": "application/pdf"}]
        m["behavior"] = ["paged"]
    path = out / "iiif" / oid / "manifest.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(m, ensure_ascii=False, indent=1), encoding="utf-8")
    return {"id": mid, "type": "Manifest", "label": m["label"], "thumbnail": m["thumbnail"]}


rows = list(csv.DictReader(open(rows_csv, encoding="utf-8-sig", newline="")))
refs, total_pages = [], 0
for i, row in enumerate(rows, 1):
    pages = render(row)
    total_pages += len(pages)
    refs.append(manifest(row, pages))
    print(f"[{i}/{len(rows)}] {row['objectid']}  {len(pages):3} page(s)  {row['title'][:50]}", flush=True)
collection = {
    "@context": "http://iiif.io/api/presentation/3/context.json",
    "id": f"{base}/iiif/collection.json", "type": "Collection",
    "label": {"en": ["Sicalipsis"]}, "items": refs,
}
(out / "iiif" / "collection.json").write_text(json.dumps(collection, ensure_ascii=False, indent=1), encoding="utf-8")
print(f"{len(rows)} manifests, {total_pages} page images -> {out}")
