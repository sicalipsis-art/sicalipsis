"""Record how the Omeka site arranged its material: exhibits, their pages, and the items on each page in order.

Usage: python harvest_exhibits.py <data_dir> [site_url]

Omeka's exhibits are what a visitor saw in the site's menu: each exhibit has an
introduction and a tree of pages, and each page shows chosen items in a chosen
order. None of that is in the item export, so it is read from the public pages.

One request at a time with a pause; a page already saved is not fetched again;
the run stops at the second failure in a row so a struggling server is left
alone. The About and Contact pages are saved too.

Writes, under <data_dir>/omeka/exhibits/:
  raw/<name>.html     every page as received
  exhibits.json       exhibits with their introduction (text and HTML) and page tree
  exhibit_items.csv   one row per item placement: exhibit, page, order on the page
  pages.json          the text of the About and Contact pages
"""
import csv
import html
import json
import re
import sys
import time
import urllib.request
from pathlib import Path

SITE = "https://sicalipsis.humanities.ucla.edu"
UA = "Mozilla/5.0 (compatible; collection-inventory/1.0)"
PAUSE = 3.0


def text_of(fragment):
    fragment = re.sub(r"<(script|style).*?</\1>", " ", fragment, flags=re.S)
    fragment = re.sub(r"<br\s*/?>|</p>|</h\d>|</li>|</div>", "\n", fragment)
    lines = (re.sub(r"[ \t\r\f\v]+", " ", html.unescape(re.sub(r"<[^>]+>", "", line))).strip()
             for line in fragment.split("\n"))
    return "\n".join(line for line in lines if line)


def content_of(page):
    start = page.find('id="content"')
    end = page.find("<footer", start)
    return page[start:end if end > 0 else None] if start >= 0 else page


class Fetcher:
    def __init__(self, raw, site):
        self.raw, self.site, self.streak, self.fetched = raw, site, 0, 0

    def get(self, path):
        name = path.strip("/").replace("/", "__") or "home"
        saved = self.raw / f"{name}.html"
        if saved.exists():
            return saved.read_text(encoding="utf-8")
        if self.streak >= 2:
            raise SystemExit("two failures in a row: stopping so the server is left alone")
        try:
            req = urllib.request.Request(self.site + path, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=60) as resp:
                page = resp.read().decode("utf-8", errors="replace")
        except Exception as exc:
            self.streak += 1
            print(f"FAILED {path}: {exc}", flush=True)
            time.sleep(PAUSE)
            return None
        self.streak = 0
        self.fetched += 1
        saved.write_text(page, encoding="utf-8")
        print(f"saved {path}", flush=True)
        time.sleep(PAUSE)
        return page


def page_tree(nav, depth=0):
    """[(path, title, depth)] in menu order, from the nested list of exhibit pages."""
    out, pos = [], 0
    while True:
        m = re.compile(r"<li[^>]*>\s*<a[^>]+href=\"([^\"]+)\"[^>]*>(.*?)</a>|<ul[^>]*>|</ul>", re.S).search(nav, pos)
        if not m:
            return out
        if m.group(0).startswith("<ul"):
            depth += 1
        elif m.group(0).startswith("</ul"):
            depth -= 1
        else:
            out.append((m.group(1), text_of(m.group(2)), depth))
        pos = m.end()


def main():
    data = Path(sys.argv[1])
    site = (sys.argv[2] if len(sys.argv) > 2 else SITE).rstrip("/")
    out = data / "omeka" / "exhibits"
    raw = out / "raw"
    raw.mkdir(parents=True, exist_ok=True)
    fetch = Fetcher(raw, site)

    home = fetch.get("/")
    if not home:
        raise SystemExit("the site did not answer")
    menu = {}                      # the name each exhibit has in the site's menu
    for slug, label in re.findall(r"/exhibits/show/([A-Za-z0-9_-]+)\"[^>]*>(.*?)</a>", home, re.S):
        menu.setdefault(slug, text_of(label))
    slugs = list(menu)
    exhibits, placements = [], []
    for slug in slugs:
        landing = fetch.get(f"/exhibits/show/{slug}")
        if not landing:
            continue
        body = content_of(landing)
        title = text_of(re.search(r"<h1[^>]*>(.*?)</h1>", body, re.S).group(1))
        intro = re.search(r'<div class="exhibit-description">(.*?)</div>', body, re.S)
        nav = re.search(r'<nav id="exhibit-pages">(.*?)</nav>', body, re.S)
        tree = page_tree(nav.group(1)) if nav else []
        pages = []
        for order, (path, page_title, depth) in enumerate(tree, 1):
            page = fetch.get(path)
            if not page:
                continue
            inner = content_of(page)
            inner = re.sub(r'<nav id="exhibit-pages".*?</nav>|<div id="exhibit-page-navigation".*?</div>', "", inner, flags=re.S)
            items = list(dict.fromkeys(int(n) for n in re.findall(r"/(?:items/show|exhibits/show/[A-Za-z0-9_-]+/item)/(\d+)", inner)))
            pages.append({"path": path, "title": page_title, "depth": depth, "order": order,
                          "items": items, "text": text_of(inner)})
            for position, item in enumerate(items, 1):
                placements.append({"exhibit": slug, "exhibit_title": title, "page_path": path,
                                   "page_title": page_title, "page_depth": depth, "page_order": order,
                                   "position": position, "omeka_item_id": item})
        exhibits.append({"slug": slug, "title": title, "menu_title": menu[slug] or title,
                         "intro_text": text_of(intro.group(1)) if intro else "",
                         "intro_html": intro.group(1).strip() if intro else "", "pages": pages})
        print(f"{title}: {len(pages)} pages, {sum(len(p['items']) for p in pages)} item placements", flush=True)

    other = {}
    for path in ("/about", "/contact"):
        page = fetch.get(path)
        if page:
            other[path.strip("/")] = text_of(content_of(page))

    (out / "exhibits.json").write_text(json.dumps(exhibits, ensure_ascii=False, indent=1), encoding="utf-8")
    (out / "pages.json").write_text(json.dumps(other, ensure_ascii=False, indent=1), encoding="utf-8")
    with open(out / "exhibit_items.csv", "w", encoding="utf-8-sig", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=["exhibit", "exhibit_title", "page_path", "page_title", "page_depth",
                                           "page_order", "position", "omeka_item_id"])
        w.writeheader()
        w.writerows(placements)
    print(f"{len(exhibits)} exhibits, {sum(len(e['pages']) for e in exhibits)} pages, "
          f"{len(placements)} item placements; {fetch.fetched} pages fetched this run")


if __name__ == "__main__":
    main()
