"""Bring batches of readings into master/enrichment.csv and write a review sheet.

Usage: python merge_readings.py <data_dir> <work_dir> <public_root_url>

Reads <work_dir>/enrich/found_g*.csv (one row per object: what is written on the
item, a title, and any maker, publisher, series or date the item itself
carries), applies the editorial decisions listed below, and

  - adds the rows to <data_dir>/master/enrichment.csv, replacing earlier rows
    for the same objects (build_master.py then applies them: a generic title is
    replaced and kept in title_original; other values only fill empty fields);
  - writes <data_dir>/master/review_gallery_titles.xlsx, one row per object with
    the old and new title, a link to the picture, and empty columns for a
    curator's decision.

Editorial decisions made here, so that they are on record:
  - a caption printed in capitals is given in sentence case (the inscription
    keeps the exact form);
  - records that show the same card get the same title and a note naming each
    other; where a caption recurs on different cards of one series the card
    number is added in square brackets;
  - a name that may be the sitter's, a film director's credit, and a maker's
    name that cannot be read with confidence are not entered as creator;
  - a year that may be a registration number, and the year of a painting that a
    card reproduces, are not entered as the card's date;
  - publishers are given as "Name (mark)" where the name is an expansion of a
    monogram on the card.
"""
import csv
import re
import sys
from pathlib import Path

COLUMNS = ["objectid", "inscription", "title", "title_source", "creator", "creator_basis", "publisher", "place",
           "series", "date", "date_basis", "description", "sources", "confidence", "note"]

TITLES = {
    "sic00320": "A travers les coulisses [no. 1089]",
    "sic00323": "A travers les coulisses [no. 1088]",
    "sic00322": "Fotografias estereoscópicas. Sèrie 2ª",
    "sic00444": "Peinture moderne",
    "sic00446": "Femme égyptienne",
    "sic00451": "\"La Mucura\". Yo si puedo con ella",
    "sic00456": "La danse du ventre",
    "sic00462": "Skipper or mate wanted for a trim little craft. / À pleines voiles!",
    "sic00496": "Etude académique",
    "sic00411": "Lebender Marmor [no. 5944/5]",
    "sic00464": "Lebender Marmor [no. 5944/5]",
    "sic00488": "Lebender Marmor [no. 5944/4]",
    "sic00494": "Escucha y no huyas, mujer seductora / Mi pecho por ti, amor atesora.",
    "sic00414": "[Couple standing close, woman holding a garland of roses]",
    "sic00425": "[Couple on a swing, man kissing woman's temple]",
    "sic00436": "[Two photographs of a woman between two nude men, nos. 911 and 912]",
    "sic00535": "[Two photographs of a woman between two nude men, nos. 911 and 912]",
    "sic00460": "[Nude women swimming in waves under lighthouse beams]",
    "sic00461": "[Woman in striped bathing suit seated in an open mussel shell]",
}
# Records that show the same card (same number or caption, and the same picture).
SAME_CARD = [("sic00411", "sic00464"), ("sic00424", "sic00474"), ("sic00426", "sic00494"), ("sic00414", "sic00524"),
             ("sic00425", "sic00439"), ("sic00436", "sic00535"), ("sic00460", "sic00487"), ("sic00483", "sic00533"),
             ("sic00461", "sic00513"), ("sic00085", "sic00096"), ("sic00086", "sic00091")]
