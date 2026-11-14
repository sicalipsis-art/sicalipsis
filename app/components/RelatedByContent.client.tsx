import React, {useEffect, useState} from "react";
import site from "../data/site.json";

/**
 * "Looks like" and "Reads like": other items whose first page resembles this
 * one's, and other items whose text uses similar words. The lists are worked
 * out by tools/make_related.py and kept in the file bucket
 * (web/related/related.json), so they change without a new build of the site.
 * Titles, pictures and links come from the site's own search data.
 *
 * These are suggestions made by comparing pictures and vocabulary, and the
 * section says so.
 */
type Card = {id: string; title: string; href: string; thumb: string};

export default function RelatedByContent({manifest = ""}: {manifest?: string}) {
  const [rows, setRows] = useState<{label: string; note: string; cards: Card[]}[]>([]);
  const id = (/\/iiif\/([^/]+)\/manifest\.json/.exec(manifest) || [])[1];

  useEffect(() => {
    if (!id) return;
    let live = true;
    const base = (window as any).CANOPY_BASE_PATH || "";
    (async () => {
      try {
        const [related, index] = await Promise.all([
          fetch(`${site.webBase}/related/related.json`).then((r) => r.json()),
          fetch(`${base}/api/search-records.json`).then((r) => r.json()),
        ]);
        const mine = related[id];
        if (!mine || !live) return;
        const records = Array.isArray(index) ? index : index.records || [];
        const cards: Record<string, Card> = {};
        for (const r of records) {
          const m = /\/images\/([^/]+)\/thumb\.jpg/.exec(r.thumbnail || "");
          if (m && r.href) cards[m[1]] = {id: m[1], title: r.title, href: `${base}${r.href}`, thumb: r.thumbnail};
        }
        const pick = (list: string[]) => (list || []).map((other) => cards[other]).filter(Boolean);
        setRows([
          {label: "Looks like", note: "Items whose first page resembles this one.", cards: pick(mine.looks)},
          {label: "Reads like", note: "Items whose text uses similar words.", cards: pick(mine.reads)},
          {label: "Pictures connected with this text", note: "Pictures from the same publication, or that match what the text is about.", cards: pick(mine.pictures)},
          {label: "Texts connected with this picture", note: "The publication it comes from, or texts about what it shows.", cards: pick(mine.texts)},
        ].filter((row) => row.cards.length > 0));
      } catch { /* the section simply stays away */ }
    })();
    return () => { live = false; };
  }, [id]);

  if (!rows.length) return null;
  return (
    <section className="sic-related" aria-label="Similar items">
      {rows.map((row) => (
        <div key={row.label} className="sic-related__row">
          <h2>{row.label}</h2>
          <p>{row.note}</p>
          <ul>
            {row.cards.map((card) => (
              <li key={card.id}>
                <a href={card.href}>
                  <img src={card.thumb} alt="" loading="lazy" />
                  <span>{card.title}</span>
                </a>
              </li>
            ))}
          </ul>
        </div>
      ))}
      <p className="sic-related__about">Suggested by comparing the pictures and the wording of the texts by machine; a resemblance is not a statement about the works.</p>
    </section>
  );
}
