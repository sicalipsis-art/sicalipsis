"""Save the Omeka-only files listed in rescue_list.csv, gently.

Usage: python fetch_omeka_files.py <rescue_list.csv> <out_dir> [--bucket <rclone path> --record <csv>]

One file at a time with a pause between files. Each download is checked against
Omeka's own MD5. Stops at the second consecutive failure so a struggling server
is never retried in a loop. Safe to re-run: verified files are skipped.

With --bucket (e.g. r2:sicalipsis-files/originals-omeka) each verified file is
uploaded there, checked again in the bucket, written to the --record file
(stored_name, md5, r2_key, source) and removed from this computer, so the disk
does not fill up. Files already in the record are skipped.
"""
import csv
import hashlib
import shutil
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

UA = "Mozilla/5.0 (compatible; collection-inventory/1.0)"
PAUSE = 5.0  # seconds between files


def md5_of(path):
    h = hashlib.md5()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def option(name):
    return sys.argv[sys.argv.index(name) + 1] if name in sys.argv else None


def to_bucket(dest, bucket, md5):
    """Upload one verified file and confirm the bucket's copy has the same MD5."""
    target = f"{bucket}/{dest.name}"
    subprocess.run(["rclone", "copyto", str(dest), target, "--s3-upload-cutoff", "1G"], check=True)
    for extra in ([], ["--download"]):       # large files have no stored MD5: read them back instead
        out = subprocess.run(["rclone", "md5sum", *extra, target], capture_output=True, text=True).stdout.split()
        if out and out[0] == md5:
            return
    raise ValueError("the copy in the bucket does not match")


def main():
    rows = list(csv.DictReader(open(sys.argv[1], encoding="utf-8-sig", newline="")))
    out = Path(sys.argv[2])
    out.mkdir(parents=True, exist_ok=True)
    bucket, record = option("--bucket"), option("--record")
    recorded = set()
    if record and Path(record).exists():
        recorded = {r["stored_name"] for r in csv.DictReader(open(record, encoding="utf-8-sig", newline=""))}
    done = failed = streak = 0
    for n, r in enumerate(rows, 1):
        dest = out / r["stored_name"]
        if r["stored_name"] in recorded or (dest.exists() and md5_of(dest) == r["omeka_md5"]):
            done += 1
            continue
        if shutil.disk_usage(out).free < 4e9:
            print("less than 4 GB of free disk space: stopping", flush=True)
            break
        tmp = dest.with_suffix(dest.suffix + ".part")
        try:
            req = urllib.request.Request(r["src"], headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=60) as resp, open(tmp, "wb") as fh:
                while chunk := resp.read(1 << 20):
                    fh.write(chunk)
            if md5_of(tmp) != r["omeka_md5"]:
                raise ValueError("checksum does not match Omeka's")
            tmp.replace(dest)
            size = dest.stat().st_size
            if bucket:
                to_bucket(dest, bucket, r["omeka_md5"])
                with open(record, "a", encoding="utf-8", newline="") as fh:
                    csv.writer(fh).writerow([r["stored_name"], r["omeka_md5"],
                                             f"{bucket.split('/', 1)[1]}/{r['stored_name']}", "Omeka server"])
                dest.unlink()
            done += 1
            streak = 0
            print(f"[{n}/{len(rows)}] saved item {r['item_id']} ({size / 1e6:.1f} MB)"
                  + (" and copied to the bucket" if bucket else ""), flush=True)
        except Exception as exc:
            tmp.unlink(missing_ok=True)
            failed += 1
            streak += 1
            print(f"[{n}/{len(rows)}] FAILED item {r['item_id']}: {exc}", flush=True)
            if streak >= 2:
                print("two failures in a row: stopping so the server is left alone", flush=True)
                break
        time.sleep(PAUSE)
    print(f"verified on disk: {done} of {len(rows)}; failed this run: {failed}")


if __name__ == "__main__":
    main()
