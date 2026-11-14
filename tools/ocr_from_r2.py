"""OCR published PDFs with Surya on the GPU, with layout-based reading order.

Usage: python ocr_from_r2.py <data_dir> <work_dir> [--limit N] [--only id,id,...]

Run it with the OCR environment's Python (see tools/requirements-ocr.txt).

For each published PDF that has no OCR yet:
  1. download the original from r2:<bucket>/originals/
  2. render every page (long side LONG_SIDE px), detect and recognise text lines,
     and run layout analysis so lines are put in reading order (two-page spreads
     and multi-column pages come out page by page, column by column)
  3. score every line and page for likely mistranscription (see FLAGS below)
  4. upload web/ocr/<objectid>.json (lines with boxes, confidence and flags) and
     web/ocr/<objectid>.txt (plain text in reading order)

Progress is kept in <data_dir>/published/ocr.json and one row per page is added
to <data_dir>/published/ocr_pages.csv, which is the list to proofread from.

FLAGS on a line:
  low    recognition confidence under 0.75
  loop   the same phrase repeated three or more times: the model's typical
         failure on an unreadable line
  dense  far more characters than the line's width allows: invented text
  merged several printed lines read as one; the words are real, but spaces at the
         joins may be missing
Lines flagged loop or dense are written as "[illegible]" in the .txt file; the
.json file always keeps what the model produced.
"""
import csv
import json
import os
import re
import statistics
import subprocess
import sys
import time
from pathlib import Path

os.environ.setdefault("RECOGNITION_BATCH_SIZE", "64")
os.environ.setdefault("DETECTOR_BATCH_SIZE", "8")
os.environ.setdefault("LAYOUT_BATCH_SIZE", "8")

import fitz  # noqa: E402  (PyMuPDF)
from PIL import Image  # noqa: E402
from surya.detection import DetectionPredictor  # noqa: E402
from surya.foundation import FoundationPredictor  # noqa: E402
from surya.layout import LayoutPredictor  # noqa: E402
from surya.recognition import RecognitionPredictor  # noqa: E402
from surya.settings import settings  # noqa: E402

BUCKET = "r2:sicalipsis-files"
LONG_SIDE = 2400
CHUNK = 6  # pages recognised together
ENGINE = "surya-ocr 0.17.1"
PAGE_COLUMNS = ["objectid", "page", "lines", "chars", "mean_confidence", "low_lines",
                "loop_lines", "dense_lines", "merged_lines", "flag"]
LOOP = re.compile(r"(.{8,40}?)\1{2,}")


def rclone(*args, capture=False):
    result = subprocess.run(["rclone", *args], capture_output=True, text=True, encoding="utf-8")
    if result.returncode != 0:
        raise RuntimeError(f"rclone {args[0]} failed: {result.stderr.strip()[-300:]}")
    return result.stdout if capture else None


def clean(text):
    return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", "", text or "")).strip()


def read_page(prediction, layout):
    """Return (lines in reading order, page summary) for one page."""
    blocks = sorted(layout.bboxes, key=lambda b: b.position)

    def block_of(box):
        cx, cy = (box[0] + box[2]) / 2, (box[1] + box[3]) / 2
        for i, b in enumerate(blocks):
            if b.bbox[0] <= cx <= b.bbox[2] and b.bbox[1] <= cy <= b.bbox[3]:
                return i
        return len(blocks)

    lines = []
    for ln in prediction.text_lines:
        text = clean(ln.text)
        if text:
            lines.append({"t": text, "b": [round(v) for v in ln.bbox],
                          "c": round(float(ln.confidence or 0), 3), "k": block_of(ln.bbox)})
    lines.sort(key=lambda ln: (ln["k"], ln["b"][1], ln["b"][0]))
    density = [len(ln["t"]) / max(1, ln["b"][2] - ln["b"][0]) for ln in lines if len(ln["t"]) >= 20]
    typical = statistics.median(density) if density else 0
    height = statistics.median([ln["b"][3] - ln["b"][1] for ln in lines]) if lines else 0
    for ln in lines:
        flags = []
        if ln["c"] < 0.75:
            flags.append("low")
        repeat = LOOP.search(ln["t"])
        if repeat and sum(ch.isalpha() for ch in repeat.group(1)) >= 4:  # not dotted leaders or rules
            flags.append("loop")
        if typical and len(ln["t"]) > 30 and len(ln["t"]) / max(1, ln["b"][2] - ln["b"][0]) > 2.2 * typical:
            # Too much text for the width. A tall box means several printed lines were
            # read as one (the words are real, spaces at the joins may be missing);
            # a box of normal height means the text was invented.
            flags.append("merged" if height and ln["b"][3] - ln["b"][1] > 1.6 * height else "dense")
        if flags:
            ln["f"] = flags
    n = len(lines)
    count = lambda name: sum(1 for ln in lines if name in ln.get("f", []))  # noqa: E731
    mean = round(sum(ln["c"] for ln in lines) / n, 3) if n else 0
    summary = {"lines": n, "chars": sum(len(ln["t"]) for ln in lines), "mean_confidence": mean,
               "low_lines": count("low"), "loop_lines": count("loop"), "dense_lines": count("dense"),
               "merged_lines": count("merged")}
    reasons = []
    if summary["loop_lines"] or summary["dense_lines"]:
        reasons.append("invented text")
    if n and (mean < 0.88 or summary["low_lines"] / n > 0.25):
        reasons.append("low confidence")
    summary["flag"] = "; ".join(reasons)
    return lines, summary