EXTRA_NOTES = {
    "sic00461": "The same picture as sic00531, \"Gute Beute aus dem Muschelfang\", without its caption.",
    "sic00488": "Another card of the series that includes sic00411 and sic00464 (no. 5944/5).",
}
NO_CREATOR = {
    "sic00395": "\"Prince\" is signed in the image; it may name the studio or the sitter, so no creator is entered.",
    "sic00435": "The photographer's credit cannot be read with confidence (Fialdro or Fialoro), so no creator is entered.",
    "sic00458": "Credited on the card: \"Regie: Wilhelm Prager\" (the film's director, not the photographer), so no creator is entered.",
}
NO_DATE = {
    "sic00424": "\"1925\" is printed in the inset photograph; it may be a registration number, so no date is entered.",
    "sic00474": "\"1925\" is printed in the inset photograph; it may be a registration number, so no date is entered.",
    "sic00502": "The painting reproduced is dated 1907 beside its signature; that is not the date of the card, so no date is entered.",
}
DATES = {
    "sic00407": ("1902", "a handwritten message on the card is dated 31 October 1902"),
    "sic00529": ("1910", "the printed caption names the Salon of 1910, where the painting reproduced was shown"),
}
PUBLISHERS = {
    "sic00394": "Etoile", "sic00395": "Éditeurs d'Art (monogram K.F. or K.E.)",
    "sic00407": "Neue Photographische Gesellschaft (NPG)", "sic00491": "Neue Photographische Gesellschaft (NPG)",
    "sic00411": "Rotophot (RPH)", "sic00464": "Rotophot (RPH)", "sic00488": "Rotophot (RPH)",
    "sic00413": "Lydia", "sic00420": "Gustav Liersch & Co. (GL Co)", "sic00423": "PFB",
    "sic00428": "Berlin-Neuroder Kunstanstalten (B.N.K.)", "sic00523": "Berlin-Neuroder Kunstanstalten (B.N.K.)",
    "sic00430": "P.C.", "sic00449": "P.C.", "sic00433": "Opera", "sic00434": "Léo", "sic00515": "Léo",
    "sic00435": "Künzli Frères (KF, Éditeurs d'Art)",
    "sic00446": "S.I.P. (Société Industrielle de Photographie)", "sic00456": "S.I.P. (Société Industrielle de Photographie)",
    "sic00527": "S.I.P. (Société Industrielle de Photographie)",
    "sic00460": "Wilhelm S. Schroeder Nachf. (WS+SB)", "sic00487": "Wilhelm S. Schroeder Nachf. (WS+SB)",
    "sic00502": "Neurdein (ND Phot)", "sic00529": "Neurdein (ND Phot)",
}
SERIES = {
    "sic00396": "three-star mark, no. 09012", "sic00414": "no. 282", "sic00524": "no. 282",
    "sic00416": "nos. 719, 726 and 722 (Types d'Orient)", "sic00417": "no. 719", "sic00418": "2831; 349",
    "sic00436": "nos. 911 and 912", "sic00535": "nos. 911 and 912", "sic00427": "star mark, no. 8047",
    "sic00460": "WS+SB 1216", "sic00487": "WS+SB 1216", "sic00468": "ED monogram, no. 92",
    "sic00469": "ED monogram, no. 96", "sic00534": "ED monogram, no. 98", "sic00476": "S L mark, no. 3175",
    "sic00477": "W monogram, Paris, no. 559", "sic00478": "", "sic00492": "", "sic00519": "no. 3117 (reading uncertain)",
    "sic00529": "ND Phot 4326 Gr.", "sic00502": "ND Phot, Salons de Paris, 2135 Gr.",
    "sic00474": "no. 1149", "sic00424": "no. 1149",
}


def add_note(row, text):
    if text and text not in row["note"]:
        row["note"] = (row["note"].rstrip() + " " + text).strip()


