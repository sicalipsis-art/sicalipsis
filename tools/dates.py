"""Standardise dates and work out dates for objects that have none.

Used by build_master.py. Every object ends up with:

  date            ISO form used for sorting and filtering: yyyy, yyyy-mm or yyyy-mm-dd
                  (for an estimate, the most likely year)
  date_display    one consistent wording: "29 July 1911", "October 1911", "1911",
                  "c. 1925", "between 1924 and 1926", "1920s"
  date_certainty  recorded   the date is in the catalogue record's date field
                  derived    the date is stated elsewhere: in the title, the file
                             name, the publisher line or the document's own text
                  estimated  nothing states the date; it is inferred from dated
                             items of the same series
                  (empty)    no date could be worked out
  date_range      for estimates, the possible span as "yyyy/yyyy"
  date_basis      what the date rests on, in words, so it can be checked
  date_original   the date exactly as the catalogue record gives it (unchanged)

Evidence is tried in that order of trust, and the first that gives one
unambiguous date wins. Nothing is guessed from an image's appearance.
"""
import re
import unicodedata
from collections import defaultdict

PERIOD = r"(?<!\d)(18[89]\d|19[0-3]\d)(?!\d)"      # the collection's period, 1880-1939
ANY_YEAR = r"(?<!\d)(1[89]\d\d|20[0-2]\d)(?!\d)"   # trusted only in the record's own date field
_MONTHS = [
    "enero january jan ene", "febrero february feb", "marzo march mar", "abril april apr abr",
    "mayo may", "junio june jun", "julio july jul", "agosto august aug ago",
    "septiembre setiembre september sept sep", "octubre october oct",
    "noviembre november nov", "diciembre december dec dic"]
MONTH = {name: i for i, names in enumerate(_MONTHS, 1) for name in names.split()}
M = "|".join(sorted(MONTH, key=len, reverse=True))
ENGLISH = ["January", "February", "March", "April", "May", "June", "July", "August",
           "September", "October", "November", "December"]
PLACES = "madrid|barcelona|sevilla|valencia|paris|buenos aires|mexico|zaragoza|bilbao"
TRADE = "imp|imprenta|tip|tipografia|talleres|editorial|ediciones|copyright|propiedad|depositado"


def fold(s):
    s = unicodedata.normalize("NFKD", s or "")
    s = "".join(c for c in s if not unicodedata.combining(c)).lower()
    return re.sub(r"[^a-z0-9?]+", " ", s).strip()


def _iso(year, month=None, day=None):
    if month and day and 1 <= int(day) <= 31:
        return f"{year}-{MONTH[month]:02d}-{int(day):02d}"
    return f"{year}-{MONTH[month]:02d}" if month else str(year)


def parse(text, years=PERIOD):
    """The single date stated in a short text, as ISO, or '' if none or ambiguous."""
    t = fold(text)
    if not t:
        return ""
    y = years[len("(?<!\\d)"):-len("(?!\\d)")]
    found = {_iso(yr, mo, d) for d, mo, yr in
             re.findall(rf"(?<!\d)(\d{{1,2}}) (?:de )?({M}) (?:de |del )?{y}(?!\d)", t)}
    found |= {_iso(yr, mo, d) for mo, d, yr in re.findall(rf"\b({M}) (\d{{1,2}}) (?:de )?{y}(?!\d)", t)}
    if not found:
        found = {_iso(yr, mo) for mo, yr in re.findall(rf"\b({M}) (?:de |del )?{y}(?!\d)", t)}
    if not found:
        found = set(re.findall(years, t))
    return found.pop() if len(found) == 1 else ""


def display(iso):
    parts = iso.split("-")
    if len(parts) == 3:
        return f"{int(parts[2])} {ENGLISH[int(parts[1]) - 1]} {parts[0]}"
    if len(parts) == 2:
        return f"{ENGLISH[int(parts[1]) - 1]} {parts[0]}"
    return iso


def from_record(original):
    """Read the catalogue record's own date field. Returns (iso, basis, range, display)."""
    if not original.strip():
        return None
    iso = parse(original, ANY_YEAR)
    if iso:
        return iso, "catalogue record's date field", "", display(iso)
    years = sorted(set(re.findall(ANY_YEAR, fold(original))))
    in_period = [y for y in years if int(y) <= 1939]
    if len(years) == 2 and len(in_period) == 1:
        other = [y for y in years if y != in_period[0]][0]
        return (in_period[0], f"catalogue record gives two years ({original.strip()}); the one within "
                f"the collection's period is used, {other} is taken to be a later edition", "", in_period[0])
    decade = re.search(r"(?<!\d)(1[89]\d)\?", original)
    if decade:
        start = decade.group(1) + "0"
        return (start, f"catalogue record gives only the decade ({original.strip()})",
                f"{start}/{decade.group(1)}9", f"{start}s")
    return None


