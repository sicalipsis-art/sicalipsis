"""Harvest public Omeka Classic metadata through the omeka-xml output format.

Usage: python harvest_omeka.py <base_url> <out_dir>

Saves every raw XML page, then writes items.csv, files.csv and collections.csv.
Only metadata is fetched; file sizes come from HEAD requests. Safe to re-run:
pages and sizes already on disk are reused.
"""
import csv
import json
import math
import re
import sys
import time
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET
from collections import Counter
from pathlib import Path

UA = "Mozilla/5.0 (compatible; collection-inventory/1.0)"
PAGE_DELAY = 2.0  # seconds between page requests; the server was recently moved
HEAD_DELAY = 1.0  # seconds between file size checks


def fetch(url, method="GET", tries=2):
    err = None
    for attempt in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA}, method=method)
            with urllib.request.urlopen(req, timeout=60) as resp:
                body = resp.read() if method == "GET" else b""
                return resp.status, resp.headers, body
        except urllib.error.HTTPError as exc:
            if exc.code in (403, 404, 410):
                return exc.code, exc.headers, b""
            err = exc
        except Exception as exc:  # network errors: retry with backoff
            err = exc
        time.sleep(2 * (attempt + 1))
    raise err


def local(el):
    return el.tag.rsplit("}", 1)[-1]


def kids(el, name):
    return [c for c in el if local(c) == name]


def kid(el, name):
    found = kids(el, name)
    return found[0] if found else None


def text_of(el, name):
    c = kid(el, name) if el is not None else None
    return (c.text or "").strip() if c is not None else ""


def slug(s):
    return re.sub(r"[^a-z0-9]+", "_", s.lower()).strip("_")


def element_texts(owner):
    """Return {column: [values]} for every element set attached to owner."""
    out = {}
    container = kid(owner, "elementSetContainer")
    if container is None:
        return out
    for es in kids(container, "elementSet"):
        set_name = text_of(es, "name")
        prefix = "dc" if set_name == "Dublin Core" else slug(set_name)
        ec = kid(es, "elementContainer")
        if ec is None:
            continue
        for el in kids(ec, "element"):
            col = f"{prefix}_{slug(text_of(el, 'name'))}"
            tc = kid(el, "elementTextContainer")
            vals = [text_of(t, "text") for t in kids(tc, "elementText")] if tc is not None else []
            out.setdefault(col, []).extend(v for v in vals if v)
    return out


def item_type_texts(item_type):
    out = {}
    ec = kid(item_type, "elementContainer")
    if ec is None:
        return out
    for el in kids(ec, "element"):
        col = f"itemtype_{slug(text_of(el, 'name'))}"
        tc = kid(el, "elementTextContainer")
        vals = [text_of(t, "text") for t in kids(tc, "elementText")] if tc is not None else []
        out.setdefault(col, []).extend(v for v in vals if v)
    return out


def pagination(root):
    misc = kid(root, "miscellaneousContainer")
    pag = kid(misc, "pagination") if misc is not None else None
    if pag is None:
        return 1, 0
    return int(text_of(pag, "perPage") or 10), int(text_of(pag, "totalResults") or 0)


def get_page(base, raw_dir, n):
    path = raw_dir / f"items-page-{n:04d}.xml"
    if path.exists() and path.stat().st_size > 200:
        return path.read_bytes()
    status, _, body = fetch(f"{base}/items/browse?output=omeka-xml&page={n}")
    if status != 200:
        raise RuntimeError(f"page {n}: HTTP {status}")
    ET.fromstring(body)  # refuse to cache anything that is not well-formed XML
    path.write_bytes(body)
    time.sleep(PAGE_DELAY)
    return body


def head_size(src):
    try:
        status, headers, _ = fetch(src, method="HEAD")
        return src, {
            "status": status,
            "size": int(headers.get("Content-Length") or 0) if status == 200 else 0,
            "last_modified": headers.get("Last-Modified", "") if status == 200 else "",
        }
    except Exception as exc:
        return src, {"status": f"error: {exc}", "size": 0, "last_modified": ""}


