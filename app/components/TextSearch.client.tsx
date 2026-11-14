import React, {useEffect, useMemo, useRef, useState} from "react";
import site from "../data/site.json";

/**
 * Search inside the texts: the words on the pages, as read by OCR or taken
 * from a PDF's own text layer. The index is made by tools/make_text_index.py
 * and kept in the file bucket, cut into small files by the first two letters
 * of a word; only the files for the words typed are fetched.
 *
 * All the words typed must occur in an item (on any of its pages). Results are
 * ordered by how many pages the words occur on. For the first results the
 * item's text is fetched and the lines containing the words are shown.
 */
type Doc = {id: string; kind: string; pages: number};
type Hit = {doc: Doc; pages: number[]; title: string; href: string; thumb: string; lines?: {page: number; text: string}[]};

const STOP = new Set(("que los las del una por con para como mas pero sus les esta este esto estos estas ese esa eso esos esas " +
  "aquel aquella fue han hay era eran ser son sin sobre entre cuando donde quien cual tambien muy porque desde hasta " +
  "todo todos toda todas otro otra otros otras uno unos unas nos mis tus the and").split(" "));
const fold = (text: string) => text.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
const wordsOf = (text: string) => Array.from(new Set(fold(text).match(/[a-z]{3,}/g) || [])).filter((w) => !STOP.has(w));
const SHOWN = 30, WITH_LINES = 8;