def from_document(text):
    """A date printed in the document itself. Returns (iso, snippet, page) or None."""
    pages = re.split(r"=== page (\d+) ===", text or "")
    numbered = [(int(pages[i]), pages[i + 1]) for i in range(1, len(pages) - 1, 2)]
    if not numbered:
        return None
    y = PERIOD[len("(?<!\\d)"):-len("(?!\\d)")]
    front = numbered[:3]
    # A full date near the front: the masthead of a periodical.
    hits = []
    for n, page in front[:2]:
        t = fold(page)[:2500]
        for m in re.finditer(rf"(?<!\d)(\d{{1,2}}) (?:de )?({M}) (?:de |del )?{y}(?!\d)", t):
            hits.append((_iso(m.group(3), m.group(2), m.group(1)), t[max(0, m.start() - 25):m.end() + 5], n))
        for m in re.finditer(rf"\b({M}) (?:de |del )?{y}(?!\d)", t):
            hits.append((_iso(m.group(2), m.group(1)), t[max(0, m.start() - 25):m.end() + 5], n))
    best = {}
    for iso, snippet, n in hits:  # a day-precise date replaces the same month without a day
        key = iso[:7]
        if key not in best or len(iso) > len(best[key][0]):
            best[key] = (iso, snippet, n)
    if len(best) == 1:
        return next(iter(best.values()))
    if best:
        return None  # several different dates: not safe to choose
    # An imprint line: place or printer followed by a year, at the front or on the last page.
    hits = []
    for n, page in front + numbered[-1:]:
        t = fold(page)
        for m in re.finditer(rf"\b(?:{PLACES}) {y}(?!\d)|\b(?:{TRADE})\b.{{0,60}}? {y}(?!\d)|\bano [ivxlc0-9]+ .{{0,30}}?{y}(?!\d)", t):
            year = next(g for g in m.groups() if g)
            hits.append((year, t[max(0, m.start() - 10):m.end() + 5], n))
    years = {h[0] for h in hits}
    return hits[0] if len(years) == 1 else None


def number_of(row):
    """Issue or volume number, from the identifier or a number leading the title."""
    m = re.search(r"(?:num|no|n|vol)\s*(\d{1,4})\b", fold(row.get("identifier", "")))
    if not m:
        m = re.match(r"\s*#?\s*(\d{1,4})[.\s]", row.get("title", ""))
    return int(m.group(1)) if m else None


def resolve(rows, texts=None):
    """Fill the date columns of every row in place; return a tally of what was used."""
    texts = texts or {}
    tally = defaultdict(int)
    for r in rows:
        r.update(date="", date_display="", date_certainty="", date_range="", date_basis="")
        got = from_record(r.get("date_original", ""))
        if got:
            r.update(date=got[0], date_basis=got[1], date_range=got[2], date_display=got[3],
                     date_certainty="estimated" if got[2] else "recorded")
        if not r["date"]:
            name = r.get("box_path", "").rsplit("/", 1)[-1].rsplit(".", 1)[0].replace("_", " ")
            for value, basis in [(r.get("title", ""), "stated in the title"),
                                 (name, "stated in the file name"),
                                 (r.get("publisher", ""), "year in the publisher line"),
                                 (r.get("source", ""), "year in the source field"),
                                 (r.get("description", ""), "year in the description")]:
                iso = parse(value)
                if iso:
                    r.update(date=iso, date_display=display(iso), date_certainty="derived", date_basis=basis)
                    break
        if not r["date"] and r["objectid"] in texts:
            found = from_document(texts[r["objectid"]])
            if found:
                iso, snippet, page = found
                r.update(date=iso, date_display=display(iso), date_certainty="derived",
                         date_basis=f'printed in the document, page {page}: "...{snippet.strip()}..."')
        elif r["date_certainty"] in ("recorded", "derived") and r["objectid"] in texts:
            # The record gives a year or month; the document may print the full date.
            found = from_document(texts[r["objectid"]])
            if found and found[0].startswith(r["date"]) and len(found[0]) > len(r["date"]):
                iso, snippet, page = found
                r.update(date=iso, date_display=display(iso),
                         date_basis=f'{r["date_basis"]}; full date printed in the document, '
                                    f'page {page}: "...{snippet.strip()}..."')
                tally["made more precise from the document"] += 1
        tally[r["date_certainty"] or "none yet"] += 1

    # Estimates from dated items of the same series (or, in the Image Gallery, the same source).
    def group_of(r):
        key = r.get("source", "") if r.get("section") == "Image Gallery" else r.get("series", "")
        key = fold(key)
        return "" if key in ("", "image gallery") else f"{r.get('section', '')}|{key}"

    dated = defaultdict(list)
    for r in rows:
        if r["date_certainty"] in ("recorded", "derived") and group_of(r):
            dated[group_of(r)].append(r)
    for r in rows:
        if r["date"] or not group_of(r):
            continue
        siblings = dated.get(group_of(r), [])
        n = number_of(r)
        numbered = sorted((number_of(s), s["date"][:4]) for s in siblings if number_of(s) is not None)
        below = [x for x in numbered if n is not None and x[0] < n]
        above = [x for x in numbered if n is not None and x[0] > n]
        if below and above and int(above[0][1]) - int(below[-1][1]) in (0, 1, 2, 3):
            a, b = below[-1], above[0]
            r.update(date=a[1], date_range=f"{a[1]}/{b[1]}", date_certainty="estimated",
                     date_display=f"c. {a[1]}" if a[1] == b[1] else f"between {a[1]} and {b[1]}",
                     date_basis=f"estimated: number {n} falls between number {a[0]} ({a[1]}) "
                                f"and number {b[0]} ({b[1]}) of the same series")
            tally["estimated"] += 1
            tally["none yet"] -= 1
            continue
        years = sorted(int(s["date"][:4]) for s in siblings)
        if len(years) >= 3 and years[-1] - years[0] <= 12:
            lo, hi = years[0], years[-1]
            mid = years[len(years) // 2]
            r.update(date=str(mid), date_range=f"{lo}/{hi}", date_certainty="estimated",
                     date_display=f"c. {lo}" if lo == hi else f"between {lo} and {hi}",
                     date_basis=f"estimated: the {len(years)} dated items of the same "
                                f"{'source' if r.get('section') == 'Image Gallery' else 'series'} "
                                f"date from {lo}{'' if lo == hi else ' to ' + str(hi)}")
            tally["estimated"] += 1
            tally["none yet"] -= 1
    return dict(tally)
