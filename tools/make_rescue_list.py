"""List the Omeka files that must be saved from the Omeka server because Box has
no confirmed copy: files with no Box counterpart, plus title matches still marked
"check". Usage: python make_rescue_list.py <data_dir>"""
import csv
import sys
from pathlib import Path

data = Path(sys.argv[1])
rec = data / "reconciliation"


def read_csv(path):
    with open(path, encoding="utf-8-sig", newline="") as fh:
        return list(csv.DictReader(fh))


files = {f["item_id"]: f for f in read_csv(data / "omeka" / "files.csv")}
paired = {m["omeka_item_id"]: m for m in read_csv(rec / "title_matches.csv")}
rows = []
for o in read_csv(rec / "omeka_only.csv"):
    m = paired.get(o["item_id"])
    if m and m["confidence"] == "high":
        continue  # an OCR'd version of this work is in Box
    f = files[o["item_id"]]
    rows.append({
        "item_id": o["item_id"], "title": " ".join(o["title"].split()),
        "collection": o["collection"], "ext": o["ext"],
        "reason": "uncertain title match in Box" if m else "no copy in Box",
        "possible_box_file": m["box_path"] if m else "",
        "stored_name": f["stored_name"], "omeka_md5": f["omeka_md5"], "src": f["src"],
    })
rows.sort(key=lambda r: (r["reason"], r["collection"], int(r["item_id"])))
with open(rec / "rescue_list.csv", "w", encoding="utf-8-sig", newline="") as fh:
    w = csv.DictWriter(fh, fieldnames=list(rows[0]))
    w.writeheader()
    w.writerows(rows)
(rec / "rescue_filenames.txt").write_text("\n".join(r["stored_name"] for r in rows) + "\n", encoding="utf-8")
from collections import Counter
print(len(rows), "files to save:", dict(Counter((r["reason"], r["ext"]) for r in rows)))