export default function TextSearch() {
  const [query, setQuery] = useState("");
  const [state, setState] = useState<"idle" | "busy" | "done" | "error">("idle");
  const [hits, setHits] = useState<Hit[]>([]);
  const [asked, setAsked] = useState<string[]>([]);
  const docs = useRef<Doc[] | null>(null);
  const cards = useRef<Record<string, {title: string; href: string; thumb: string}>>({});
  const shards = useRef<Record<string, Record<string, Record<string, number[]>>>>({});
  const base = typeof window === "undefined" ? "" : ((window as any).CANOPY_BASE_PATH || "");
  const root = `${site.webBase}/search`;

  const run = async (text: string) => {
    const words = wordsOf(text);
    setAsked(words);
    if (!words.length) { setHits([]); setState("done"); return; }
    setState("busy");
    try {
      if (!docs.current) {
        const [list, index] = await Promise.all([
          fetch(`${root}/docs.json`).then((r) => r.json()),
          fetch(`${base}/api/search-records.json`).then((r) => r.json()).catch(() => []),
        ]);
        docs.current = list;
        for (const r of (Array.isArray(index) ? index : index.records || [])) {
          const m = /\/images\/([^/]+)\/thumb\.jpg/.exec(r.thumbnail || "");
          if (m && r.href) cards.current[m[1]] = {title: r.title, href: `${base}${r.href}`, thumb: r.thumbnail};
        }
      }
      await Promise.all(Array.from(new Set(words.map((w) => w.slice(0, 2)))).map(async (key) => {
        if (shards.current[key]) return;
        const r = await fetch(`${root}/words/${key}.json`);
        shards.current[key] = r.ok ? await r.json() : {};
      }));
      // Items that contain every word; pages on which any of the words occurs.
      let found: Map<string, Set<number>> | null = null;
      for (const word of words) {
        const postings = shards.current[word.slice(0, 2)][word] || {};
        const next = new Map<string, Set<number>>();
        for (const [number, pages] of Object.entries(postings)) {
          if (found && !found.has(number)) continue;
          next.set(number, new Set([...(found?.get(number) || []), ...pages]));
        }
        found = next;
      }
      const list: Hit[] = Array.from(found || []).map(([number, pages]) => {
        const doc = docs.current![Number(number)];
        const card = cards.current[doc.id] || {title: doc.id, href: "", thumb: `${site.webBase}/images/${doc.id}/thumb.jpg`};
        return {doc, pages: Array.from(pages).sort((a, b) => a - b), ...card};
      }).sort((a, b) => b.pages.length - a.pages.length || a.title.localeCompare(b.title));
      setHits(list);
      setState("done");
      // The lines themselves, for the first results.
      list.slice(0, WITH_LINES).forEach(async (hit) => {
        try {
          const raw = await (await fetch(`${site.webBase}/${hit.doc.kind}/${hit.doc.id}.txt`)).text();
          const parts = raw.split(/^=== page (\d+) ===\s*$/m);
          const lines: {page: number; text: string}[] = [];
          for (let i = 1; i < parts.length && lines.length < 3; i += 2) {
            for (const line of (parts[i + 1] || "").split("\n")) {
              const inLine = new Set(fold(line).match(/[a-z]{3,}/g) || []);       // whole words only
              if (words.some((w) => inLine.has(w))) { lines.push({page: Number(parts[i]), text: line.trim()}); break; }
            }
          }
          setHits((now) => now.map((h) => (h.doc.id === hit.doc.id ? {...h, lines} : h)));
        } catch { /* the result stays without its lines */ }
      });
    } catch {
      setState("error");
    }
  };

  // A query in the address (?q=...) is run on arrival, so searches can be linked to.
  useEffect(() => {
    const q = new URLSearchParams(location.search).get("q") || "";
    if (q) { setQuery(q); run(q); }
  }, []);
  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    history.replaceState(null, "", `${location.pathname}?q=${encodeURIComponent(query)}`);
    run(query);
  };
  const mark = useMemo(() => (text: string) => {
    if (!asked.length) return text;
    const out: React.ReactNode[] = [];
    text.split(/(\s+)/).forEach((piece, i) => {
      const inPiece = fold(piece).match(/[a-z]{3,}/g) || [];
      out.push(inPiece.some((w) => asked.includes(w)) ? <mark key={i}>{piece}</mark> : piece);
    });
    return out;
  }, [asked]);

  return (
    <div className="sic-tsearch">
      <form role="search" aria-label="Search inside the texts" onSubmit={submit}>
        <label htmlFor="sic-tsearch-q">Search inside the texts</label>
        <div>
          <input id="sic-tsearch-q" type="search" value={query} onChange={(e) => setQuery(e.target.value)}
            placeholder="Words that appear on the pages, e.g. desnudismo" autoComplete="off" />
          <button type="submit">Search</button>
        </div>
      </form>
      <p className="sic-tsearch__about">
        This looks through the words on the pages of the magazines, novelettes and essays, as read from the page images by machine
        or taken from the files. The reading contains errors, so a word that is on a page may not be found. All the words you type must occur in an item.
      </p>
      {state === "busy" && <p>Searching…</p>}
      {state === "error" && <p>The search could not be run.</p>}
      {state === "done" && (
        <>
          <p className="sic-tsearch__count" aria-live="polite">
            {hits.length === 0 ? "No item contains these words." : hits.length === 1 ? "1 item." : `${hits.length} items${hits.length > SHOWN ? `; the first ${SHOWN} are shown` : ""}.`}
          </p>
          <ol>
            {hits.slice(0, SHOWN).map((hit) => (
              <li key={hit.doc.id}>
                <a href={hit.href || hit.thumb.replace("/thumb.jpg", "/0001.jpg")}>
                  <img src={hit.thumb} alt="" loading="lazy" />
                </a>
                <div>
                  <h3><a href={hit.href || hit.thumb.replace("/thumb.jpg", "/0001.jpg")}>{hit.title}</a></h3>
                  <p className="sic-tsearch__pages">
                    On {hit.pages.length === 1 ? "page" : `${hit.pages.length} pages:`} {hit.pages.slice(0, 14).join(", ")}{hit.pages.length > 14 ? " …" : ""}
                  </p>
                  {hit.lines && hit.lines.map((line, i) => (
                    <p key={i} className="sic-tsearch__line"><span>p. {line.page}</span> {mark(line.text)}</p>
                  ))}
                </div>
              </li>
            ))}
          </ol>
        </>
      )}
    </div>
  );
}
