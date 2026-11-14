"""Attach the OCR text to the published objects, so the site can show it.

Usage: python make_annotations.py <data_dir> <work_dir> <public_root_url>

For every object that has been through OCR (ocr_from_r2.py) and not yet been
done here:

  - one IIIF annotation page per page image is written to
    web/iiif/<objectid>/text/<n>.json: each line of text is an annotation that
    points at the part of the page it was read from, so a viewer can show the
    text beside the image and jump from a line to its place on the page;
  - the object's manifest is given a link to those pages on each canvas, and a
    link (seeAlso) to the plain text file web/ocr/<objectid>.txt.

Lines the OCR step marked as probably invented ("loop", "dense") are left out,
as they are in the plain text. Nothing else in the manifest is changed.

Run it again after more OCR has finished; objects already done are skipped
(state in <data_dir>/published/annotations.json). Use --redo to do all again.
"""
import json
import shutil
import subprocess
import sys
from pathlib import Path

BUCKET = "r2:sicalipsis-files"
SKIP = {"loop", "dense"}


def rclone(*args):
    result = subprocess.run(["rclone", *args], capture_output=True, text=True, encoding="utf-8")
    if result.returncode:
        raise RuntimeError(f"rclone {args[0]} failed: {result.stderr.strip()[-300:]}")


def main():
    data, work, root = Path(sys.argv[1]), Path(sys.argv[2]) / "annotations", sys.argv[3].rstrip("/")
    base = f"{root}/web"
    done_path = data / "published" / "annotations.json"
    done = {} if "--redo" in sys.argv or not done_path.exists() else json.loads(done_path.read_text(encoding="utf-8"))
    ocr = json.loads((data / "published" / "ocr.json").read_text(encoding="utf-8"))
    published = json.loads((data / "published" / "published.json").read_text(encoding="utf-8"))
    todo = [oid for oid in ocr if oid in published and oid not in done]
    print(f"{len(ocr)} objects have OCR text, {len(done)} already attached, {len(todo)} to do", flush=True)
    if not todo:
        return

    shutil.rmtree(work, ignore_errors=True)
    (work / "in").mkdir(parents=True)
    (work / "ocr.txt").write_text("\n".join(f"{oid}.json" for oid in todo), encoding="utf-8")
    (work / "manifests.txt").write_text("\n".join(f"{oid}/manifest.json" for oid in todo), encoding="utf-8")
    rclone("copy", f"{BUCKET}/web/ocr", str(work / "in" / "ocr"), "--files-from", str(work / "ocr.txt"), "--transfers", "16")
    rclone("copy", f"{BUCKET}/web/iiif", str(work / "in" / "iiif"), "--files-from", str(work / "manifests.txt"), "--transfers", "16")

    out = work / "out"
    lines_total = 0
    for oid in todo:
        ocr_file, manifest_file = work / "in" / "ocr" / f"{oid}.json", work / "in" / "iiif" / oid / "manifest.json"
        if not ocr_file.exists() or not manifest_file.exists():
            print(f"  {oid}: OCR file or manifest missing in the bucket, skipped", flush=True)
            continue
        pages = {p["n"]: p for p in json.loads(ocr_file.read_text(encoding="utf-8"))["pages"]}
        manifest = json.loads(manifest_file.read_text(encoding="utf-8"))
        attached = 0
        for n, canvas in enumerate(manifest["items"], 1):
            page = pages.get(n)
            canvas.pop("annotations", None)
            if not page:
                continue
            scale = canvas["width"] / page["width"]          # OCR read a larger rendering of the page
            page_id = f"{base}/iiif/{oid}/text/{n}.json"
            items = []
            for k, line in enumerate(page["lines"], 1):
                flags = set(line.get("f", []))
                if SKIP & flags or not line["t"].strip() or ("low" in flags and len(line["t"].strip()) <= 2):
                    continue                      # invented text, or a stray mark read as a character or two
                x0, y0, x1, y1 = (round(v * scale) for v in line["b"])
                items.append({
                    "id": f"{page_id}#l{k}", "type": "Annotation", "motivation": "supplementing",
                    "body": {"type": "TextualBody", "value": line["t"].strip(), "format": "text/plain"},
                    "target": f"{canvas['id']}#xywh={x0},{y0},{max(1, x1 - x0)},{max(1, y1 - y0)}",
                })
            if not items:
                continue
            dest = out / oid / "text" / f"{n}.json"
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_text(json.dumps({
                "@context": "http://iiif.io/api/presentation/3/context.json",
                "id": page_id, "type": "AnnotationPage", "label": {"en": ["Text"]}, "items": items,
            }, ensure_ascii=False), encoding="utf-8")
            canvas["annotations"] = [{"id": page_id, "type": "AnnotationPage"}]
            attached += 1
            lines_total += len(items)
        if attached:
            manifest["seeAlso"] = [{"id": f"{base}/ocr/{oid}.txt", "type": "Text", "format": "text/plain",
                                    "label": {"en": ["Text of the pages, read by OCR"]}}]
        (out / oid).mkdir(parents=True, exist_ok=True)
        (out / oid / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=1), encoding="utf-8")
        done[oid] = attached

    # Annotation pages first, manifests last: a manifest never points at a page that is not there yet.
    rclone("copy", str(out), f"{BUCKET}/web/iiif", "--include", "*/text/*.json", "--transfers", "32")
    rclone("copy", str(out), f"{BUCKET}/web/iiif", "--include", "*/manifest.json", "--transfers", "16")
    done_path.write_text(json.dumps(done, ensure_ascii=False), encoding="utf-8")
    shutil.rmtree(work, ignore_errors=True)
    print(f"text attached to {sum(1 for o in todo if done.get(o))} objects: "
          f"{sum(done.get(o, 0) for o in todo)} pages, {lines_total} lines")


if __name__ == "__main__":
    main()
