"""Choose a small representative pilot set from the master spreadsheet.

Usage: python pilot_select.py <master_csv> <box_files_csv> <out_dir>
Writes pilot.csv (rows from the master) and files-from.txt (Box paths for rclone).
"""
import csv
import random
import sys
from pathlib import Path

master, box_csv, out = sys.argv[1], sys.argv[2], Path(sys.argv[3])
out.mkdir(parents=True, exist_ok=True)
rows = list(csv.DictReader(open(master, encoding="utf-8-sig", newline="")))
size = {r["box_path"]: int(r["size_bytes"]) for r in csv.DictReader(open(box_csv, encoding="utf-8-sig", newline=""))}
random.seed(1900)


def ok(r, max_mb):
    return (r["omeka_item_id"] and r["box_path"] and r["file_status"] in ("in Box (identical)", "in Box (OCR version)")
            and size.get(r["box_path"], 10**12) <= max_mb * 1e6)


pick = []
gallery = [r for r in rows if r["section"] == "Image Gallery" and r["format"] == "image/jpeg"
           and r["creator"] and r["date"] and ok(r, 15)]
pick += random.sample(gallery, 24)
for series, n in [("FLIRT", 2), ("COSQUILLAS", 2), ("KDT", 1), ("SEXUALIDAD", 3), ("LA NOVELA SUGESTIVA", 4),
                  ("COLECCIÓN PLACER", 2), ("GARMA, DR. ÁNGEL", 2), ("HILDEGART, RODRÍGUEZ CABALLEIRA", 2),
                  ("BIOFILIA", 3)]:
    cands = [r for r in rows if r["series"] == series and r["format"] == "application/pdf" and ok(r, 12)]
    pick += sorted(cands, key=lambda r: size[r["box_path"]])[:n]

with open(out / "pilot.csv", "w", encoding="utf-8-sig", newline="") as fh:
    w = csv.DictWriter(fh, fieldnames=list(rows[0]))
    w.writeheader()
    w.writerows(pick)
(out / "files-from.txt").write_text("\n".join(r["box_path"] for r in pick) + "\n", encoding="utf-8")
from collections import Counter
print(len(pick), "pilot items:", dict(Counter(r["section"] for r in pick)))
print(f"total download: {sum(size[r['box_path']] for r in pick) / 1e6:.0f} MB")
