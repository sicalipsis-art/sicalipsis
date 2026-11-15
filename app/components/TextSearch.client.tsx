import React, {useEffect, useMemo, useRef, useState} from "react";
import site from "../data/site.json";

/**
 * Search inside the texts, in two ways:
 *
 *   Exact match   the words typed, as they stand on the pages (the Spanish read
 *                 by OCR or taken from a PDF's own text layer) or in the English
 *                 machine translation of the pages (indexes: web/search and
 *                 web/search-en, tools/make_text_index.py)
 *   By meaning    passages that are about what was typed, in English, whatever
 *                 words they use (index: web/meaning, tools/make_meaning_index.py)
 *
 * The word indexes are cut into small files by the first two letters of a word;
 * only the files for the words typed are fetched. All the words typed must occur
 * in an item (on any of its pages), in its Spanish or in its English, and
 * results are ordered by how many pages the words occur on.
 *
 * Searching by meaning needs no server either: a small language model is fetched
 * from the file bucket the first time and run in the browser, the question is
 * turned into numbers, and the passages whose numbers lie closest are shown.
 */
type Mode = "exact" | "meaning";
type Lang = "es" | "en";
type Doc = {id: string; kind: string; pages: number};
type Line = {page: number; text: string; original?: string};
type Hit = {id: string; kind: string; pages: number[]; title: string; href: string; thumb: string; lines?: Line[];
            passages?: {page: number; start: number; count: number}[]};
type Translation = {pages: {n: number; es: string[]; en: string[]}[]};

const STOP: Record<string, Set<string>> = {
  es: new Set(("que los las del una por con para como mas pero sus les esta este esto estos estas ese esa eso esos esas " +
    "aquel aquella fue han hay era eran ser son sin sobre entre cuando donde quien cual tambien muy porque desde hasta " +
    "todo todos toda todas otro otra otros otras uno unos unas nos mis tus the and").split(" ")),
  en: new Set(("the and that for with was his her had not but you she him are this from they have were which one all " +
    "would there their what been who will when them has its said into than then could did your out more about some can very " +
    "our how only any these those").split(" ")),
};
const fold = (text: string) => text.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
const wordsOf = (text: string, lang: Lang) =>
  Array.from(new Set(fold(text).match(/[a-z]{3,}/g) || [])).filter((w) => !STOP[lang].has(w));
const SHOWN = 30, WITH_LINES = 8, MEANING_SHOWN = 20;
const LIBRARY = "lib/transformers-3.8.1";
const MODES: [Mode, string, string][] = [
  ["exact", "Exact match", "Words on the pages, in Spanish or English, e.g. desnudismo"],
  ["meaning", "By meaning", "Describe it in English, e.g. a wife who leaves her husband"],
];

