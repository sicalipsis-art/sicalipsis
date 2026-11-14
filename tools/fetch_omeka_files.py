"""Save the Omeka-only files listed in rescue_list.csv, gently.

Usage: python fetch_omeka_files.py <rescue_list.csv> <out_dir>

One file at a time with a pause between files. Each download is checked against
Omeka's own MD5. Stops at the second consecutive failure so a struggling server
is never retried in a loop. Safe to re-run: verified files are skipped.
"""
import csv
import hashlib
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


def main():
    rows = list(csv.DictReader(open(sys.argv[1], encoding="utf-8-sig", newline="")))
    out = Path(sys.argv[2])
    out.mkdir(parents=True, exist_ok=True)
    done = failed = streak = 0
    for n, r in enumerate(rows, 1):
        dest = out / r["stored_name"]
        if dest.exists() and md5_of(dest) == r["omeka_md5"]:
            done += 1
            continue
        tmp = dest.with_suffix(dest.suffix + ".part")
        try:
            req = urllib.request.Request(r["src"], headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=60) as resp, open(tmp, "wb") as fh:
                while chunk := resp.read(1 << 20):
                    fh.write(chunk)
            if md5_of(tmp) != r["omeka_md5"]:
                raise ValueError("checksum does not match Omeka's")
            tmp.replace(dest)
            done += 1
            streak = 0
            print(f"[{n}/{len(rows)}] saved item {r['item_id']} ({dest.stat().st_size / 1e6:.1f} MB)", flush=True)
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
