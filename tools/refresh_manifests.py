"""Bring published manifests up to date with the master spreadsheet.

Usage: python refresh_manifests.py <data_dir> <work_dir>

When titles, dates or other metadata change in the master spreadsheet, the
manifests already in the bucket still carry the old values. This downloads every
published manifest, rewrites only its descriptive part (label, metadata, summary,
navDate) from the spreadsheet, and uploads the ones that changed. Page images are
not touched. It also rewrites <data_dir>/published/rows.csv from the spreadsheet.
"""
import csv
import json
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from make_iiif import describe  # noqa: E402

BUCKET = "r2:sicalipsis-files"
data, work = Path(sys.argv[1]), Path(sys.argv[2])
local = work / "iiif-refresh"


def rclone(*args):
    result = subprocess.run(["rclone", *args], capture_output=True, text=True, encoding="utf-8")
    if result.returncode != 0:
        raise SystemExit(f"rclone {args[0]} failed: {result.stderr.strip()[-300:]}")


with open(data / "master" / "sicalipsis.csv", encoding="utf-8-sig", newline="") as fh:
    rows = list(csv.DictReader(fh))
by_id = {r["objectid"]: r for r in rows}
state = json.loads((data / "published" / "published.json").read_text(encoding="utf-8"))

rclone("sync", f"{BUCKET}/web/iiif", str(local), "--include", "*/manifest.json", "--transfers", "16")
changed = []
for path in sorted(local.glob("*/manifest.json")):
    oid = path.parent.name
    if oid not in by_id:
        continue
    manifest = json.loads(path.read_text(encoding="utf-8"))
    new = describe(by_id[oid])
    before = {k: manifest.get(k) for k in ("label", "metadata", "summary", "navDate")}
    after = {k: new.get(k) for k in ("label", "metadata", "summary", "navDate")}
    if before == after:
        continue
    for key in ("label", "metadata", "summary", "navDate"):
        if key in new:
            manifest[key] = new[key]
        else:
            manifest.pop(key, None)
    path.write_text(json.dumps(manifest, ensure_ascii=False, indent=1), encoding="utf-8")
    changed.append(oid)
    if oid in state:
        state[oid]["ref"]["label"] = new["label"]
for oid in changed:
    rclone("copyto", str(local / oid / "manifest.json"), f"{BUCKET}/web/iiif/{oid}/manifest.json")
(data / "published" / "published.json").write_text(json.dumps(state, ensure_ascii=False), encoding="utf-8")
order = {r["objectid"]: n for n, r in enumerate(rows)}
published = sorted((k for k in state if k in by_id), key=order.get)
with open(data / "published" / "rows.csv", "w", encoding="utf-8-sig", newline="") as fh:
    w = csv.DictWriter(fh, fieldnames=list(rows[0]))
    w.writeheader()
    w.writerows(by_id[k] for k in published)
print(f"{len(list(local.glob('*/manifest.json')))} manifests checked, {len(changed)} updated in the bucket; "
      f"rows.csv rewritten for {len(published)} published objects")