def main():
    data, work, root = Path(sys.argv[1]), Path(sys.argv[2]), sys.argv[3].rstrip("/")
    rows = []
    for path in sorted((work / "enrich").glob("found_g*.csv")):
        with open(path, encoding="utf-8-sig", newline="") as fh:
            rows += list(csv.DictReader(fh))
    by = {r["objectid"]: r for r in rows}
    assert len(by) == len(rows), "an object appears in two batches"

    for oid, title in TITLES.items():
        by[oid]["title"] = title
    for a, b in SAME_CARD:
        if by[a]["title_source"] == "supplied" and by[b]["title_source"] == "supplied" and a not in ("sic00085", "sic00086"):
            by[b]["title"] = by[a]["title"]
        add_note(by[a], f"Shows the same card as {b}." if b not in by[a]["note"] else "")
        add_note(by[b], f"Shows the same card as {a}." if a not in by[b]["note"] else "")
    for oid, text in EXTRA_NOTES.items():
        add_note(by[oid], text)
    for oid, text in NO_CREATOR.items():
        by[oid]["creator"] = by[oid]["creator_basis"] = ""
        add_note(by[oid], text)
    for oid, text in NO_DATE.items():
        by[oid]["date"] = by[oid]["date_basis"] = ""
        add_note(by[oid], text)
    for oid, (date, basis) in DATES.items():
        by[oid]["date"], by[oid]["date_basis"] = date, basis
    for oid, name in PUBLISHERS.items():
        by[oid]["publisher"] = name
    for oid, series in SERIES.items():
        by[oid]["series"] = series
    for r in rows:
        if re.fullmatch(r"[\d/]+", r["series"]):
            r["series"] = f"no. {r['series']}"
        for column in COLUMNS:
            r[column] = " ".join(r[column].split())
        assert r["title"] and r["title_source"] in ("transcribed", "supplied"), r["objectid"]

    # ----- master/enrichment.csv -----
    path = data / "master" / "enrichment.csv"
    with open(path, encoding="utf-8-sig", newline="") as fh:
        kept = [e for e in csv.DictReader(fh) if e["objectid"] not in by]
    with open(path, "w", encoding="utf-8-sig", newline="") as fh:
        writer = csv.DictWriter(fh, fieldnames=COLUMNS)
        writer.writeheader()
        writer.writerows(kept + sorted(rows, key=lambda r: r["objectid"]))
    print(f"enrichment.csv: {len(kept)} rows kept, {len(rows)} added")

    # ----- the review sheet -----
    from openpyxl import Workbook
    from openpyxl.styles import Alignment, Font
    with open(data / "master" / "sicalipsis.csv", encoding="utf-8-sig", newline="") as fh:
        master = {r["objectid"]: r for r in csv.DictReader(fh)}
    book = Workbook()
    sheet = book.active
    sheet.title = "Gallery titles"
    head = ["Object", "Picture", "Title until now", "New title", "Title is", "Text on the item", "Description",
            "Maker (from the item)", "Where the maker is named", "Publisher", "Place", "Series / number", "Date",
            "Date rests on", "Maker already in the catalogue", "How sure", "Notes for the curator", "Sources consulted",
            "Curator: approve / change to", "Curator: comments"]
    sheet.append(head)
    for r in sorted(rows, key=lambda r: r["objectid"]):
        m = master.get(r["objectid"], {})
        old = m.get("title_original") or m.get("title", "")
        sheet.append([r["objectid"], f"{root}/web/images/{r['objectid']}/thumb.jpg", old, r["title"], r["title_source"],
                      r["inscription"], r["description"], r["creator"], r["creator_basis"], r["publisher"], r["place"],
                      r["series"], r["date"], r["date_basis"], m.get("creator", "") if not r["creator"] else "",
                      r["confidence"], r["note"], r["sources"], "", ""])
        cell = sheet.cell(row=sheet.max_row, column=2)
        cell.hyperlink, cell.value, cell.font = cell.value, "open picture", Font(color="0563C1", underline="single")
    widths = [11, 13, 18, 48, 12, 40, 50, 20, 26, 30, 14, 24, 8, 30, 22, 9, 60, 30, 28, 28]
    for n, width in enumerate(widths, start=1):
        sheet.column_dimensions[sheet.cell(row=1, column=n).column_letter].width = width
    for cell in sheet[1]:
        cell.font = Font(bold=True)
    for line in sheet.iter_rows(min_row=1):
        for cell in line:
            cell.alignment = Alignment(wrap_text=True, vertical="top")
    sheet.freeze_panes = "E2"
    out = data / "master" / "review_gallery_titles.xlsx"
    book.save(out)
    print(f"review sheet: {len(rows)} rows -> {out}")


if __name__ == "__main__":
    main()
