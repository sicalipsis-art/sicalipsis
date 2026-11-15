"""Build the index for searching inside the texts, and put it in the bucket.

Usage: python make_text_index.py <data_dir> <work_dir> [--no-upload]

The site's ordinary search looks through the catalogue. This index looks
through the words on the pages: OCR text where there is some, otherwise the
text layer of the PDF. It is made for a site with no server: the index is cut
into small files by the first two letters of a word, and the search page
fetches only the files for the words typed.

Reads the texts from <work_dir>/texts/ocr and <work_dir>/texts/text (copy them
from web/ocr and web/text in the bucket first), and writes to
<work_dir>/web/search/, uploaded to web/search/ in the bucket:

  docs.json        the objects that have text: id, where the text file is, page count
  words/<xx>.json  {word: {object number: [pages]}} for words beginning with xx

Words are lower-cased with accents removed, three letters or more, without the
commonest Spanish words. The search page treats what is typed the same way.

A second index of the same shape is made from the English translations
(<work_dir>/web/translation/, written by translate_texts.py) and uploaded to
web/search-en/, so that the texts can be searched with English words.
"""
import csv
import json
import re
import shutil
import subprocess
import sys
import unicodedata
from collections import defaultdict
from pathlib import Path

BUCKET = "r2:sicalipsis-files"
MIN_TEXT = 200
STOP = set("""que los las del una por con para como mas pero sus les esta este esto estos estas ese esa eso esos esas
aquel aquella fue han hay era eran ser son sin sobre entre cuando donde quien cual tambien muy porque desde hasta
todo todos toda todas otro otra otros otras uno unos unas nos mis tus the and""".split())
STOP_EN = set("""the and that for with was his her had not but you she him are this from they have were which one all
would there their what been who will when them has its said into than then could did your out more about some can very
our how only any these those""".split())


def fold(text):
    text = unicodedata.normalize("NFD", text.lower())
    return "".join(ch for ch in text if not unicodedata.combining(ch))


def write_index(documents, out, stop):
    """documents: [(objectid, kind, [(page number, text)])]. Writes docs.json and the word files; returns a summary."""
    docs, index = [], defaultdict(lambda: defaultdict(list))
    for oid, kind, pages in documents:
        words_here = 0
        number = len(docs)
        for page, text in pages:
            for word in set(re.findall(r"[a-z]{3,}", fold(text))) - stop:
                index[word][number].append(page)
                words_here += 1
        if words_here:
            docs.append({"id": oid, "kind": kind, "pages": len(pages)})
        else:                                         # nothing readable: forget this number
            for word in list(index):
                index[word].pop(number, None)
    shutil.rmtree(out, ignore_errors=True)
    (out / "words").mkdir(parents=True)
    shards = defaultdict(dict)
    for word, postings in index.items():
        if postings:
            shards[word[:2]][word] = postings
    for key, words in shards.items():
        (out / "words" / f"{key}.json").write_text(json.dumps(words, separators=(",", ":")), encoding="utf-8")
    (out / "docs.json").write_text(json.dumps(docs, separators=(",", ":")), encoding="utf-8")
    sizes = sorted(p.stat().st_size for p in (out / "words").glob("*.json"))
    return (f"{len(docs)} objects with text, {sum(d['pages'] for d in docs)} pages, {len(index)} different words, "
            f"{len(sizes)} index files ({sum(sizes) / 1e6:.1f} MB in all; median {sizes[len(sizes) // 2] // 1024} KB, "
            f"largest {sizes[-1] // 1024} KB)")


def upload(out, name):
    if "--no-upload" in sys.argv:
        return
    result = subprocess.run(["rclone", "sync", str(out), f"{BUCKET}/web/{name}", "--transfers", "32"],
                            capture_output=True, text=True)
    print("uploaded to the bucket" if result.returncode == 0 else f"upload failed: {result.stderr[-200:]}")


def main():
    data, work = Path(sys.argv[1]), Path(sys.argv[2])
    with open(data / "published" / "rows.csv", encoding="utf-8-sig", newline="") as fh:
        published = {r["objectid"] for r in csv.DictReader(fh)}
    sources = {}
    for kind in ("text", "ocr"):                      # OCR text, where there is some, replaces the PDF's text layer
        for path in sorted((work / "texts" / kind).glob("*.txt")):
            if path.stem in published and path.stat().st_size >= MIN_TEXT:
                sources[path.stem] = (kind, path)
    documents = []
    for oid in sorted(sources):
        kind, path = sources[oid]
        parts = re.split(r"^=== page (\d+) ===\s*$", path.read_text(encoding="utf-8", errors="replace"), flags=re.M)
        documents.append((oid, kind, [(int(parts[i]), parts[i + 1]) for i in range(1, len(parts) - 1, 2)] or [(1, parts[0])]))
    print("Spanish:", write_index(documents, work / "web" / "search", STOP))
    upload(work / "web" / "search", "search")

    # The same index over the English translations.
    translated = []
    for path in sorted((work / "web" / "translation").glob("*.json")):
        if path.stem in published:
            pages = json.loads(path.read_text(encoding="utf-8"))["pages"]
            translated.append((path.stem, "translation", [(page["n"], " ".join(page["en"])) for page in pages]))
    if translated:
        print("English:", write_index(translated, work / "web" / "search-en", STOP_EN))
        upload(work / "web" / "search-en", "search-en")


if __name__ == "__main__":
    main()
