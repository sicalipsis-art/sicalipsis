import React, {useEffect, useMemo, useState} from "react";

/**
 * Search bar for the collection pages: a keyword box (title, artist, theme or
 * any other catalogue text) and tags to tick. Searching opens the site's search
 * page with the keyword and tags applied, limited to this collection when
 * `section` is given.
 *
 * The tags and their counts are read from the search data the site build
 * publishes (api/search/facets.json), so they always match what the search
 * page itself offers. Only tags that occur in this collection are shown.
 */
type Value = {value: string; slug: string; docs: number[]};
type Facet = {label: string; slug: string; values: Value[]};

// Facets offered as tags, in this order. Creator is left to the keyword box: it has hundreds of values.
const TAG_FACETS = ["themes", "image-type", "figures", "dress", "colour", "subject", "series", "text"];
const MANY = 14;       // a group with more values than this starts folded

export default function CollectionSearch({section = ""}: {section?: string}) {
  const [facets, setFacets] = useState<Facet[]>([]);
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<Record<string, string[]>>({});
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const base = typeof window === "undefined" ? "" : ((window as any).CANOPY_BASE_PATH || "");

  useEffect(() => {
    fetch(`${base}/api/search/facets.json`)
      .then((r) => (r.ok ? r.json() : []))
      .then((json) => setFacets(Array.isArray(json) ? json : []))
      .catch(() => setFacets([]));
  }, [base]);

  // The works of this collection, as the search data numbers them.
  const within = useMemo(() => {
    if (!section) return null;
    const value = facets.find((f) => f.slug === "section")?.values.find((v) => v.value === section);
    return value ? {slug: value.slug, docs: new Set(value.docs)} : null;
  }, [facets, section]);

  const groups = useMemo(() => TAG_FACETS.map((slug) => {
    const facet = facets.find((f) => f.slug === slug);
    if (!facet) return null;
    const values = facet.values
      .map((v) => ({...v, docs: within ? v.docs.filter((d) => within.docs.has(d)) : v.docs}))
      .filter((v) => v.docs.length > 0)
      .sort((a, b) => b.docs.length - a.docs.length || a.value.localeCompare(b.value));
    if (values.length < 2 && slug === "series") return null;     // a single series says nothing
    if (slug === "text") return values.length ? {label: "Text", slug, values} : null;
    return values.length ? {label: facet.label, slug, values} : null;
  }).filter(Boolean) as Facet[], [facets, within]);

  // How many works carry the ticked tags: any tag within a group, every group.
  const matching = useMemo(() => {
    let docs: Set<number> | null = within ? new Set(within.docs) : null;
    for (const group of groups) {
      const chosen = picked[group.slug] || [];
      if (!chosen.length) continue;
      const any = new Set<number>();
      group.values.filter((v) => chosen.includes(v.slug)).forEach((v) => v.docs.forEach((d) => any.add(d)));
      docs = docs ? new Set([...docs].filter((d) => any.has(d))) : any;
    }
    return docs ? docs.size : null;
  }, [groups, picked, within]);

  const anyPicked = Object.values(picked).some((list) => list.length > 0);
  const toggle = (group: string, slug: string) => setPicked((now) => {
    const list = now[group] || [];
    return {...now, [group]: list.includes(slug) ? list.filter((s) => s !== slug) : [...list, slug]};
  });

  const search = (event?: React.FormEvent) => {
    event?.preventDefault();
    const params = new URLSearchParams({type: "work"});
    if (query.trim()) params.set("q", query.trim());
    if (within) params.set("section", within.slug);
    Object.entries(picked).forEach(([group, list]) => { if (list.length) params.set(group, list.join(",")); });
    window.location.href = `${base}/search?${params.toString()}`;
  };

  return (
    <form className="sic-csearch" role="search" aria-label={section ? `Search ${section}` : "Search the collections"} onSubmit={search}>
      <div className="sic-csearch__row">
        <label className="sic-csearch__label" htmlFor="sic-csearch-q">{section ? "Search this collection" : "Search all collections"}</label>
        <input id="sic-csearch-q" type="search" value={query} onChange={(e) => setQuery(e.target.value)}
          placeholder="Keyword, artist, title or theme" autoComplete="off" />
        <button type="submit" className="sic-csearch__go">Search</button>
      </div>
      {groups.length > 0 && (
        <div className="sic-csearch__tags">
          {groups.map((group) => {
            const folded = group.values.length > MANY && !open[group.slug];
            const shown = folded ? group.values.slice(0, MANY) : group.values;
            return (
              <fieldset key={group.slug} className="sic-csearch__group">
                <legend>{group.label}</legend>
                <div className="sic-csearch__chips">
                  {shown.map((v) => {
                    const on = (picked[group.slug] || []).includes(v.slug);
                    return (
                      <button key={v.slug} type="button" className="sic-csearch__chip" aria-pressed={on}
                        onClick={() => toggle(group.slug, v.slug)}>
                        {v.value} <span>{v.docs.length}</span>
                      </button>
                    );
                  })}
                  {group.values.length > MANY && (
                    <button type="button" className="sic-csearch__more"
                      onClick={() => setOpen((now) => ({...now, [group.slug]: !now[group.slug]}))}>
                      {folded ? `Show all ${group.values.length}` : "Show fewer"}
                    </button>
                  )}
                </div>
              </fieldset>
            );
          })}
          {anyPicked && (
            <p className="sic-csearch__status" aria-live="polite">
              {matching === 1 ? "1 item has" : `${matching ?? 0} items have`} the selected tags.{" "}
              <button type="submit" className="sic-csearch__show">Show {matching === 1 ? "it" : "them"}</button>{" "}
              <button type="button" className="sic-csearch__clear" onClick={() => setPicked({})}>Clear tags</button>
            </p>
          )}
        </div>
      )}
    </form>
  );
}