export default function TextSearch() {
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<Mode>("exact");
  const [state, setState] = useState<"idle" | "busy" | "done" | "error">("idle");
  const [note, setNote] = useState("");
  const [hits, setHits] = useState<Hit[]>([]);
  const [asked, setAsked] = useState<string[]>([]);
  const [ran, setRan] = useState<Mode>("exact");
  const docs = useRef<Record<string, Doc[]>>({});
  const cards = useRef<Record<string, {title: string; href: string; thumb: string}> | null>(null);
  const shards = useRef<Record<string, Record<string, Record<string, number[]>>>>({});
  const translations = useRef<Record<string, Promise<Translation>>>({});
  const meaning = useRef<any>(null);
  const base = typeof window === "undefined" ? "" : ((window as any).CANOPY_BASE_PATH || "");

  const loadCards = async () => {
    if (cards.current) return;
    const index = await fetch(`${base}/api/search-records.json`).then((r) => r.json()).catch(() => []);
    cards.current = {};
    for (const r of (Array.isArray(index) ? index : index.records || [])) {
      const m = /\/images\/([^/]+)\/thumb\.jpg/.exec(r.thumbnail || "");
      if (m && r.href) cards.current[m[1]] = {title: r.title, href: `${base}${r.href}`, thumb: r.thumbnail};
    }
  };
  const cardOf = (id: string) => cards.current![id] || {title: id, href: "", thumb: `${site.webBase}/images/${id}/thumb.jpg`};
  const translationOf = (id: string) =>
    (translations.current[id] ||= fetch(`${site.webBase}/translation/${id}.json`).then((r) => r.json()));

  // ---------- exact match ----------
  // The items in which every word occurs, in one language's index: item -> the pages on which any of the words occurs.
  const inIndex = async (words: string[], lang: Lang) => {
    const out = new Map<string, {kind: string; pages: Set<number>}>();
    if (!words.length) return out;
    const root = `${site.webBase}/${lang === "es" ? "search" : "search-en"}`;
    try {
      docs.current[lang] ||= await fetch(`${root}/docs.json`).then((r) => { if (!r.ok) throw new Error(); return r.json(); });
    } catch { return out; }                                      // no index in this language
    await Promise.all(Array.from(new Set(words.map((w) => w.slice(0, 2)))).map(async (key) => {
      if (shards.current[`${lang}/${key}`]) return;
      const r = await fetch(`${root}/words/${key}.json`).catch(() => null);
      shards.current[`${lang}/${key}`] = r && r.ok ? await r.json() : {};
    }));
    let found: Map<string, Set<number>> | null = null;
    for (const word of words) {
      const postings = shards.current[`${lang}/${word.slice(0, 2)}`][word] || {};
      const next = new Map<string, Set<number>>();
      for (const [number, pages] of Object.entries(postings)) {
        if (found && !found.has(number)) continue;
        next.set(number, new Set([...(found?.get(number) || []), ...pages]));
      }
      found = next;
    }
    for (const [number, pages] of found || []) {
      const doc = docs.current[lang][Number(number)];
      out.set(doc.id, {kind: doc.kind, pages});
    }
    return out;
  };

  // The words typed are looked for in the Spanish of the pages and in their English translation; either will do.
  const byWords = async (text: string) => {
    const words = {es: wordsOf(text, "es"), en: wordsOf(text, "en")};
    setAsked(Array.from(new Set([...words.es, ...words.en])));
    if (!words.es.length && !words.en.length) { setHits([]); setState("done"); return; }
    await loadCards();
    const [spanish, english] = await Promise.all([inIndex(words.es, "es"), inIndex(words.en, "en")]);
    const list = Array.from(new Set([...spanish.keys(), ...english.keys()])).map((id) => {
      const pages = new Set([...(spanish.get(id)?.pages || []), ...(english.get(id)?.pages || [])]);
      return {id, kind: spanish.get(id)?.kind || "ocr", pages: Array.from(pages).sort((a, b) => a - b), ...cardOf(id),
              inSpanish: spanish.has(id), inEnglish: english.has(id)};
    }).sort((a, b) => b.pages.length - a.pages.length || a.title.localeCompare(b.title));
    setHits(list);
    setState("done");
    // The lines themselves, for the first results: Spanish lines where the Spanish has the words, translated ones otherwise.
    const has = (wanted: string[]) => (line: string) => {
      const inLine = new Set(fold(line).match(/[a-z]{3,}/g) || []);                // whole words only
      return wanted.some((w) => inLine.has(w));
    };
    list.slice(0, WITH_LINES).forEach(async (hit) => {
      try {
        const lines: Line[] = [];
        if (hit.inSpanish) {
          const raw = await (await fetch(`${site.webBase}/${hit.kind}/${hit.id}.txt`)).text();
          const parts = raw.split(/^=== page (\d+) ===\s*$/m);
          for (let i = 1; i < parts.length && lines.length < 3; i += 2) {
            const line = (parts[i + 1] || "").split("\n").find(has(words.es));
            if (line) lines.push({page: Number(parts[i]), text: line.trim()});
          }
        }
        if (hit.inEnglish && lines.length < 3) {
          for (const page of (await translationOf(hit.id)).pages) {
            if (lines.length >= 3) break;
            const i = page.en.findIndex(has(words.en));
            if (i >= 0) lines.push({page: page.n, text: page.en[i], original: page.es[i]});
          }
        }
        setHits((now) => now.map((h) => (h.id === hit.id ? {...h, lines} : h)));
      } catch { /* the result stays without its lines */ }
    });
  };

  // ---------- by meaning ----------
  const loadMeaning = async () => {
    if (meaning.current) return meaning.current;
    setNote("Fetching the index of passages…");
    const root = `${site.webBase}/meaning`;
    const [meta, ids, chunks, vectors, projection] = await Promise.all([
      fetch(`${root}/meta.json`).then((r) => r.json()),
      fetch(`${root}/docs.json`).then((r) => r.json()),
      fetch(`${root}/chunks.json`).then((r) => r.json()),
      fetch(`${root}/vectors.bin`).then((r) => r.arrayBuffer()).then((b) => new Int8Array(b)),
      fetch(`${root}/projection.bin`).then((r) => r.arrayBuffer()).then((b) => new Float32Array(b)),
    ]);
    setNote("Fetching the language model (about 55 MB the first time; it is kept for later visits)…");
    // Loaded at run time from the bucket, so it is not part of the site's own scripts.
    const library = await (new Function("u", "return import(u)"))(`${site.webBase}/${LIBRARY}/transformers.min.js`);
    library.env.allowLocalModels = false;
    library.env.remoteHost = `${site.webBase}/models/`;
    library.env.remotePathTemplate = "{model}/";
    library.env.backends.onnx.wasm.wasmPaths = `${site.webBase}/${LIBRARY}/`;
    library.env.backends.onnx.wasm.numThreads = 1;
    const extractor = await library.pipeline("feature-extraction", meta.model, {dtype: "q8"});
    meaning.current = {meta, ids, chunks, vectors, projection, extractor};
    return meaning.current;
  };

  const byMeaning = async (text: string) => {
    setAsked([]);
    if (text.trim().length < 3) { setHits([]); setState("done"); return; }
    await loadCards();
    const m = await loadMeaning();
    setNote("Comparing your words with the passages…");
    const output = await m.extractor(m.meta.query_prefix + text.trim(), {pooling: "cls", normalize: true});
    const full: Float32Array = output.data;
    // The same reduction the index went through: take away the mean, project, make unit length.
    const {source_dims: big, dims} = m.meta;
    const q = new Float32Array(dims);
    let norm = 0;
    for (let d = 0; d < dims; d++) {
      let sum = 0;
      const row = big + d * big;
      for (let k = 0; k < big; k++) sum += (full[k] - m.projection[k]) * m.projection[row + k];
      q[d] = sum; norm += sum * sum;
    }
    norm = Math.sqrt(norm) || 1;
    const count = m.vectors.length / dims;
    const scores = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      let sum = 0;
      const at = i * dims;
      for (let d = 0; d < dims; d++) sum += m.vectors[at + d] * q[d];
      scores[i] = sum / (127 * norm);
    }
    const order = Array.from(scores.keys()).sort((a, b) => scores[b] - scores[a]).slice(0, 80);
    // The best passages, gathered by item: at most two from each.
    const byDoc = new Map<number, number[]>();
    for (const i of order) {
      const list = byDoc.get(m.chunks.doc[i]) || [];
      if (list.length < 2) { list.push(i); byDoc.set(m.chunks.doc[i], list); }
    }
    const list: Hit[] = Array.from(byDoc).slice(0, MEANING_SHOWN).map(([number, found]) => {
      const id = m.ids[number];
      return {id, kind: "translation", pages: found.map((i) => m.chunks.page[i]), ...cardOf(id),
              passages: found.map((i) => ({page: m.chunks.page[i], start: m.chunks.start[i], count: m.chunks.count[i]}))};
    });
    setHits(list);
    setNote("");
    setState("done");
    list.forEach(async (hit) => {
      try {
        const pages = (await translationOf(hit.id)).pages;
        const lines: Line[] = hit.passages!.map((p) => {
          const page = pages.find((x) => x.n === p.page);
          const pick = (side: string[]) => side.slice(p.start, p.start + p.count).filter(Boolean).join(" ");
          return {page: p.page, text: page ? pick(page.en) : "", original: page ? pick(page.es) : ""};
        });
        setHits((now) => now.map((h) => (h.id === hit.id ? {...h, lines} : h)));
      } catch { /* the result stays without its passages */ }
    });
  };

  const run = async (text: string, how: Mode) => {
    setState("busy");
    setNote("");
    setRan(how);
    try {
      if (how === "meaning") await byMeaning(text); else await byWords(text);
    } catch {
      setNote("");
      setState("error");
    }
  };

  // A query in the address (?q=...&in=...) is run on arrival, so searches can be linked to.
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const q = params.get("q") || "";
    const how: Mode = params.get("in") === "meaning" ? "meaning" : "exact";
    setMode(how);
    if (q) { setQuery(q); run(q, how); }
  }, []);
  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    history.replaceState(null, "", `${location.pathname}?q=${encodeURIComponent(query)}&in=${mode}`);
    run(query, mode);
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

  const placeholder = MODES.find(([value]) => value === mode)![2];
  return (
    <div className="sic-tsearch">
      <form role="search" aria-label="Search inside the texts" onSubmit={submit}>
        <label htmlFor="sic-tsearch-q">Search inside the texts</label>
        <p className="sic-tsearch__modes" role="group" aria-label="How to search">
          {MODES.map(([value, label]) => (
            <button key={value} type="button" aria-pressed={mode === value} onClick={() => setMode(value)}>{label}</button>
          ))}
        </p>
        <div>
          <input id="sic-tsearch-q" type="search" value={query} onChange={(e) => setQuery(e.target.value)}
            placeholder={placeholder} autoComplete="off" />
          <button type="submit">Search</button>
        </div>
      </form>
      {state === "busy" && <p aria-live="polite">{note || "Searching…"}</p>}
      {state === "error" && <p>The search could not be run.</p>}
      {state === "done" && (
        <>
          <p className="sic-tsearch__count" aria-live="polite">
            {ran === "meaning"
              ? (hits.length === 0 ? "Nothing was found." : `The ${hits.length} items with the closest passages.`)
              : hits.length === 0 ? "No item contains these words." : hits.length === 1 ? "1 item." : `${hits.length} items${hits.length > SHOWN ? `; the first ${SHOWN} are shown` : ""}.`}
          </p>
          <ol>
            {hits.slice(0, SHOWN).map((hit) => (
              <li key={hit.id}>
                <a href={hit.href || hit.thumb.replace("/thumb.jpg", "/0001.jpg")}>
                  <img src={hit.thumb} alt="" loading="lazy" />
                </a>
                <div>
                  <h3><a href={hit.href || hit.thumb.replace("/thumb.jpg", "/0001.jpg")}>{hit.title}</a></h3>
                  {ran !== "meaning" && (
                    <p className="sic-tsearch__pages">
                      On {hit.pages.length === 1 ? "page" : `${hit.pages.length} pages:`} {hit.pages.slice(0, 14).join(", ")}{hit.pages.length > 14 ? " …" : ""}
                    </p>
                  )}
                  {hit.lines && hit.lines.map((line, i) => (
                    <React.Fragment key={i}>
                      <p className="sic-tsearch__line"><span>p. {line.page}</span> {mark(line.text)}</p>
                      {line.original && <p className="sic-tsearch__original" lang="es">{line.original}</p>}
                    </React.Fragment>
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
