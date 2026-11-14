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
The functions are also used by publish_from_r2.py.
"""
import csv
import io
import json
import re
import shutil
import sys
from pathlib import Path

import fitz  # PyMuPDF
from PIL import Image, ImageOps

FULL, THUMB, QUALITY = 1600, 520, 80

# (manifest label, spreadsheet column, split on ";")
FIELDS = [
    ("Creator", "creator", False), ("Date", "date_display", False), ("Year", "year", False),
    ("Section", "section", False), ("Series", "series", False), ("Publisher", "publisher", False),
    ("Contributor", "contributor", False), ("Source", "source", False),
    ("Relation", "relation", False), ("Identifier", "identifier", False),
    ("Type", "type", False), ("Format", "format", False), ("Subject", "subject", True),
    # image tags (tools/tag_images.py); only pictures in the Image Gallery have them
    ("Image type", "tag_type", False), ("Figures", "tag_figures", False), ("Dress", "tag_dress", False),
    ("Colour", "tag_colour", False), ("Themes", "tag_themes", True),
    ("Inscription", "inscription", False), ("Text", "text", False), ("Note", "file_note", False),
]


def save_jpeg(img, path, long_side):
    img = ImageOps.exif_transpose(img).convert("RGB")
    img.thumbnail((long_side, long_side), Image.LANCZOS)
    path.parent.mkdir(parents=True, exist_ok=True)
    img.save(path, "JPEG", quality=QUALITY, optimize=True, progressive=True)
    return img.size


def salvage_order(doc):
    """Image objects of a PDF whose page list is lost, in reading order.

    Page objects that survive name their own scan, and in files that went
    through Acrobat each carries its position (StructParents); otherwise the
    order in which the objects were stored is used.
    """
    found = []
    for xref in range(1, doc.xref_length()):
        try:
            if doc.xref_get_key(xref, "Type")[1] != "/Page":
                continue
            kind, value = doc.xref_get_key(xref, "Resources/XObject")
            if kind == "xref":
                value = doc.xref_object(int(value.split()[0]))
            images = [int(n) for n in re.findall(r"(\d+) 0 R", value)]
            position = doc.xref_get_key(xref, "StructParents")
            found.append((int(position[1]) if position[0] == "int" else None, xref, images))
        except Exception:
            continue
    if found:
        if all(position is not None for position, _, _ in found):
            found.sort(key=lambda f: f[0])
        return [image for _, _, images in found for image in images]
    return [xref for xref in range(1, doc.xref_length())
            if doc.xref_get_key(xref, "Subtype")[1] == "/Image"]


def render(row, src, out, keep_pdf_copy=True):
    """Create page images and a thumbnail for one object.

    Returns {"pages": [[file name, width, height], ...], "thumb": [width, height]},
    plus "damaged" (a short description) when the PDF could only partly be read.
    """
    oid = row["objectid"]
    img_dir = out / "images" / oid
    done = img_dir / "pages.json"
    if done.exists():
        return json.loads(done.read_text())
    pages = []
    if row["format"] == "image/jpeg":
        with Image.open(src) as im:
            w, h = save_jpeg(im, img_dir / "0001.jpg", FULL)
            thumb = save_jpeg(im, img_dir / "thumb.jpg", THUMB)
        pages.append(["0001.jpg", w, h])
    else:
        doc = fitz.open(src)
        text, thumb, unreadable = [], None, 0

        def add(im, page_text):
            nonlocal thumb
            n = len(pages) + 1
            w, h = save_jpeg(im, img_dir / f"{n:04d}.jpg", FULL)
            if n == 1:
                thumb = save_jpeg(im, img_dir / "thumb.jpg", THUMB)
            pages.append([f"{n:04d}.jpg", w, h])
            text.append(f"=== page {n} ===" + chr(10) + page_text.strip())

        for index in range(len(doc)):
            try:
                page = doc[index]
                zoom = FULL / max(page.rect.width, page.rect.height)
                pix = page.get_pixmap(matrix=fitz.Matrix(zoom, zoom), alpha=False)
                add(Image.frombytes("RGB", (pix.width, pix.height), pix.samples), page.get_text())
            except Exception:
                unreadable += 1    # a damaged file: the pages that cannot be read are left out
        if not pages:
            # A file cut short so badly that its list of pages is gone. The page
            # scans stored inside it are recovered directly.
            for xref in salvage_order(doc):
                try:
                    im = Image.open(io.BytesIO(doc.extract_image(xref)["image"]))
                    im.load()
                    add(im, "")
                except Exception:
                    continue
        if not pages:
            raise RuntimeError("no readable pages in this PDF")
        (out / "text").mkdir(parents=True, exist_ok=True)
        (out / "text" / f"{oid}.txt").write_text("\n\n".join(text), encoding="utf-8")
        if keep_pdf_copy:
            (out / "files").mkdir(parents=True, exist_ok=True)
            shutil.copyfile(src, out / "files" / f"{oid}.pdf")
    result = {"pages": pages, "thumb": list(thumb)}
    if row["format"] != "image/jpeg" and (unreadable or not len(doc)):
        result["damaged"] = f"{unreadable} unreadable page(s)" if unreadable else "pages recovered from a file cut short"
    done.write_text(json.dumps(result))
    return result


def describe(row):
    """The descriptive part of a manifest, from a spreadsheet row: label, metadata,
    summary and navDate. Shared by write_manifest and refresh_manifests.py."""
    firm = row.get("date_certainty") != "estimated"
    row = dict(row, year=row["date"][:4] if firm else "",
               date_display=row.get("date_display") or row["date"])
    metadata = []
    for label, col, split in FIELDS:
        value = row.get(col) or ""
        values = [v.strip() for v in value.split(";")] if split else [value.strip()]
        values = [v for v in values if v]
        if values:
            metadata.append({"label": {"en": [label]}, "value": {"none": values}})
    out = {"label": {"none": [row["title"]]}, "metadata": metadata}
    if row["description"]:
        out["summary"] = {"none": [row["description"]]}
    if firm and len(row["date"]) >= 4:  # an estimated year is shown in words, not as a machine date
        out["navDate"] = (row["date"] + "-01-01")[:10] + "T00:00:00Z"
    return out


def write_manifest(row, rendered, out, base, pdf_url=None):
    """Write the object's manifest; return its entry for the collection."""
    oid = row["objectid"]
    pages, (tw, th) = rendered["pages"], rendered["thumb"]
    mid = f"{base}/iiif/{oid}/manifest.json"
    described = describe(row)
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
        "id": mid, "type": "Manifest", "label": described["label"],
        "metadata": described["metadata"],
        "thumbnail": [{"id": f"{base}/images/{oid}/thumb.jpg", "type": "Image",
                       "format": "image/jpeg", "width": tw, "height": th}],
        "items": canvases,
    }
    for key in ("summary", "navDate"):
        if key in described:
            m[key] = described[key]
    if row["format"] == "application/pdf":
        m["rendering"] = [{"id": pdf_url or f"{base}/files/{oid}.pdf", "type": "Text",
                           "label": {"en": ["Download PDF"]}, "format": "application/pdf"}]
        m["behavior"] = ["paged"]
    path = out / "iiif" / oid / "manifest.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(m, ensure_ascii=False, indent=1), encoding="utf-8")
    return {"id": mid, "type": "Manifest", "label": m["label"], "thumbnail": m["thumbnail"]}


def write_collection(refs, out, base):
    collection = {
        "@context": "http://iiif.io/api/presentation/3/context.json",
        "id": f"{base}/iiif/collection.json", "type": "Collection",
        "label": {"en": ["Sicalipsis"]}, "items": refs,
    }
    path = out / "iiif" / "collection.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(collection, ensure_ascii=False, indent=1), encoding="utf-8")


def main():
    rows_csv, originals, out, base = sys.argv[1], Path(sys.argv[2]), Path(sys.argv[3]), sys.argv[4].rstrip("/")
    rows = list(csv.DictReader(open(rows_csv, encoding="utf-8-sig", newline="")))
    refs, total_pages = [], 0
    for i, row in enumerate(rows, 1):
        rendered = render(row, originals / row["box_path"], out)
        total_pages += len(rendered["pages"])
        refs.append(write_manifest(row, rendered, out, base))
        print(f"[{i}/{len(rows)}] {row['objectid']}  {len(rendered['pages']):3} page(s)  {row['title'][:50]}", flush=True)
    write_collection(refs, out, base)
    print(f"{len(rows)} manifests, {total_pages} page images -> {out}")


if __name__ == "__main__":
    main()
