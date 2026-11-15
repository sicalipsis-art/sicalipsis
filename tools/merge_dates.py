"""Bring dates found by bibliographic research into master/dates_researched.csv.

Usage: python merge_dates.py <data_dir> <work_dir>

Reads <work_dir>/dating/found_*.csv (objectid, date, date_kind, basis, source,
confidence, note: one row per undated object, from library catalogues,
bibliographies of the Spanish novela corta, and dates printed in the
publications) and writes <data_dir>/master/dates_researched.csv, which
build_master.py applies to records that still have no date.

What counts as a firm date and what as an estimate is decided here:

  firm      a source dates this very work, edition or issue, without hedging,
            and the researcher's confidence is high or medium.
  estimate  everything else: a library's "about" or question-mark date, a date
            worked out from the series (issue number, run, frequency), the date
            of first publication where the printing in hand is not identified,
            a range, and anything held with low confidence.

Estimates are shown in words ("c. 1910", "between 1914 and 1916") and stay out of
the filter by year.
"""
import csv
import sys
from pathlib import Path

COLUMNS = ["objectid", "date", "date_kind", "basis", "source", "confidence", "note"]
HEDGES = ("about ", "ca.", "first publi", "?", "usually", "question mark", "estimate", "probably", "without a printed date")
SKIP = {"sic00556"}   # researched from the text of a file that has since been replaced
PICA_Y_PECA = ("The Biblioteca Nacional de España dates its copies of the Pica y Peca booklets about 1910, "
               "about 1920 and about 1930; no firmer date was found.")
OVERRIDES = {
    # The story itself mentions March 1915, so these two cannot be as early as the library's "about 1910".
    "sic00970": ("1915/1930", "The text mentions March 1915; the Biblioteca Nacional de España dates the Pica y Peca "
                              "booklets between about 1910 and about 1930."),
    "sic00982": ("1915/1930", "The text mentions March 1915; the Biblioteca Nacional de España dates the Pica y Peca "
                              "booklets between about 1910 and about 1930."),
    # Only the month is traceable to a source.
    "sic00986": ("1916-01", "First published as no. 3 of the weekly La Novela Corta (Madrid), January 1916."),
}


def main():
    data, work = Path(sys.argv[1]), Path(sys.argv[2])
    with open(data / "master" / "sicalipsis.csv", encoding="utf-8-sig", newline="") as fh:
        series = {r["objectid"]: r["series"] for r in csv.DictReader(fh)}
    out, firm, estimated = [], 0, 0
    for path in sorted((work / "dating").glob("found_*.csv")):
        with open(path, encoding="utf-8-sig", newline="") as fh:
            for r in csv.DictReader(fh):
                if not r["date"] or r["objectid"] in SKIP:
                    continue
                r = {c: " ".join(r[c].split()) for c in COLUMNS}
                if r["objectid"] in OVERRIDES:
                    r["date"], r["basis"] = OVERRIDES[r["objectid"]]
                elif series.get(r["objectid"]) == "PICA Y PECA":
                    r["date"], r["basis"] = "1910/1930", PICA_Y_PECA
                hedged = any(h in r["basis"].lower() for h in HEDGES)
                is_firm = (r["date_kind"] == "exact" and r["confidence"] in ("high", "medium")
                           and "/" not in r["date"] and not hedged)
                r["date_kind"] = "exact" if is_firm else "range"
                firm += is_firm
                estimated += not is_firm
                out.append(r)
    with open(data / "master" / "dates_researched.csv", "w", encoding="utf-8-sig", newline="") as fh:
        writer = csv.DictWriter(fh, fieldnames=COLUMNS)
        writer.writeheader()
        writer.writerows(sorted(out, key=lambda r: r["objectid"]))
    print(f"{len(out)} dates: {firm} firm, {estimated} estimates -> {data / 'master' / 'dates_researched.csv'}")


if __name__ == "__main__":
    main()
