"""Reconcile the Omeka file inventory with the Box folder by MD5 checksum.

Usage: python reconcile.py <data_dir>

Reads  <data_dir>/omeka/{items,files}.csv, <data_dir>/box/box_listing.json and
       <data_dir>/box/md5/*.md5 (rclone hashsum output, one file per top folder).
Writes <data_dir>/reconciliation/{box_files,omeka_only,box_only,summary}.*
"""
import csv
import json
import sys
from collections import Counter, defaultdict
from pathlib import Path

data = Path(sys.argv[1])
out = data / "reconciliation"
out.mkdir(exist_ok=True)


def read_csv(path):
    with open(path, encoding="utf-8-sig", newline="") as fh:
        return list(csv.DictReader(fh))


def write_csv(path, rows, cols):
    with open(path, "w", encoding="utf-8-sig", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=cols, extrasaction="ignore", restval="")
        w.writeheader()
        w.writerows(rows)


items = {r["item_id"]: r for r in read_csv(data / "omeka" / "items.csv")}
omeka_files = read_csv(data / "omeka" / "files.csv")
listing = json.loads((data / "box" / "box_listing.json").read_text(encoding="utf-8"))

# The .md5 files are named after their top-level folder with spaces and commas
# replaced by underscores; rebuild that mapping from the listing itself.
tops = {r["Path"].split("/")[0] for r in listing}
by_stem = {t.replace(" ", "_").replace(",", "_"): t for t in tops}
box_md5 = {}
for path in sorted((data / "box" / "md5").glob("*.md5")):
    top = by_stem[path.stem]
    for line in path.read_text(encoding="utf-8").splitlines():
        digest, _, rel = line.partition("  ")
        if digest and rel:
            box_md5[f"{top}/{rel}"] = digest

omeka_by_md5 = defaultdict(list)
for f in omeka_files:
    omeka_by_md5[f["omeka_md5"]].append(f)

box_rows, matched_md5 = [], set()
for r in sorted(listing, key=lambda r: r["Path"]):
    md5 = box_md5.get(r["Path"], "")
    hits = omeka_by_md5.get(md5, []) if md5 else []
    if hits:
        matched_md5.add(md5)
    parts = r["Path"].split("/")
    box_rows.append({
        "box_path": r["Path"],
        "section": parts[0],
        "series": parts[1] if len(parts) > 2 else "",
        "ext": r["Name"].rsplit(".", 1)[-1].lower(),
        "size_bytes": r["Size"],
        "box_modified": r["ModTime"][:10],
        "sha1": r["Hashes"]["sha1"],
        "md5": md5,
        "status": "not hashed yet" if not md5 else ("in Omeka" if hits else "Box only"),
        "omeka_item_ids": " | ".join(h["item_id"] for h in hits),
        "omeka_titles": " | ".join(items[h["item_id"]].get("dc_title", "") for h in hits),
        "omeka_collections": " | ".join(sorted({items[h["item_id"]].get("collection_title", "").strip() for h in hits})),
    })

omeka_only = []
for f in omeka_files:
    if f["omeka_md5"] not in matched_md5:
        it = items[f["item_id"]]
        omeka_only.append({
            "item_id": f["item_id"], "url": it["url"], "title": it.get("dc_title", ""),
            "collection": it.get("collection_title", "").strip(), "item_type": it["item_type"],
            "ext": f["ext"], "omeka_md5": f["omeka_md5"], "src": f["src"],
        })

box_cols = ["box_path", "section", "series", "ext", "size_bytes", "box_modified", "status",
            "omeka_item_ids", "omeka_titles", "omeka_collections", "md5", "sha1"]
write_csv(out / "box_files.csv", box_rows, box_cols)
write_csv(out / "box_only.csv", [r for r in box_rows if r["status"] == "Box only"], box_cols)
write_csv(out / "omeka_only.csv", omeka_only,
          ["item_id", "url", "title", "collection", "item_type", "ext", "omeka_md5", "src"])

hashed = [r for r in box_rows if r["md5"]]
lines = []
add = lines.append
add(f"Box files listed            : {len(box_rows)} ({sum(r['size_bytes'] for r in box_rows) / 1e9:.2f} GB)")
add(f"Box files hashed            : {len(hashed)} (missing: {len(box_rows) - len(hashed)})")
add(f"Omeka files                 : {len(omeka_files)} ({len(omeka_by_md5)} distinct by content)")
add(f"Omeka files found in Box    : {sum(1 for f in omeka_files if f['omeka_md5'] in matched_md5)}")
add(f"Omeka files NOT in Box      : {len(omeka_only)}")
add(f"Box files matching Omeka    : {sum(1 for r in box_rows if r['status'] == 'in Omeka')}")
add(f"Box files not in Omeka      : {sum(1 for r in box_rows if r['status'] == 'Box only')}")
add("")
add("Box files by section (in Omeka / Box only / not hashed):")
sec = defaultdict(Counter)
for r in box_rows:
    sec[(r["section"], r["ext"])][r["status"]] += 1
for (s, e), c in sorted(sec.items()):
    add(f"  {c['in Omeka']:5} / {c['Box only']:5} / {c['not hashed yet']:4}  {e:4}  {s}")
add("")
add("Omeka files not in Box, by collection and type:")
oc = Counter((r["collection"] or "(no collection)", r["ext"]) for r in omeka_only)
for (c, e), n in sorted(oc.items(), key=lambda kv: -kv[1]):
    add(f"  {n:5}  {e:4}  {c}")
(out / "summary.txt").write_text("\n".join(lines) + "\n", encoding="utf-8")
print("\n".join(lines))
