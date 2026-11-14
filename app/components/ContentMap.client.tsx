import React, {useEffect, useRef, useState} from "react";
import site from "../data/site.json";

/**
 * The collection as a network. Every item is a point, placed so that items
 * whose first pages look alike sit near each other. Lines join an item to the
 * items it looks like (amber), the items its text reads like (blue), and, in
 * green, a text to the pictures connected with it (the same publication, or a
 * strong match of subject). All are worked out by tools/make_related.py and
 * read from the file bucket.
 *
 * Wheel to zoom, drag to move, point at an item to see what it is linked to,
 * click to keep it selected. Pictures appear once the view is close enough.
 * The same links are on every item page as lists, which is the way to them
 * for keyboards and screen readers.
 */
type Node = {id: string; x: number; y: number; section: number; title: string; href: string; thumb: string};
const COLOURS = ["#e0a63c", "#6fb1c9", "#c97a9a", "#8fbf7a", "#b99ae0", "#d98a5a", "#9aa3ad"];

export default function ContentMap({height = "78vh"}: {height?: string}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [sections, setSections] = useState<string[]>([]);
  const [hidden, setHidden] = useState<Set<number>>(new Set());
  const [links, setLinks] = useState({looks: true, reads: true, cross: true});
  const [picked, setPicked] = useState<Node | null>(null);
  const [status, setStatus] = useState("Loading the network…");
  const data = useRef<{nodes: Node[]; by: Record<string, number>; looks: number[][]; reads: number[][]; cross: number[][]} | null>(null);
  const view = useRef({x: 0, y: 0, k: 1});
  const hover = useRef(-1);
  const chosen = useRef(-1);
  const redraw = useRef<() => void>(() => {});
  const options = useRef({hidden, links});
  options.current = {hidden, links};

  useEffect(() => {
    let live = true;
    const base = (window as any).CANOPY_BASE_PATH || "";
    (async () => {
      try {
        const [chart, related, index] = await Promise.all([
          fetch(`${site.webBase}/related/map.json`).then((r) => r.json()),
          fetch(`${site.webBase}/related/related.json`).then((r) => r.json()),
          fetch(`${base}/api/search-records.json`).then((r) => r.json()).catch(() => []),
        ]);
        const cards: Record<string, {title: string; href: string}> = {};
        for (const r of (Array.isArray(index) ? index : index.records || [])) {
          const m = /\/images\/([^/]+)\/thumb\.jpg/.exec(r.thumbnail || "");
          if (m && r.href) cards[m[1]] = {title: r.title, href: `${base}${r.href}`};
        }
        const nodes: Node[] = chart.items.map(([id, x, y, section]: [string, number, number, number]) => ({
          id, x, y, section, title: cards[id]?.title || id, href: cards[id]?.href || "",
          thumb: `${site.webBase}/images/${id}/thumb.jpg`,
        }));
        const by: Record<string, number> = {};
        nodes.forEach((n, i) => { by[n.id] = i; });
        const lists = (kind: "looks" | "reads" | "pictures" | "texts") => nodes.map((n) => ((related[n.id] || {})[kind] || []).slice(0, 4)
          .map((other: string) => by[other]).filter((i: number | undefined) => i !== undefined));
        if (!live) return;
        const pictures = lists("pictures"), texts = lists("texts");
        data.current = {nodes, by, looks: lists("looks"), reads: lists("reads"), cross: nodes.map((_, i) => [...pictures[i], ...texts[i]])};
        setSections(chart.sections);
        setStatus("");
      } catch {
        if (live) setStatus("The network could not be loaded.");
      }
    })();
    return () => { live = false; };
  }, []);

  useEffect(() => {
    const el = canvas.current;
    if (!el || status) return;
    const ctx = el.getContext("2d")!;
    const pictures = new Map<string, HTMLImageElement>();
    let width = 0, height2 = 0, queued = 0;
    const size = () => Math.min(width, height2) * 0.92;
    const at = (n: Node) => {
      const v = view.current, s = size();
      return {x: width / 2 + ((n.x - 0.5) * s + v.x) * v.k, y: height2 / 2 + ((n.y - 0.5) * s + v.y) * v.k};
    };
    const draw = () => {
      queued = 0;
      const d = data.current!;
      const {hidden: off, links: show} = options.current;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height2);
      const k = view.current.k;
      const focus = chosen.current >= 0 ? chosen.current : hover.current;
      const pos = d.nodes.map(at);
      const seen = (i: number) => !off.has(d.nodes[i].section);
      const edges = (lists: number[][], colour: string) => {
        ctx.strokeStyle = colour;
        ctx.lineWidth = 1;
        ctx.globalAlpha = focus >= 0 ? 0.05 : Math.min(0.32, 0.07 * k);
        ctx.beginPath();
        lists.forEach((list, i) => { if (seen(i)) for (const j of list) if (seen(j)) { ctx.moveTo(pos[i].x, pos[i].y); ctx.lineTo(pos[j].x, pos[j].y); } });
        ctx.stroke();
        if (focus >= 0) {                              // the links of the item pointed at, drawn strongly
          ctx.globalAlpha = 0.95;
          ctx.lineWidth = 2;
          ctx.beginPath();
          for (const j of lists[focus]) { ctx.moveTo(pos[focus].x, pos[focus].y); ctx.lineTo(pos[j].x, pos[j].y); }
          lists.forEach((list, i) => { if (list.includes(focus)) { ctx.moveTo(pos[i].x, pos[i].y); ctx.lineTo(pos[focus].x, pos[focus].y); } });
          ctx.stroke();
        }
        ctx.globalAlpha = 1;
      };
      if (show.looks) edges(d.looks, "#e0a63c");
      if (show.reads) edges(d.reads, "#6fb1c9");
      if (show.cross) edges(d.cross, "#9bd17f");
      const near = new Set<number>(focus >= 0 ? [focus, ...(show.looks ? d.looks[focus] : []), ...(show.reads ? d.reads[focus] : []), ...(show.cross ? d.cross[focus] : [])] : []);
      const big = Math.max(26, Math.min(120, 9 * k));      // picture size once the view is close
      let drawn = 0;
      d.nodes.forEach((n, i) => {
        if (!seen(i)) return;
        const p = pos[i];
        if (p.x < -60 || p.y < -60 || p.x > width + 60 || p.y > height2 + 60) return;
        const wanted = near.has(i) || (k >= 3.2 && drawn < 160);
        if (wanted) {
          let img = pictures.get(n.id);
          if (!img) { img = new Image(); img.onload = () => redraw.current(); img.src = n.thumb; pictures.set(n.id, img); }
          if (img.complete && img.naturalWidth) {
            const h = near.has(i) ? Math.max(big, 64) : big, w = h * img.naturalWidth / img.naturalHeight;
            ctx.drawImage(img, p.x - w / 2, p.y - h / 2, w, h);
            ctx.strokeStyle = i === focus ? "#ffffff" : COLOURS[n.section % COLOURS.length];
            ctx.lineWidth = i === focus ? 3 : 1.5;
            ctx.strokeRect(p.x - w / 2, p.y - h / 2, w, h);
            drawn++;
            return;
          }
        }
        ctx.fillStyle = COLOURS[n.section % COLOURS.length];
        ctx.globalAlpha = focus >= 0 && !near.has(i) ? 0.35 : 0.95;
        ctx.beginPath();
        ctx.arc(p.x, p.y, Math.max(2.2, Math.min(7, 1.6 * Math.sqrt(k) + 1)), 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
      });
      if (focus >= 0) {                                // the name of the item pointed at
        const n = d.nodes[focus], p = pos[focus];
        ctx.font = "500 14px Inter, Arial, sans-serif";
        const text = n.title.length > 70 ? n.title.slice(0, 68) + "…" : n.title;
        const w = ctx.measureText(text).width + 16;
        const x = Math.max(4, Math.min(width - w - 4, p.x - w / 2)), y = Math.max(4, p.y - 70);
        ctx.fillStyle = "rgba(12,10,8,0.92)";
        ctx.fillRect(x, y, w, 26);
        ctx.fillStyle = "#f1ebe2";
        ctx.fillText(text, x + 8, y + 18);
      }
    };
    const ask = () => { if (!queued) queued = requestAnimationFrame(draw); };
    redraw.current = ask;
    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      width = el.clientWidth; height2 = el.clientHeight;
      el.width = Math.round(width * dpr); el.height = Math.round(height2 * dpr);
      ask();
    };
    const nearest = (mx: number, my: number) => {
      const d = data.current!;
      let best = -1, bestDist = 18 * 18;
      d.nodes.forEach((n, i) => {
        if (options.current.hidden.has(n.section)) return;
        const p = at(n), dist = (p.x - mx) ** 2 + (p.y - my) ** 2;
        if (dist < bestDist) { best = i; bestDist = dist; }
      });
      return best;
    };
    let drag: {x: number; y: number; moved: number} | null = null;
    const local = (e: {clientX: number; clientY: number}) => { const r = el.getBoundingClientRect(); return {x: e.clientX - r.left, y: e.clientY - r.top}; };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const m = local(e), v = view.current, s = size();
      const k = Math.max(0.8, Math.min(40, v.k * Math.exp(-e.deltaY * 0.0016)));
      // keep the point under the cursor where it is
      const wx = (m.x - width / 2) / v.k - v.x, wy = (m.y - height2 / 2) / v.k - v.y;
      v.x = (m.x - width / 2) / k - wx; v.y = (m.y - height2 / 2) / k - wy; v.k = k;
      void s;
      ask();
    };
    const onDown = (e: PointerEvent) => { drag = {x: e.clientX, y: e.clientY, moved: 0}; el.setPointerCapture(e.pointerId); };
    const onMove = (e: PointerEvent) => {
      if (drag) {
        const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
        drag.moved += Math.abs(dx) + Math.abs(dy);
        drag.x = e.clientX; drag.y = e.clientY;
        view.current.x += dx / view.current.k; view.current.y += dy / view.current.k;
        ask();
        return;
      }
      const m = local(e), i = nearest(m.x, m.y);
      if (i !== hover.current) { hover.current = i; el.style.cursor = i >= 0 ? "pointer" : "grab"; ask(); }
    };
    const onUp = (e: PointerEvent) => {
      const wasDrag = drag && drag.moved > 5;
      drag = null;
      if (wasDrag) return;
      const m = local(e), i = nearest(m.x, m.y);
      chosen.current = i;
      if (i >= 0 && width > 640) {                     // keep the chosen item clear of the panel that opens on the right
        const edge = width - Math.min(304, width * 0.8) - 170, p = at(data.current!.nodes[i]);
        if (p.x > edge) view.current.x -= (p.x - edge) / view.current.k;
      }
      setPicked(i >= 0 ? data.current!.nodes[i] : null);
      ask();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(el);
    el.addEventListener("wheel", onWheel, {passive: false});
    el.addEventListener("pointerdown", onDown);
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    resize();
    return () => {
      observer.disconnect();
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      cancelAnimationFrame(queued);
    };
  }, [status]);

  useEffect(() => { redraw.current(); }, [hidden, links]);

  const d = data.current;
  const neighbours = (kind: "looks" | "reads" | "cross") => (picked && d ? d[kind][d.by[picked.id]].map((i) => d.nodes[i]) : []);
  return (
    <section className="sic-net" aria-label="Network of the collection">
      <div className="sic-net__bar">
        <div className="sic-net__legend">
          {sections.map((name, i) => (
            <button key={name} type="button" aria-pressed={!hidden.has(i)}
              onClick={() => setHidden((now) => { const next = new Set(now); if (next.has(i)) next.delete(i); else next.add(i); return next; })}>
              <i style={{background: COLOURS[i % COLOURS.length]}} />{name || "No section"}
            </button>
          ))}
        </div>
        <label><input type="checkbox" checked={links.looks} onChange={(e) => setLinks({...links, looks: e.target.checked})} /> <b className="sic-net__looks">Looks like</b></label>
        <label><input type="checkbox" checked={links.reads} onChange={(e) => setLinks({...links, reads: e.target.checked})} /> <b className="sic-net__reads">Reads like</b></label>
        <label><input type="checkbox" checked={links.cross} onChange={(e) => setLinks({...links, cross: e.target.checked})} /> <b className="sic-net__cross">Text and picture</b></label>
      </div>
      <div className="sic-net__stage" style={{height}}>
        {status ? <p className="sic-walk__status">{status}</p> : <canvas ref={canvas} aria-hidden="true" />}
        {picked && (
          <aside className="sic-net__panel">
            <img src={picked.thumb} alt="" />
            <h3>{picked.title}</h3>
            <p className="sic-eyebrow">{sections[picked.section]}</p>
            {picked.href && <a className="sic-net__open" href={picked.href}>Open this item</a>}
            {(["looks", "reads", "cross"] as const).map((kind) => (neighbours(kind).length ? (
              <div key={kind}>
                <h4 className={kind === "looks" ? "sic-net__looks" : kind === "reads" ? "sic-net__reads" : "sic-net__cross"}>{kind === "looks" ? "Looks like" : kind === "reads" ? "Reads like" : "Text and picture"}</h4>
                <ul>{neighbours(kind).map((n) => <li key={n.id}><a href={n.href || n.thumb}>{n.title}</a></li>)}</ul>
              </div>
            ) : null))}
            <button type="button" onClick={() => { chosen.current = -1; setPicked(null); redraw.current(); }}>Close</button>
          </aside>
        )}
      </div>
      <p className="sic-net__about">
        Each point is an item; items whose first pages look alike are placed near each other. Amber lines join items that look alike, blue lines items whose texts read alike, and green lines a text and the pictures connected with it. Wheel to zoom, drag to move, click an item to see its links.
        The links are suggestions made by comparing pictures and the wording of texts by machine, and say nothing certain about the works.
      </p>
    </section>
  );
}
