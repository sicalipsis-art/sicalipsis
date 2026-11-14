"""Second-pass reconciliation: pair Omeka files that have no identical copy in Box
with Box PDFs that have no identical copy in Omeka, by comparing titles.

Usage: python match_titles.py <data_dir>

Reads  <data_dir>/reconciliation/{omeka_only,box_only}.csv (from reconcile.py).
Writes title_matches.csv (pairs to review), omeka_unresolved.csv, box_unresolved.csv.
These are suggestions: the files differ byte-for-byte, so a person should confirm.
"""
import csv
import re
import sys
import unicodedata
from difflib import SequenceMatcher
from pathlib import Path

rec = Path(sys.argv[1]) / "reconciliation"
THRESHOLD = 0.80


def read_csv(path):
    with open(path, encoding="utf-8-sig", newline="") as fh:
        return list(csv.DictReader(fh))


def write_csv(path, rows, cols):
    with open(path, "w", encoding="utf-8-sig", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=cols, extrasaction="ignore", restval="")
        w.writeheader()
        w.writerows(rows)


def norm(s):
    s = unicodedata.normalize("NFKD", s)
    s = "".join(c for c in s if not unicodedata.combining(c)).lower()
    s = re.sub(r"\.pdf$", "", s.strip())
    s = re.sub(r"[^a-z0-9]+", " ", s)
    return re.sub(r"\s+", " ", s).strip()


def box_candidates(path):
    stem = path.rsplit("/", 1)[-1].rsplit(".", 1)[0]
    cands = {norm(stem)}
    if "_" in stem:
        cands.add(norm(stem.split("_", 1)[1]))
        cands.add(norm(stem.rsplit("_", 1)[1]))
    return {c for c in cands if c}


def score(omeka_title, cands):
    best, how = 0.0, ""
    for c in cands:
        if len(c) >= 8 and c in omeka_title:
            s = 0.90 + 0.10 * len(c) / len(omeka_title)
            if s > best:
                best, how = s, "Box title appears inside Omeka title"
        elif len(omeka_title) >= 8 and omeka_title in c:
            s = 0.90 + 0.10 * len(omeka_title) / len(c)
            if s > best:
                best, how = s, "Omeka title appears inside Box name"
        else:
            s = SequenceMatcher(None, omeka_title, c).ratio()
            if s > best:
                best, how = s, "similar wording"
    return best, how


omeka = [r for r in read_csv(rec / "omeka_only.csv") if r["ext"] == "pdf"]
box = [r for r in read_csv(rec / "box_only.csv") if r["ext"] == "pdf"]
for r in omeka:
    # Drop leading issue numbers such as "25. " or "#154. " before comparing.
    r["_n"] = re.sub(r"^(numero )?\d+ ", "", norm(r["title"]))
for r in box:
    r["_c"] = box_candidates(r["box_path"])

pairs = []
for i, o in enumerate(omeka):
    for j, b in enumerate(box):
        s, how = score(o["_n"], b["_c"])
        if s >= THRESHOLD:
            pairs.append((s, i, j, how))
pairs.sort(reverse=True)

used_o, used_b, matches = set(), set(), []
for s, i, j, how in pairs:
    if i in used_o or j in used_b:
        continue
    used_o.add(i)
    used_b.add(j)
    o, b = omeka[i], box[j]
    matches.append({
        "omeka_item_id": o["item_id"], "omeka_url": o["url"], "omeka_title": o["title"],
        "omeka_collection": o["collection"], "box_path": b["box_path"],
        "box_size_bytes": b["size_bytes"], "score": f"{s:.2f}", "basis": how,
        "confidence": "high" if s >= 0.93 else "check",
    })

matches.sort(key=lambda m: (m["omeka_collection"], m["omeka_title"]))
write_csv(rec / "title_matches.csv", matches,
          ["confidence", "score", "basis", "omeka_item_id", "omeka_title", "omeka_collection",
           "box_path", "box_size_bytes", "omeka_url"])
left_o = [o for i, o in enumerate(omeka) if i not in used_o]
left_b = [b for j, b in enumerate(box) if j not in used_b]
write_csv(rec / "omeka_unresolved.csv", left_o,
          ["item_id", "url", "title", "collection", "item_type", "ext", "omeka_md5", "src"])
write_csv(rec / "box_unresolved.csv", left_b,
          ["box_path", "section", "series", "size_bytes", "box_modified", "md5", "sha1"])

high = sum(1 for m in matches if m["confidence"] == "high")
print(f"Omeka PDFs without an identical Box file : {len(omeka)}")
print(f"Box PDFs without an identical Omeka file : {len(box)}")
print(f"paired by title                          : {len(matches)} ({high} high confidence, {len(matches) - high} to check)")
print(f"Omeka PDFs still unresolved              : {len(left_o)}")
print(f"Box PDFs still unresolved                : {len(left_b)}")
print("\nlowest-scoring pairs:")
for m in sorted(matches, key=lambda m: m["score"])[:8]:
    print(f"  {m['score']}  {m['omeka_title'][:55]!r}  <->  {m['box_path'].rsplit('/', 1)[-1][:55]!r}")
print("\nunresolved Omeka (sample):")
for o in left_o[:12]:
    print(f"  {o['item_id']:>5}  {o['collection'][:28]:28}  {o['title'][:70]}")
print("\nunresolved Box (sample):")
for b in left_b[:12]:
    print(f"  {b['box_path'].split('/', 1)[-1][:100]}")
