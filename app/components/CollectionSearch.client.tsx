import React, {useEffect, useMemo, useState} from "react";

/**
 * Search bar for the collection pages: a keyword box (title, artist, theme or
 * any other catalogue text) and, behind a "Filter by term" button, the terms the
 * catalogue uses. Searching opens the site's search page with the keyword and
 * terms applied, limited to this collection when `section` is given.
 *
 * The terms are read from the search data the site build publishes
 * (api/search/facets.json), so they always match what the search page itself
 * offers. As terms are ticked, the number beside every other term becomes the
 * number of items that would remain if it were ticked too, and terms that no
 * remaining item carries are taken away, so a choice can never lead to nothing.
 * Within a group any ticked term will do; across groups all must hold.
 */
type Value = {value: string; slug: string; docs: number[]};
type Facet = {label: string; slug: string; values: Value[]};
type Shown = Value & {count: number; on: boolean};

// Facets offered as terms, in this order. Creator is left to the keyword box: it has hundreds of values.
const TERM_FACETS = ["section", "themes", "image-type", "figures", "dress", "colour", "subject", "series", "text"];
const MANY = 14;       // a group with more values than this starts folded

export default function CollectionSearch({section = ""}: {section?: string}) {
  const [facets, setFacets] = useState<Facet[]>([]);
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<Record<string, string[]>>({});
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [filtering, setFiltering] = useState(false);
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

  // Every group with the terms that occur in this collection at all.
  const groups = useMemo(() => TERM_FACETS.map((slug) => {
    if (slug === "section" && section) return null;              // already limited to one section
    const facet = facets.find((f) => f.slug === slug);
    if (!facet) return null;
    const values = facet.values
      .map((v) => ({...v, docs: within ? v.docs.filter((d) => within.docs.has(d)) : v.docs}))
      .filter((v) => v.docs.length > 0);
    if (values.length < 2 && slug === "series") return null;     // a single series says nothing
    return values.length ? {label: facet.label, slug, values} : null;
  }).filter(Boolean) as Facet[], [facets, within, section]);

  // For each group, the works that carry any of its ticked terms (null when none is ticked).
  const chosen = useMemo(() => {
    const sets: Record<string, Set<number> | null> = {};
    for (const group of groups) {
      const list = picked[group.slug] || [];
      if (!list.length) { sets[group.slug] = null; continue; }
      const any = new Set<number>();
      group.values.filter((v) => list.includes(v.slug)).forEach((v) => v.docs.forEach((d) => any.add(d)));
      sets[group.slug] = any;
    }
    return sets;
  }, [groups, picked]);

  // What the ticked terms leave, with one group's own ticks set aside (so that group's other terms can still be added).
  const remaining = (except: string) => (doc: number) =>
    groups.every((g) => g.slug === except || !chosen[g.slug] || chosen[g.slug]!.has(doc));

  const anyPicked = Object.values(picked).some((list) => list.length > 0);
  const pickedCount = Object.values(picked).reduce((n, list) => n + list.length, 0);

  // Each group as it should be shown now: live counts, incompatible terms left out.
  const shownGroups = useMemo(() => groups.map((group) => {
    const keep = remaining(group.slug);
    const list = picked[group.slug] || [];
    const values: Shown[] = group.values
      .map((v) => ({...v, on: list.includes(v.slug), count: anyPicked ? v.docs.filter(keep).length : v.docs.length}))
      .filter((v) => v.count > 0 || v.on)
      .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
    return {...group, values};
  }).filter((group) => group.values.length > 0), [groups, chosen, picked, anyPicked]);

  // How many works carry the ticked terms.
  const matching = useMemo(() => {
    if (!anyPicked) return null;
    const all = new Set<number>();
    groups.forEach((g) => { if (chosen[g.slug]) chosen[g.slug]!.forEach((d) => all.add(d)); });
    const keep = remaining("");
    return [...all].filter(keep).length;
  }, [groups, chosen, anyPicked]);

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
        <div className="sic-csearch__bar">
          <button type="button" className="sic-csearch__filter" aria-expanded={filtering} aria-controls="sic-csearch-terms"
            onClick={() => setFiltering(!filtering)}>
            <span aria-hidden="true">{filtering ? "−" : "+"}</span> Filter by term{pickedCount ? ` (${pickedCount} chosen)` : ""}
          </button>
          {anyPicked && (
            <p className="sic-csearch__status" aria-live="polite">
              {matching === 1 ? "1 item" : `${matching ?? 0} items`}{" "}
              <button type="submit" className="sic-csearch__show">Show {matching === 1 ? "it" : "them"}</button>{" "}
              <button type="button" className="sic-csearch__clear" onClick={() => setPicked({})}>Clear terms</button>
            </p>
          )}
        </div>
      )}
      {filtering && shownGroups.length > 0 && (
        <div className="sic-csearch__tags" id="sic-csearch-terms">
          {shownGroups.map((group) => {
            const folded = group.values.length > MANY && !open[group.slug];
            // When folded, the ticked terms stay in view whatever their rank.
            const shown = folded ? group.values.filter((v, i) => i < MANY || v.on) : group.values;
            return (
              <fieldset key={group.slug} className="sic-csearch__group">
                <legend>{group.label}</legend>
                <div className="sic-csearch__chips">
                  {shown.map((v) => (
                    <button key={v.slug} type="button" className="sic-csearch__chip" aria-pressed={v.on}
                      onClick={() => toggle(group.slug, v.slug)}>
                      {v.value} <span>{v.count}</span>
                    </button>
                  ))}
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
        </div>
      )}
    </form>
  );
}