def main():
    base = sys.argv[1].rstrip("/")
    out = Path(sys.argv[2])
    raw_dir = out / "raw"
    raw_dir.mkdir(parents=True, exist_ok=True)

    first = ET.fromstring(get_page(base, raw_dir, 1))
    per_page, total = pagination(first)
    pages = max(1, math.ceil(total / per_page))
    print(f"{total} items, {per_page} per page, {pages} pages", flush=True)

    items, files, collections = [], [], {}
    for n in range(1, pages + 1):
        root = ET.fromstring(get_page(base, raw_dir, n))
        for item in kids(root, "item"):
            item_id = item.get("itemId")
            row = {
                "item_id": item_id,
                "public": item.get("public", ""),
                "featured": item.get("featured", ""),
                "item_type": "",
                "collection_id": "",
                "collection_title": "",
                "url": f"{base}/items/show/{item_id}",
            }
            it = kid(item, "itemType")
            fields = element_texts(item)
            if it is not None:
                row["item_type"] = text_of(it, "name")
                fields.update(item_type_texts(it))
            coll = kid(item, "collection")
            if coll is not None:
                cid = coll.get("collectionId")
                cfields = {k: " | ".join(v) for k, v in element_texts(coll).items()}
                row["collection_id"] = cid
                row["collection_title"] = cfields.get("dc_title", "")
                collections.setdefault(cid, {"collection_id": cid, "item_count": 0, **cfields})
                collections[cid]["item_count"] += 1
            tc = kid(item, "tagContainer")
            row["tags"] = " | ".join(text_of(t, "name") for t in kids(tc, "tag")) if tc is not None else ""
            fc = kid(item, "fileContainer")
            item_files = kids(fc, "file") if fc is not None else []
            row["file_count"] = len(item_files)
            for pos, f in enumerate(item_files, 1):
                src = text_of(f, "src")
                stored = src.rsplit("/", 1)[-1]
                frow = {
                    "file_id": f.get("fileId"),
                    "item_id": item_id,
                    "position": pos,
                    "src": src,
                    "stored_name": stored,
                    "ext": stored.rsplit(".", 1)[-1].lower() if "." in stored else "",
                    "omeka_md5": text_of(f, "authentication"),
                }
                frow.update({f"file_{k}": " | ".join(v) for k, v in element_texts(f).items()})
                files.append(frow)
            row.update({k: " | ".join(v) for k, v in fields.items()})
            items.append(row)
        if n % 20 == 0 or n == pages:
            print(f"  parsed page {n}/{pages}", flush=True)

    sizes_path = out / "sizes.json"
    sizes = json.loads(sizes_path.read_text()) if sizes_path.exists() else {}
    todo = [f["src"] for f in files if sizes.get(f["src"], {}).get("status") != 200]
    if "--no-sizes" in sys.argv:
        print(f"{len(files)} files; size check skipped (--no-sizes)", flush=True)
        todo = []
    else:
        print(f"{len(files)} files; checking size of {len(todo)}", flush=True)
    # One request at a time, and give up as soon as the server stops answering,
    # so a struggling server is never retried in a loop.
    failures = 0
    for i, src in enumerate(todo, 1):
        _, info = head_size(src)
        sizes[src] = info
        failures = 0 if info["status"] == 200 else failures + 1
        if failures >= 3:
            print(f"  stopping size check: 3 consecutive failures at file {i}", flush=True)
            break
        if i % 100 == 0:
            sizes_path.write_text(json.dumps(sizes))
            print(f"  sized {i}/{len(todo)}", flush=True)
        time.sleep(HEAD_DELAY)
    sizes_path.write_text(json.dumps(sizes))
    for f in files:
        info = sizes.get(f["src"], {})
        f["size_bytes"] = info.get("size", 0)
        f["last_modified"] = info.get("last_modified", "")
        f["head_status"] = info.get("status", "")

    def write(name, rows, lead):
        cols = lead + sorted({k for r in rows for k in r} - set(lead))
        with open(out / name, "w", newline="", encoding="utf-8-sig") as fh:
            w = csv.DictWriter(fh, fieldnames=cols, restval="")
            w.writeheader()
            w.writerows(rows)

    write("items.csv", items,
          ["item_id", "url", "public", "featured", "item_type", "collection_id",
           "collection_title", "file_count", "tags"])
    write("files.csv", files,
          ["file_id", "item_id", "position", "src", "stored_name", "ext", "omeka_md5",
           "size_bytes", "last_modified", "head_status"])
    write("collections.csv", sorted(collections.values(), key=lambda c: int(c["collection_id"])),
          ["collection_id", "item_count"])

    total_bytes = sum(f["size_bytes"] for f in files)
    md5s = Counter(f["omeka_md5"] for f in files if f["omeka_md5"])
    print("\nSUMMARY")
    print(f"items harvested      : {len(items)} (site reports {total})")
    print(f"unique item ids      : {len({r['item_id'] for r in items})}")
    print(f"files                : {len(files)}")
    print(f"total size           : {total_bytes / 1e9:.2f} GB")
    print(f"by extension         : {dict(Counter(f['ext'] for f in files))}")
    print(f"size by extension GB : { {e: round(sum(f['size_bytes'] for f in files if f['ext'] == e) / 1e9, 2) for e in {f['ext'] for f in files}} }")
    print(f"HEAD not 200         : {sum(1 for f in files if f['head_status'] != 200)}")
    print(f"items with 0 files   : {sum(1 for r in items if r['file_count'] == 0)}")
    print(f"items with >1 file   : {sum(1 for r in items if r['file_count'] > 1)}")
    print(f"max files on an item : {max((r['file_count'] for r in items), default=0)}")
    print(f"files missing md5    : {sum(1 for f in files if not f['omeka_md5'])}")
    print(f"duplicate md5 groups : {sum(1 for c in md5s.values() if c > 1)}")
    print(f"largest file MB      : {max((f['size_bytes'] for f in files), default=0) / 1e6:.0f}")
    print(f"items by type        : {dict(Counter(r['item_type'] for r in items))}")
    print(f"items w/o collection : {sum(1 for r in items if not r['collection_id'])}")
    print(f"collections seen     : {len(collections)}")
    print(f"metadata columns     : {sorted({k for r in items for k in r if k.startswith(('dc_', 'itemtype_'))})}")


if __name__ == "__main__":
    main()
