"""Lay thumbnails out on numbered contact sheets, for labelling and for checking labels.

Usage: python contact_sheets.py <thumb_dir> <out_dir> [--per-row 4] [--rows 4] [--cell 300]

<thumb_dir> holds one folder per object with a thumb.jpg inside (the layout of
web/images/ in the bucket). Each sheet shows per-row x rows pictures, each with
its objectid underneath, and is saved as <out_dir>/sheet_NNN.jpg. The file
<out_dir>/sheets.csv lists which object is on which sheet.
"""
import csv
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont, ImageOps


def option(name, default):
    return int(sys.argv[sys.argv.index(name) + 1]) if name in sys.argv else default


def main():
    thumbs, out = Path(sys.argv[1]), Path(sys.argv[2])
    per_row, n_rows, cell = option("--per-row", 4), option("--rows", 4), option("--cell", 300)
    caption = 26
    out.mkdir(parents=True, exist_ok=True)
    ids = sorted(p.parent.name for p in thumbs.glob("*/thumb.jpg"))
    try:
        font = ImageFont.truetype("arialbd.ttf", 20)
    except OSError:
        font = ImageFont.load_default()
    per_sheet = per_row * n_rows
    listing = []
    for s in range(0, len(ids), per_sheet):
        sheet_no = s // per_sheet + 1
        sheet = Image.new("RGB", (per_row * cell, n_rows * (cell + caption)), "white")
        draw = ImageDraw.Draw(sheet)
        for k, oid in enumerate(ids[s:s + per_sheet]):
            x, y = (k % per_row) * cell, (k // per_row) * (cell + caption)
            with Image.open(thumbs / oid / "thumb.jpg") as im:
                im = ImageOps.contain(im.convert("RGB"), (cell - 8, cell - 8))
            sheet.paste(im, (x + (cell - im.width) // 2, y + (cell - im.height) // 2))
            draw.text((x + cell // 2, y + cell + caption // 2 - 2), oid, fill="black", font=font, anchor="mm")
            listing.append({"sheet": f"sheet_{sheet_no:03d}.jpg", "position": k + 1, "objectid": oid})
        sheet.save(out / f"sheet_{sheet_no:03d}.jpg", quality=88)
    with open(out / "sheets.csv", "w", encoding="utf-8-sig", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=["sheet", "position", "objectid"])
        w.writeheader()
        w.writerows(listing)
    print(f"{len(ids)} pictures on {-(-len(ids) // per_sheet)} sheets -> {out}")


if __name__ == "__main__":
    main()
