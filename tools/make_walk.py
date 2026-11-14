"""Build the data file for the walk-through gallery and put it in the bucket.

Usage: python make_walk.py <data_dir> <work_dir> <public_root_url> [--no-upload]

Every published object becomes one work on the gallery wall, in date order
(undated works come last). The result is written to <work_dir>/web/walk/works.json
and uploaded to r2:<bucket>/web/walk/works.json, where the site's GalleryWalk
component reads it. Because the file lives in the bucket, the walk picks up newly
published works without a new build of the site; only their links to item pages
wait for the next build.
"""
import csv
import json
import subprocess
import sys
from pathlib import Path

BUCKET = "r2:sicalipsis-files"
data, work, root = Path(sys.argv[1]), Path(sys.argv[2]), sys.argv[3].rstrip("/")
base = f"{root}/web"
state = json.loads((data / "published" / "published.json").read_text(encoding="utf-8"))
with open(data / "published" / "rows.csv", encoding="utf-8-sig", newline="") as fh:
    rows = [r for r in csv.DictReader(fh) if r["objectid"] in state]

works = []
for r in rows:
    thumb = state[r["objectid"]]["ref"]["thumbnail"][0]
    works.append({
        "id": r["objectid"], "title": r["title"], "creator": r["creator"],
        "date": r["date_original"] or r["date"], "sort": r["date"] or "9999",
        "year": r["date"][:4], "section": r["section"], "series": r["series"],
        "thumb": f"{base}/images/{r['objectid']}/thumb.jpg",
        "image": f"{base}/images/{r['objectid']}/0001.jpg",
        "w": thumb["width"], "h": thumb["height"], "pages": state[r["objectid"]]["pages"],
    })
works.sort(key=lambda w: (w["sort"], w["section"], w["title"]))
out = work / "web" / "walk" / "works.json"
out.parent.mkdir(parents=True, exist_ok=True)
out.write_text(json.dumps({"webBase": base, "works": works}, ensure_ascii=False), encoding="utf-8")
dated = sum(1 for w in works if w["year"])
years = sorted({w["year"] for w in works if w["year"]})
print(f"{len(works)} works ({dated} dated, {years[0] if years else '-'} to {years[-1] if years else '-'}; "
      f"{len(works) - dated} undated) -> {out}")
if "--no-upload" not in sys.argv:
    result = subprocess.run(["rclone", "copyto", str(out), f"{BUCKET}/web/walk/works.json"],
                            capture_output=True, text=True)
    print("uploaded to the bucket" if result.returncode == 0 else f"upload failed: {result.stderr[-200:]}")
