import React, {useEffect, useState} from "react";

/**
 * The text of an item's pages, as read from the page images by OCR, shown under
 * the viewer. The text file is fetched from the file bucket when the section is
 * opened (tools/ocr_from_r2.py writes it; tools/make_annotations.py puts its
 * address in the manifest as seeAlso). Pages are separated by headings.
 *
 * OCR text contains errors, and the section says so.
 */
export default function ItemText({src = ""}: {src?: string}) {
  const [open, setOpen] = useState(false);
  const [pages, setPages] = useState<{n: string; text: string}[] | null>(null);
  const [failed, setFailed] = useState(false);

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

  if (!src) return null;
  return (
    <section className="sic-text">
      <button type="button" className="sic-text__toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span>{open ? "Hide the text" : "Read the text"}</span>
        <small>Read from the page images by machine. It contains errors: check it against the page.</small>
      </button>
      {open && (
        <div className="sic-text__body">
          {failed && <p>The text could not be loaded.</p>}
          {!failed && !pages && <p>Loading the text…</p>}
          {pages && pages.map((page) => (
            <article key={page.n}>
              {page.n && <h3>Page {page.n}</h3>}
              {page.text ? <pre>{page.text}</pre> : <p className="sic-text__empty">No text was read on this page.</p>}
            </article>
          ))}
          {pages && <p className="sic-text__file"><a href={src}>Open the plain text file</a></p>}
        </div>
      )}
    </section>
  );
}