def plain_text(pages):
    out = []
    for n, lines in enumerate(pages, 1):
        out.append(f"=== page {n} ===")
        block = None
        for ln in lines:
            if block is not None and ln["k"] != block:
                out.append("")
            block = ln["k"]
            bad = {"loop", "dense"} & set(ln.get("f", []))
            out.append("[illegible]" if bad else ln["t"])
        out.append("")
    return "\n".join(out)


def main():
    data, work = Path(sys.argv[1]), Path(sys.argv[2])
    limit = int(sys.argv[sys.argv.index("--limit") + 1]) if "--limit" in sys.argv else None
    only = set(sys.argv[sys.argv.index("--only") + 1].split(",")) if "--only" in sys.argv else None
    pub = data / "published"
    state_path, pages_path = pub / "ocr.json", pub / "ocr_pages.csv"
    state = json.loads(state_path.read_text(encoding="utf-8")) if state_path.exists() else {}
    published = json.loads((pub / "published.json").read_text(encoding="utf-8"))
    with open(data / "master" / "sicalipsis.csv", encoding="utf-8-sig", newline="") as fh:
        rows = {r["objectid"]: r for r in csv.DictReader(fh)}
    in_bucket = {"originals/" + f["Path"] for f in
                 json.loads(rclone("lsjson", "-R", "--files-only", f"{BUCKET}/originals", capture=True))}
    todo = [rows[k] for k in published
            if k in rows and rows[k]["format"] == "application/pdf" and k not in state
            and rows[k]["r2_key"] in in_bucket  # the original may still be on its way to the bucket
            and (only is None or k in only)]
    todo.sort(key=lambda r: published[r["objectid"]].get("pages", 0))  # short documents first
    if limit:
        todo = todo[:limit]
    print(f"{len(published)} published objects, {len(state)} already OCRed, {len(todo)} to do now", flush=True)
    if not todo:
        return

    t0 = time.time()
    foundation = FoundationPredictor()
    recognise = RecognitionPredictor(foundation)
    detect = DetectionPredictor()
    layout = LayoutPredictor(FoundationPredictor(checkpoint=settings.LAYOUT_MODEL_CHECKPOINT))
    print(f"models loaded in {time.time() - t0:.0f}s", flush=True)
    if not pages_path.exists():
        with open(pages_path, "w", encoding="utf-8-sig", newline="") as fh:
            csv.writer(fh).writerow(PAGE_COLUMNS)

    out_dir = work / "ocr"
    out_dir.mkdir(parents=True, exist_ok=True)
    for i, row in enumerate(todo, 1):
        oid = row["objectid"]
        src = work / "ocr-orig" / f"{oid}.pdf"  # not the publisher's folder: both may run at once
        started = time.time()
        try:
            rclone("copyto", f"{BUCKET}/{row['r2_key']}", str(src))
            if not src.exists():
                raise RuntimeError("the original could not be downloaded from the bucket")
            doc = fitz.open(src)
            pages, summaries, sizes = [], [], []
            for start in range(0, len(doc), CHUNK):
                images = []
                for page in list(doc)[start:start + CHUNK]:
                    zoom = LONG_SIDE / max(page.rect.width, page.rect.height)
                    pix = page.get_pixmap(matrix=fitz.Matrix(zoom, zoom), alpha=False)
                    images.append(Image.frombytes("RGB", (pix.width, pix.height), pix.samples))
                predictions = recognise(images, det_predictor=detect)
                layouts = layout(images)
                for image, prediction, lay in zip(images, predictions, layouts):
                    lines, summary = read_page(prediction, lay)
                    pages.append(lines)
                    summaries.append(summary)
                    sizes.append(list(image.size))
            doc.close()
            result = {"objectid": oid, "engine": ENGINE, "rendered_long_side": LONG_SIDE,
                      "pages": [{"n": n, "width": w, "height": h, **s, "lines": ls}
                                for n, ((w, h), s, ls) in enumerate(zip(sizes, summaries, pages), 1)]}
            (out_dir / f"{oid}.json").write_text(json.dumps(result, ensure_ascii=False), encoding="utf-8")
            (out_dir / f"{oid}.txt").write_text(plain_text(pages), encoding="utf-8")
            rclone("copyto", str(out_dir / f"{oid}.json"), f"{BUCKET}/web/ocr/{oid}.json")
            rclone("copyto", str(out_dir / f"{oid}.txt"), f"{BUCKET}/web/ocr/{oid}.txt")
            with open(pages_path, "a", encoding="utf-8-sig", newline="") as fh:
                w = csv.DictWriter(fh, fieldnames=PAGE_COLUMNS, extrasaction="ignore")
                for n, s in enumerate(summaries, 1):
                    w.writerow({"objectid": oid, "page": n, **s})
            seconds = time.time() - started
            flagged = sum(1 for s in summaries if s["flag"])
            state[oid] = {"pages": len(pages), "lines": sum(s["lines"] for s in summaries),
                          "flagged_pages": flagged, "seconds": round(seconds)}
            state_path.write_text(json.dumps(state, ensure_ascii=False), encoding="utf-8")
            print(f"[{i}/{len(todo)}] {oid}  {len(pages):3} pages  {seconds / max(1, len(pages)):5.1f}s/page  "
                  f"flagged pages {flagged:3}  {row['title'][:44]}", flush=True)
        except Exception as exc:
            print(f"[{i}/{len(todo)}] {oid}  FAILED: {str(exc)[:200]}", flush=True)
        finally:
            src.unlink(missing_ok=True)
    total_pages = sum(v["pages"] for v in state.values())
    print(f"OCRed so far: {len(state)} documents, {total_pages} pages")


if __name__ == "__main__":
    main()
