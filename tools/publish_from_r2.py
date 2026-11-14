"""Publish every object whose original file is already in the R2 bucket.

Usage: python publish_from_r2.py <data_dir> <work_dir> <public_root_url> [--limit N]

<public_root_url> is the bucket's public address, e.g. https://pub-xxxx.r2.dev

For each object in the master spreadsheet that is ready and not yet published:
  1. download its original from r2:<bucket>/originals/ into <work_dir>
  2. make page images, thumbnail, text and the IIIF manifest
  3. upload them to r2:<bucket>/web/  (the manifest last, so a manifest in the
     bucket always means the object is complete)
  4. delete the local copies

Then the collection (web/iiif/collection.json) is rebuilt from everything
published so far, and <data_dir>/published/rows.csv is written for
make_site_content.py. Run it again whenever more originals have arrived; work
already done is skipped.

Not published: files that exist only on the Omeka server and were not recovered
from the Internet Archive, title matches still marked unconfirmed, and the novelette page images (their pages are already
inside the novelette's own PDF).
"""
import csv
import json
import shutil
import subprocess
import sys
import time
from pathlib import Path
from urllib.parse import quote

sys.path.insert(0, str(Path(__file__).resolve().parent))
from make_iiif import render, write_collection, write_manifest  # noqa: E402

BUCKET = "r2:sicalipsis-files"
READY = {"in Box (identical)", "in Box (OCR version)", "in Box (not in Omeka)", "rescued from the Internet Archive"}


NETWORK = ("no such host", "dial tcp", "request send failed", "connection reset", "timeout", "i/o timeout",
           "connection refused", "TLS handshake", "EOF")


def rclone(*args, capture=False):
    """Run rclone; if the internet connection is down, wait and try again instead of giving up."""
    for attempt in range(40):
        result = subprocess.run(["rclone", *args], capture_output=True, text=True, encoding="utf-8")
        if result.returncode == 0:
            return result.stdout if capture else None
        if not any(sign in result.stderr for sign in NETWORK):
            break
        print(f"  connection problem, waiting to retry ({attempt + 1})", flush=True)
        time.sleep(30)
    raise RuntimeError(f"rclone {args[0]} failed: {result.stderr.strip()[-300:]}")


def main():
    data, work, root = Path(sys.argv[1]), Path(sys.argv[2]), sys.argv[3].rstrip("/")
    limit = int(sys.argv[sys.argv.index("--limit") + 1]) if "--limit" in sys.argv else None
    base = f"{root}/web"
    state_path = data / "published" / "published.json"
    state_path.parent.mkdir(parents=True, exist_ok=True)
    state = json.loads(state_path.read_text(encoding="utf-8")) if state_path.exists() else {}

    with open(data / "master" / "sicalipsis.csv", encoding="utf-8-sig", newline="") as fh:
        rows = list(csv.DictReader(fh))
    in_bucket = {}
    for prefix in ("originals", "originals-omeka"):   # the Box copy, and Omeka's files recovered from the Internet Archive
        for f in json.loads(rclone("lsjson", "-R", "--files-only", f"{BUCKET}/{prefix}", capture=True)):
            in_bucket[f"{prefix}/{f['Path']}"] = f["Size"]
    live = {p.split("/")[0] for p in
            rclone("lsf", "-R", "--files-only", "--include", "manifest.json", f"{BUCKET}/web/iiif",
                   capture=True).splitlines()}
    # Entries the state file knows about but the bucket no longer has are dropped.
    state = {k: v for k, v in state.items() if k in live}

    todo = [r for r in rows
            if r["file_status"] in READY and not r["parentid"]
            and not r["box_path"].startswith("3. IMAGES EROTIC NOVELETTES")
            and r["r2_key"] in in_bucket and r["objectid"] not in state]
    todo.sort(key=lambda r: in_bucket[r["r2_key"]])  # small files first: more objects sooner
    if limit:
        todo = todo[:limit]
    print(f"{len(in_bucket)} originals in the bucket, {len(state)} objects already published, "
          f"{len(todo)} to publish now", flush=True)

    web = work / "web"
    done = failed = 0
    started = time.time()
    for i, row in enumerate(todo, 1):
        oid = row["objectid"]
        ext = ".pdf" if row["format"] == "application/pdf" else ".jpg"
        src = work / "orig" / f"{oid}{ext}"
        try:
            rclone("copyto", f"{BUCKET}/{row['r2_key']}", str(src))
            rendered = render(row, src, web, keep_pdf_copy=False)
            pdf_url = f"{root}/{quote(row['r2_key'])}" if ext == ".pdf" else None
            ref = write_manifest(row, rendered, web, base, pdf_url=pdf_url)
            rclone("copy", str(web / "images" / oid), f"{BUCKET}/web/images/{oid}",
                   "--exclude", "pages.json", "--transfers", "8")
            if ext == ".pdf":
                rclone("copyto", str(web / "text" / f"{oid}.txt"), f"{BUCKET}/web/text/{oid}.txt")
            rclone("copyto", str(web / "iiif" / oid / "manifest.json"),
                   f"{BUCKET}/web/iiif/{oid}/manifest.json")
            state[oid] = {"ref": ref, "pages": len(rendered["pages"])}
            state_path.write_text(json.dumps(state, ensure_ascii=False), encoding="utf-8")
            done += 1
            print(f"[{i}/{len(todo)}] {oid}  {len(rendered['pages']):3} page(s)  "
                  f"{in_bucket[row['r2_key']] / 1e6:6.1f} MB  {row['title'][:48]}"
                  + (f"  DAMAGED FILE: {rendered['damaged']}" if rendered.get("damaged") else ""), flush=True)
        except Exception as exc:
            failed += 1
            print(f"[{i}/{len(todo)}] {oid}  FAILED: {str(exc)[:200]}", flush=True)
        finally:
            src.unlink(missing_ok=True)
            for leftover in (web / "images" / oid, web / "iiif" / oid):
                shutil.rmtree(leftover, ignore_errors=True)
            (web / "text" / f"{oid}.txt").unlink(missing_ok=True)

    order = {r["objectid"]: n for n, r in enumerate(rows)}
    published = sorted(state, key=lambda k: order.get(k, 10**9))
    write_collection([state[k]["ref"] for k in published], web, base)
    rclone("copyto", str(web / "iiif" / "collection.json"), f"{BUCKET}/web/iiif/collection.json")
    by_id = {r["objectid"]: r for r in rows}
    with open(data / "published" / "rows.csv", "w", encoding="utf-8-sig", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=list(rows[0]))
        w.writeheader()
        w.writerows(by_id[k] for k in published if k in by_id)
    print(f"published this run: {done}, failed: {failed}, total published: {len(published)}, "
          f"pages this run: {sum(state[r['objectid']]['pages'] for r in todo if r['objectid'] in state)}, "
          f"minutes: {(time.time() - started) / 60:.1f}")


if __name__ == "__main__":
    main()
