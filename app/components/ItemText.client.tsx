import React, {useEffect, useState} from "react";

/**
 * The text of an item's pages, as read from the page images by OCR, shown under
 * the viewer, in Spanish, in English, or the two side by side.
 *
 * The Spanish text file is fetched from the file bucket when the section is
 * opened (tools/ocr_from_r2.py writes it; tools/make_annotations.py puts its
 * address in the manifest as seeAlso). The English is a machine translation made
 * by tools/translate_texts.py and kept beside it (web/translation/<id>.json:
 * for every page the Spanish sentences, their translations, and the paragraphs
 * they fall into); it is fetched only when English is asked for.
 *
 * Both the reading and the translation contain errors, and the section says so.
 */
type Mode = "es" | "en" | "both";
type Page = {n: number; es: string[]; en: string[]; p?: number[]};

export default function ItemText({src = ""}: {src?: string}) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<Mode>("es");
  const [pages, setPages] = useState<{n: string; text: string}[] | null>(null);
  const [english, setEnglish] = useState<Page[] | null | false>(null);
  const [failed, setFailed] = useState(false);
  const translation = src.replace(/\/ocr\/([^/]+)\.txt$/, "/translation/$1.json");

  useEffect(() => {
    try { const kept = localStorage.getItem("sic-text-language"); if (kept === "en" || kept === "both") setMode(kept); } catch { /* no storage */ }
  }, []);

  useEffect(() => {
    if (!open || pages || !src) return;
    fetch(src)
      .then((r) => { if (!r.ok) throw new Error(String(r.status)); return r.text(); })
      .then((raw) => {
        const parts = raw.split(/^=== page (\d+) ===\s*$/m);      // "", "1", text, "2", text ...
        const list: {n: string; text: string}[] = [];
        // Stray marks read as a character or two are noise; whole lines of them are dropped.
        const tidy = (text: string) => text.split("\n").filter((line) => line.trim().length > 2).join("\n").trim();
        for (let i = 1; i < parts.length; i += 2) list.push({n: parts[i], text: tidy(parts[i + 1] || "")});
        setPages(list.length ? list : [{n: "", text: raw.trim()}]);
      })
      .catch(() => setFailed(true));
  }, [open, pages, src]);

  useEffect(() => {
    if (!open || mode === "es" || english !== null || translation === src) return;
    fetch(translation)
      .then((r) => { if (!r.ok) throw new Error(String(r.status)); return r.json(); })
      .then((json) => setEnglish(Array.isArray(json.pages) ? json.pages : false))
      .catch(() => setEnglish(false));
  }, [open, mode, english, translation, src]);

  const choose = (next: Mode) => {
    setMode(next);
    try { localStorage.setItem("sic-text-language", next); } catch { /* no storage */ }
  };

  // The sentences of a page gathered into its paragraphs: [[index, index, ...], ...]
  const paragraphs = (page: Page) => {
    const sizes = page.p && page.p.length ? page.p : [page.es.length];
    const out: number[][] = [];
    let at = 0;
    for (const size of sizes) { out.push(Array.from({length: size}, (_, i) => at + i)); at += size; }
    return out.filter((list) => list.length > 0);
  };
  // A sentence the model was not given (a page number, a line the reading gave up on) is shown as it stands.
  const inEnglish = (page: Page, i: number) =>
    page.en[i] ? page.en[i] : <span className="sic-text__kept" lang="es">{page.es[i]}</span>;

  if (!src) return null;
  return (
    <section className="sic-text">
      <button type="button" className="sic-text__toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span>{open ? "Hide the text" : "Read the text"}</span>
        <small>Read from the page images by machine, with an English translation made by machine. Both contain errors: check them against the page.</small>
      </button>
      {open && (
        <div className="sic-text__body">
          <div className="sic-text__modes" role="group" aria-label="Language of the text">
            {([["es", "Spanish"], ["en", "English"], ["both", "Side by side"]] as [Mode, string][]).map(([value, label]) => (
              <button key={value} type="button" aria-pressed={mode === value} onClick={() => choose(value)}>{label}</button>
            ))}
          </div>
          {mode !== "es" && (
            <p className="sic-text__note">
              The English is a machine translation of the machine-read text, sentence by sentence. It is an aid to reading and to finding
              passages, not a translation to quote: period slang, verse and misread words come out wrong.
            </p>
          )}

          {mode === "es" && (
            <>
              {failed && <p>The text could not be loaded.</p>}
              {!failed && !pages && <p>Loading the text…</p>}
              {pages && pages.map((page) => (
                <article key={page.n} lang="es">
                  {page.n && <h3>Page {page.n}</h3>}
                  {page.text ? <pre>{page.text}</pre> : <p className="sic-text__empty">No text was read on this page.</p>}
                </article>
              ))}
            </>
          )}

          {mode !== "es" && english === null && <p>Loading the translation…</p>}
          {mode !== "es" && english === false && <p>There is no English translation of this item yet.</p>}

          {mode === "en" && english && english.map((page) => (
            <article key={page.n}>
              <h3>Page {page.n}</h3>
              {page.es.length === 0 && <p className="sic-text__empty">No text was read on this page.</p>}
              {paragraphs(page).map((list, k) => (
                <p key={k} className="sic-text__para">{list.map((i) => <React.Fragment key={i}>{inEnglish(page, i)} </React.Fragment>)}</p>
              ))}
            </article>
          ))}

          {mode === "both" && english && english.map((page) => (
            <article key={page.n}>
              <h3>Page {page.n}</h3>
              {page.es.length === 0 && <p className="sic-text__empty">No text was read on this page.</p>}
              {paragraphs(page).map((list, k) => (
                <div key={k} className="sic-text__pair">
                  <p lang="es">{list.map((i) => <React.Fragment key={i}>{page.es[i]} </React.Fragment>)}</p>
                  <p>{list.map((i) => <React.Fragment key={i}>{inEnglish(page, i)} </React.Fragment>)}</p>
                </div>
              ))}
            </article>
          ))}

          {pages && mode === "es" && <p className="sic-text__file"><a href={src}>Open the plain text file</a></p>}
        </div>
      )}
    </section>
  );
}
