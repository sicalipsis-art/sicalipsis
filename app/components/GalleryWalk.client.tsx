import React, {useEffect, useMemo, useRef, useState} from "react";
import * as THREE from "three";
import site from "../data/site.json";
import plan from "../data/gallery_periods.json";

/**
 * Walk-through gallery: the published works staged as an exhibition that the
 * visitor is free to roam.
 *
 * The visitor arrives in a forecourt, in front of the building, and enters an
 * entrance hall. The hall is the map: each gallery (a section of the
 * collection) is shown on its walls by three of its own works, and a click on
 * one of them goes into that gallery. Inside a gallery the works hang in a few
 * large rooms, by series or author and then by date. Rooms differ: width and
 * ceiling height vary, each gallery has its own wall colour, and there are
 * three kinds of hang (see `kindOf`): a single line, a two-tier "salon" hang for
 * long runs, and a room divided by a freestanding wall. A map of the building
 * can be opened at any time to go straight to a gallery or a room.
 *
 * Moving: drag to look around, or switch on mouse look and simply move the
 * mouse; W A S D or the arrow keys to walk and turn; the
 * wheel walks forward and back; a click on the floor walks there; a click on a
 * work walks up to it and shows its label. "Open" (or a second click on the
 * work) shows it in a viewer inside the gallery: zoom, pages, full screen.
 *
 * Staging choices, from exhibition research and comparable web galleries:
 *  - doors on opposite sides of each room, so the exit is never in view from
 *    the entrance (exits compete with exhibits for attention: Melton, Bitgood);
 *  - a title wall and one key work face each entrance, in the first sightline;
 *  - a suggested route, but free choice of where to go;
 *  - seating in the rooms; labels in the same place under every work; short
 *    text (Serrell; Smithsonian accessibility guidelines);
 *  - keys and the wheel are captured only after the visitor steps in;
 *  - every work is also in a plain list by room, the view for screen readers,
 *    keyboards and browsers without WebGL; "reduce motion" removes easing.
 *
 * The works come from web/walk/works.json in the file bucket (tools/make_walk.py).
 */

type Work = {
  id: string; title: string; creator: string; date: string; year: string; estimated?: boolean;
  section: string; series: string; thumb: string; image: string; w: number; h: number; pages: number;
  group?: string; gorder?: number;
  href?: string;
};
/** A gallery as the entrance hall and the map show it: its name and three of its works. */
type Portal = {title: string; count: number; rooms: number; to: number; works: Work[]};
type Room = {period: string; tone: number; title: string; subtitle: string; works: Work[]; kind?: "court" | "hall"; portals?: Portal[]};
type Place = {work: Work; room: number; x: number; y: number; z: number; facing: number; nx: number; nz: number; width: number; height: number; small: boolean; to?: number};
type Mark = {x: number; z: number; nx: number; title: string; note: string};
type Rect = {x0: number; x1: number; z0: number; z1: number};
type Shell = {index: number; z: number; depth: number; half: number; height: number; entry: number; exit: number; kind: string; tone: number; blocks: Rect[]; divider: Rect | null; titleX: number; marks: Mark[]};
type Point = {x: number; z: number};

const EYE = 1.62;
const HANG = 1.58;            // height of a work's centre in a single-line hang
const STEP = 2.7;             // between works on one wall
const DOOR_W = 2.4;
const DOOR_H = 2.9;
const STAND = 3.0;            // viewing distance from a wall
const BODY = 0.5;             // how close the visitor can get to a wall
const WALK = 4.2;             // metres per second
const NEAR_LOAD = 30;
const NEAR_SHARP = 10;
const FAR_DROP = 46;
const WALLS = ["#3b332d", "#2f3833", "#3a2e36", "#2d3440", "#40372a", "#33302f", "#4a443d"];   // one wall colour per gallery; the last is the entrance hall's

function makeRooms(works: Work[]): Room[] {
  const size = plan.roomSize;
  const order = [...plan.sections, ...Array.from(new Set(works.map((w) => w.section))).filter((s) => !plan.sections.includes(s))];
  const galleries: Room[] = [];
  const portals: Portal[] = [];
  order.forEach((section, tone) => {
    // By series or author in the collection's own order, then by date (the works arrive in date order).
    const all = works.filter((w) => w.section === section)
      .map((w, i) => ({w, i})).sort((a, b) => (a.w.gorder ?? 9999) - (b.w.gorder ?? 9999) || a.i - b.i).map((x) => x.w);
    if (!all.length) return;
    const first = galleries.length;
    let batch: Work[] = [];
    const flush = () => {
      if (!batch.length) return;
      const names = Array.from(new Set(batch.map((w) => w.group || "").filter(Boolean)));
      const years = batch.map((w) => w.year).filter(Boolean).sort();
      const span = years.length ? (years[0] === years[years.length - 1] ? years[0] : `${years[0]} to ${years[years.length - 1]}`) : "undated";
      const title = names.length ? names.slice(0, 3).join(" · ") + (names.length > 3 ? " and others" : "") : span;
      galleries.push({period: section, tone, title, subtitle: names.length ? span : "", works: batch});
      batch = [];
    };
    all.forEach((w, i) => {
      const next = all[i + 1];
      batch.push(w);
      // Close the room when it is full, or at a change of series once it is more than half full.
      if (batch.length >= size || (next && (next.group || "") !== (w.group || "") && batch.length >= size * 0.6)) flush();
    });
    flush();
    const mine = galleries.slice(first);
    mine.forEach((room) => {
      const same = mine.filter((other) => other.title === room.title);
      if (same.length > 1) room.subtitle = [room.subtitle, `part ${same.indexOf(room) + 1} of ${same.length}`].filter(Boolean).join(" · ");
    });
    const picks = Array.from(new Set([0, Math.floor(all.length / 2), all.length - 1])).map((i) => all[i]);
    portals.push({title: section, count: all.length, rooms: galleries.length - first, to: first + 2, works: picks});
  });
  if (!galleries.length) return [];
  return [
    {period: "Entrance", tone: 6, title: "Forecourt", subtitle: "", works: [], kind: "court"},
    {period: "Entrance", tone: 6, title: "Entrance hall", subtitle: "The galleries", works: [], kind: "hall", portals},
    ...galleries,
  ];
}

/** Which hang a room gets: long runs are hung salon-style, some mid-sized rooms get a dividing wall. */
function kindOf(count: number, index: number) {
  if (count >= 11) return "salon";
  if (count >= 7 && index % 2 === 1) return "divided";
  return "line";
}

function stage(rooms: Room[]) {
  const places: Place[] = [];
  const route: Point[] = [];
  const shells: Shell[] = [];
  let z = 0;
  let entry = 4;
  const kindAt = (i: number) => rooms[i].kind || kindOf(rooms[i].works.length, i);
  const halfAt = (i: number) => {
    const k = kindAt(i);
    return k === "court" ? 11 : k === "hall" ? 9 : k === "divided" ? 7.5 : [6.5, 5.6, 7.2][(i * 2 + rooms[i].tone) % 3];
  };
  entry = 0;                                               // the building's door is in the middle of its front
  rooms.forEach((room, index) => {
    const kind = kindAt(index);
    const half = halfAt(index);
    const height = kind === "court" ? 9 : kind === "hall" ? 6.4 : [4.6, 5.4, 4.2, 5.0][(index + room.tone * 2) % 4];
    const nextHalf = index + 1 < rooms.length ? halfAt(index + 1) : half;
    const reach = Math.min(half, nextHalf) - 1.9;          // how far from the centre a door can sit
    const s = entry >= 0 ? 1 : -1;
    const exit = kind === "court" ? 0 : -s * Math.min(reach, index % 3 === 2 ? 3 : 4);
    const marks: Mark[] = [];
    const big = {w: 2.0, h: 1.6}, small = {w: 1.35, h: 1.02};
    const fit = (w: Work, box: {w: number; h: number}) => {
      const aspect = w.w / Math.max(1, w.h);
      let height = box.h, width = height * aspect;
      if (width > box.w) { width = box.w; height = width / aspect; }
      return {width, height};
    };
    const rest = room.works.slice(1);
    const blocks: Rect[] = [];
    let divider: Rect | null = null;
    let depth = 9;
    const hang = (work: Work, x: number, wz: number, nx: number, y = HANG, box = big) => {
      places.push({work, room: index, x, y, z: wz, facing: nx > 0 ? Math.PI / 2 : nx < 0 ? -Math.PI / 2 : 0, nx, nz: 0, ...fit(work, box), small: box === small});
    };
    route.push({x: entry, z: z - 0.9});

    if (kind === "court") {                                // open air in front of the building
      depth = 14;
      for (const cx of [-5.6, -2.4, 2.4, 5.6]) blocks.push({x0: cx - 0.4, x1: cx + 0.4, z0: z - depth + 0.9, z1: z - depth + 1.7});   // columns
    } else if (kind === "hall") {                          // each gallery shown by three of its works
      const list = room.portals || [];
      const perWall = Math.ceil(list.length / 2);
      depth = Math.max(16, 3.6 + perWall * 8.2);
      list.forEach((portal, n) => {
        const side = n < perWall ? 1 : -1;
        const centre = z - 5.2 - (n < perWall ? n : n - perWall) * 8.2;
        portal.works.forEach((work, k) => {
          hang(work, side * (half - 0.07), centre + (k - (portal.works.length - 1) / 2) * 2.3, -side, 1.75, big);
          places[places.length - 1].to = portal.to;
        });
        marks.push({x: side * (half - 0.16), z: centre, nx: -side, title: portal.title,
          note: `${portal.count} works · ${portal.rooms} ${portal.rooms === 1 ? "room" : "rooms"}`});
      });
      blocks.push({x0: -1.2, x1: 1.2, z0: z - depth / 2 - 0.35, z1: z - depth / 2 + 0.35});   // the bench
      route.push({x: 0, z: z - depth / 2 - 1.6});
    } else if (kind === "salon") {                         // two tiers on each side wall
      const perWall = Math.ceil(rest.length / 2);
      const columns = Math.ceil(perWall / 2);
      depth = Math.max(10, 3.2 + 1.95 * columns);
      for (const k of [-1, 1]) {                           // two benches along the middle
        const bz = z - depth / 2 + k * depth / 5;
        blocks.push({x0: -0.35, x1: 0.35, z0: bz - 1.1, z1: bz + 1.1});
      }
      [rest.slice(0, perWall), rest.slice(perWall)].forEach((list, wallNo) => {
        const side = wallNo === 0 ? s : -s;
        list.forEach((work, i) => hang(work, side * (half - 0.07), z - 2.1 - Math.floor(i / 2) * 1.95, -side, i % 2 === 0 ? 2.32 : 1.12, small));
        if (wallNo === 1) route.push({x: 0, z: z - depth / 2});
        for (let c = 0; c < Math.ceil(list.length / 2); c++) route.push({x: side * (half - STAND), z: z - 2.1 - c * 1.95});
      });
    } else if (kind === "divided") {                       // a freestanding wall down the middle
      const per = Math.ceil(rest.length / 4);
      depth = Math.max(13, 8.4 + STEP * per);
      const top = z - 4.0;                                 // the divider starts here and runs back
      divider = {x0: -0.15, x1: 0.15, z0: z - depth + 4.4, z1: top};
      blocks.push(divider);
      const lists = [rest.slice(0, per), rest.slice(per, 2 * per), rest.slice(2 * per, 3 * per), rest.slice(3 * per)];
      lists[0].forEach((work, i) => hang(work, s * (half - 0.07), z - 2.2 - i * STEP, -s));              // near wall
      lists[1].forEach((work, i) => hang(work, s * 0.22, top - 1.3 - i * STEP, s));                       // divider, near face
      lists[2].forEach((work, i) => hang(work, -s * 0.22, top - 1.3 - i * STEP, -s));                     // divider, far face
      lists[3].forEach((work, i) => hang(work, -s * (half - 0.07), z - 2.2 - i * STEP, s));               // far wall
      route.push({x: s * half / 2, z: z - 2.4}, {x: s * half / 2, z: z - depth + 2.6}, {x: -s * half / 2, z: z - depth + 2.6}, {x: -s * half / 2, z: z - 3.0});
    } else {                                               // a single line along each side wall
      const near = rest.slice(0, Math.ceil(rest.length / 2));
      const far = rest.slice(near.length);
      depth = Math.max(9, 2.4 + STEP * Math.max(near.length, 1));
      near.forEach((work, i) => { hang(work, s * (half - 0.07), z - 1.9 - i * STEP, -s); route.push({x: s * (half - STAND), z: z - 1.9 - i * STEP}); });
      route.push({x: 0, z: z - depth / 2 - 1.6});
      far.forEach((work, i) => { hang(work, -s * (half - 0.07), z - 1.9 - i * STEP, s); route.push({x: -s * (half - STAND), z: z - 1.9 - i * STEP}); });
      blocks.push({x0: -1.2, x1: 1.2, z0: z - depth / 2 - 0.35, z1: z - depth / 2 + 0.35});   // the bench
    }
    const back = z - depth;
    const hero = room.works[0];                            // the key work, on the back wall facing the entrance
    if (hero) places.push({work: hero, room: index, x: entry, y: HANG, z: back + 0.22, facing: 0, nx: 0, nz: 1, ...fit(hero, big), small: false});
    const options = [entry + 3.0, entry - 3.0].filter((x) => Math.abs(x) < half - 1.7 && Math.abs(x - exit) > 2.9 && Math.abs(x) > (divider ? 2 : -1));
    const titleX = options.length ? options[0] : entry;
    route.push({x: exit, z: back + 1.4});
    shells.push({index, z, depth, half, height, entry, exit, kind, tone: room.tone, blocks, divider, titleX, marks});
    z = back;
    entry = exit;
  });
  return {places, route, shells, end: z};
}

function textTexture(lines: {text: string; font: string; color: string}[], width: number, height: number, align: CanvasTextAlign = "center") {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d")!;
  ctx.textAlign = align;
  ctx.textBaseline = "middle";
  const step = height / (lines.length + 1);
  lines.forEach((line, i) => {
    ctx.font = line.font;
    ctx.fillStyle = line.color;
    let text = line.text;
    while (text.length > 4 && ctx.measureText(text).width > width - 40) text = text.slice(0, -2);
    if (text !== line.text) text = text.trimEnd() + "…";
    ctx.fillText(text, align === "center" ? width / 2 : 20, step * (i + 1));
  });
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

function glowTexture() {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 256;
  const ctx = canvas.getContext("2d")!;
  const g = ctx.createRadialGradient(128, 104, 10, 128, 128, 128);
  g.addColorStop(0, "rgba(255, 238, 208, 0.36)");
  g.addColorStop(0.55, "rgba(255, 228, 186, 0.10)");
  g.addColorStop(1, "rgba(255, 228, 186, 0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 256, 256);
  return new THREE.CanvasTexture(canvas);
}

const crosses = (a: Point, b: Point, r: Rect) => {        // does the straight line a-b pass through the rectangle?
  let t0 = 0, t1 = 1;
  const dx = b.x - a.x, dz = b.z - a.z;
  for (const [p, q] of [[-dx, a.x - r.x0], [dx, r.x1 - a.x], [-dz, a.z - r.z0], [dz, r.z1 - a.z]]) {
    if (p === 0) { if (q < 0) return false; continue; }
    const t = q / p;
    if (p < 0) { if (t > t1) return false; if (t > t0) t0 = t; } else { if (t < t0) return false; if (t < t1) t1 = t; }
  }
  return true;
};
const grow = (r: Rect, m: number): Rect => ({x0: r.x0 - m, x1: r.x1 + m, z0: r.z0 - m, z1: r.z1 + m});

const MAX_ZOOM = 8;          // times the size at which the whole page fits

/** The work itself, shown inside the gallery: zoom, pan, pages, full screen. */
function WorkViewer({work, full, onFull, onClose}: {work: Work; full: boolean; onFull: () => void; onClose: () => void}) {
  const [page, setPage] = useState(1);
  const [view, setView] = useState({zoom: 1, x: 0, y: 0});
  const [ready, setReady] = useState(false);
  const frame = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const drag = useRef<{x: number; y: number} | null>(null);
  const limit = useRef(MAX_ZOOM);          // set when the picture loads, from its real size
  const src = work.image.replace(/0001\.jpg$/, `${String(page).padStart(4, "0")}.jpg`);
  const go = (n: number) => { setPage(Math.max(1, Math.min(work.pages, n))); setView({zoom: 1, x: 0, y: 0}); setReady(false); };
  const zoomBy = (factor: number, cx = 0, cy = 0) => setView((v) => {
    const zoom = Math.max(1, Math.min(limit.current, v.zoom * factor));
    const k = zoom / v.zoom;
    return zoom === 1 ? {zoom: 1, x: 0, y: 0} : {zoom, x: cx - (cx - v.x) * k, y: cy - (cy - v.y) * k};
  });

  useEffect(() => { box.current?.focus(); }, []);
  useEffect(() => {
    const el = frame.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      zoomBy(Math.exp(-e.deltaY * 0.003), e.clientX - r.left - r.width / 2, e.clientY - r.top - r.height / 2);
    };
    el.addEventListener("wheel", onWheel, {passive: false});
    return () => el.removeEventListener("wheel", onWheel);
  }, []);
  useEffect(() => {           // fetch the next page ahead of time
    if (page < work.pages) new Image().src = work.image.replace(/0001\.jpg$/, `${String(page + 1).padStart(4, "0")}.jpg`);
  }, [page, work]);

  const onKey = (e: React.KeyboardEvent) => {
    const k = e.key;
    if (k === "Escape") { if (!document.fullscreenElement) onClose(); }
    else if (k === "ArrowRight" || k === "PageDown") go(page + 1);
    else if (k === "ArrowLeft" || k === "PageUp") go(page - 1);
    else if (k === "+" || k === "=") zoomBy(1.4);
    else if (k === "-") zoomBy(1 / 1.4);
    else if (k === "0") setView({zoom: 1, x: 0, y: 0});
    else if (k === "f") onFull();
    else return;
    e.preventDefault();
    e.stopPropagation();
  };

  return (
    <div className="sic-viewer" ref={box} tabIndex={-1} role="dialog" aria-modal="true" aria-label={`Viewer: ${work.title}`} onKeyDown={onKey}>
      <header className="sic-viewer__bar">
        <div className="sic-viewer__title">
          <strong>{work.title}</strong>
          <span>{[work.creator, work.date].filter(Boolean).join(" · ")}</span>
        </div>
        <div className="sic-viewer__tools">
          {work.pages > 1 && (
            <>
              <button type="button" onClick={() => go(page - 1)} disabled={page <= 1} aria-label="Previous page">‹</button>
              <span className="sic-viewer__page">Page {page} of {work.pages}</span>
              <button type="button" onClick={() => go(page + 1)} disabled={page >= work.pages} aria-label="Next page">›</button>
            </>
          )}
          <button type="button" onClick={() => zoomBy(1 / 1.4)} disabled={view.zoom <= 1} aria-label="Zoom out">−</button>
          <button type="button" onClick={() => zoomBy(1.4)} disabled={view.zoom >= limit.current} aria-label="Zoom in">+</button>
          <button type="button" onClick={() => setView({zoom: 1, x: 0, y: 0})} disabled={view.zoom <= 1}>Whole page</button>
          <button type="button" onClick={onFull} aria-pressed={full}>{full ? "Exit full screen" : "Full screen"}</button>
          {work.href && <a href={work.href}>Item page</a>}
          <button type="button" className="sic-viewer__close" onClick={onClose}>Close</button>
        </div>
      </header>
      <div className="sic-viewer__frame" ref={frame}
        style={{cursor: view.zoom > 1 ? "grab" : "zoom-in"}}
        onDoubleClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          if (view.zoom >= limit.current * 0.98) setView({zoom: 1, x: 0, y: 0});
          else zoomBy(2, e.clientX - r.left - r.width / 2, e.clientY - r.top - r.height / 2);
        }}
        onPointerDown={(e) => { drag.current = {x: e.clientX, y: e.clientY}; e.currentTarget.setPointerCapture(e.pointerId); }}
        onPointerMove={(e) => {
          if (!drag.current || view.zoom <= 1) return;
          const dx = e.clientX - drag.current.x, dy = e.clientY - drag.current.y;
          drag.current = {x: e.clientX, y: e.clientY};
          setView((v) => ({...v, x: v.x + dx, y: v.y + dy}));
        }}
        onPointerUp={() => { drag.current = null; }}>
        <button type="button" className="sic-viewer__x" aria-label="Close and return to the room" title="Close"
          onPointerDown={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()} onClick={onClose}>
          <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M5 5l14 14M19 5L5 19" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" /></svg>
        </button>
        <img src={src} alt={work.pages > 1 ? `${work.title}, page ${page}` : work.title} draggable={false}
          onLoad={(e) => {
            // Stop at two screen pixels for each pixel of the scan: beyond that it only blurs.
            const img = e.currentTarget, box = frame.current?.getBoundingClientRect();
            if (box && img.naturalWidth) {
              const fitted = Math.min(box.width / img.naturalWidth, box.height / img.naturalHeight);
              limit.current = Math.max(1.5, Math.min(MAX_ZOOM, 2 / fitted));
            }
            setReady(true);
          }}
          style={{transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})`, opacity: ready ? 1 : 0.35}} />
      </div>
      {work.pages > 1 && (
        <input className="sic-viewer__pages" type="range" min={1} max={work.pages} value={page}
          aria-label="Page" onChange={(e) => go(Number(e.target.value))} />
      )}
    </div>
  );
}

export default function GalleryWalk({height = "78vh"}: {height?: string}) {
  const [works, setWorks] = useState<Work[] | null>(null);
  const [error, setError] = useState("");
  const [section, setSection] = useState("All");
  const [view, setView] = useState<"walk" | "list">("walk");
  const [entered, setEntered] = useState(false);
  const [full, setFull] = useState(false);
  const [selected, setSelected] = useState<Work | null>(null);
  const [viewing, setViewing] = useState<Work | null>(null);
  const [roomAt, setRoomAt] = useState(0);
  const [look, setLook] = useState(false);            // mouse look: the view follows the mouse
  const [mapOpen, setMapOpen] = useState(false);
  const mapRef = useRef<() => void>(() => {});
  mapRef.current = () => setMapOpen((open) => !open);
  const mount = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const api = useRef<{room: (i: number) => void; select: (step: number) => void; clear: () => void; hold: (key: string, down: boolean) => void; look: () => void} | null>(null);
  const enteredRef = useRef(false);
  enteredRef.current = entered;
  const viewingRef = useRef(false);
  viewingRef.current = !!viewing;

  // Load the works, then attach each one's item-page link from the site's search index.
  useEffect(() => {
    let live = true;
    const base = (window as any).CANOPY_BASE_PATH || "";
    const override = new URLSearchParams(location.search).get("imgbase"); // local testing only
    const swap = (u: string) => (override ? u.replace(site.webBase, override) : u);
    (async () => {
      try {
        const data = await (await fetch(swap(`${site.webBase}/walk/works.json`))).json();
        const hrefs: Record<string, string> = {};
        try {
          const index = await (await fetch(`${base}/api/search-records.json`)).json();
          const records = Array.isArray(index) ? index : index.records || [];
          for (const r of records) {
            const m = /\/images\/([^/]+)\/thumb\.jpg/.exec(r.thumbnail || "");
            if (m && r.href) hrefs[m[1]] = `${base}${r.href}`;
          }
        } catch { /* links simply stay off */ }
        const list: Work[] = data.works.map((w: Work) => ({...w, thumb: swap(w.thumb), image: swap(w.image), href: hrefs[w.id]}));
        if (live) setWorks(list);
      } catch {
        if (live) setError("The gallery could not be loaded.");
      }
    })();
    return () => { live = false; };
  }, []);

  useEffect(() => {
    const onChange = () => setFull(document.fullscreenElement === stageRef.current);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);
  // The visitor leaves by pressing somewhere outside the gallery (or Esc); using one of
  // the gallery's own buttons is not leaving it.
  useEffect(() => {
    const onPress = (e: PointerEvent) => {
      if (stageRef.current && !stageRef.current.contains(e.target as Node) && !document.fullscreenElement) setEntered(false);
    };
    document.addEventListener("pointerdown", onPress);
    return () => document.removeEventListener("pointerdown", onPress);
  }, []);
  // Back to the hall: keys work again after a button has been used.
  const refocus = () => { setEntered(true); requestAnimationFrame(() => { if (!viewingRef.current) mount.current?.focus(); }); };
  const toggleFull = () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else stageRef.current?.requestFullscreen?.().then(refocus).catch(() => {});
  };
  const fullRef = useRef(toggleFull);
  fullRef.current = toggleFull;
  const openRef = useRef<(w: Work) => void>(() => {});
  openRef.current = (w) => setViewing(w);
  const closeViewer = () => { setViewing(null); viewingRef.current = false; refocus(); };

  const sections = useMemo(() => ["All", ...Array.from(new Set((works || []).map((w) => w.section)))], [works]);
  const shown = useMemo(() => (works || []).filter((w) => section === "All" || w.section === section), [works, section]);
  const rooms = useMemo(() => makeRooms(shown), [shown]);
  const set = useMemo(() => stage(rooms), [rooms]);

  useEffect(() => {
    const el = mount.current;
    if (!el || view !== "walk" || !rooms.length) return;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({antialias: true, powerPreference: "high-performance"});
    } catch {
      setView("list");
      return;
    }
    const calm = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let ratio = Math.min(window.devicePixelRatio, 2);
    renderer.setPixelRatio(ratio);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    el.appendChild(renderer.domElement);
    renderer.domElement.setAttribute("aria-hidden", "true");

    const scene = new THREE.Scene();
    const backdrop = new THREE.Color("#0c0b0a");
    const sky = new THREE.Color("#31405a");             // dusk, outside the building
    scene.background = sky;
    const fog = new THREE.Fog(sky.clone(), 18, 46);
    scene.fog = fog;
    const camera = new THREE.PerspectiveCamera(62, 1, 0.1, 70);
    camera.rotation.order = "YXZ";
    scene.add(new THREE.HemisphereLight(0xfff1dc, 0x2a221c, 1.6));
    const lamp = new THREE.PointLight(0xffe2b8, 20, 22, 1.5);
    scene.add(lamp);

    const dispose: {dispose: () => void}[] = [];
    const keep = <T extends {dispose: () => void}>(x: T) => { dispose.push(x); return x; };
    const wallMats = WALLS.map((c) => keep(new THREE.MeshStandardMaterial({color: c, roughness: 0.95})));
    const dark = keep(new THREE.MeshStandardMaterial({color: "#14110f", roughness: 1}));
    const floorMat = keep(new THREE.MeshStandardMaterial({color: "#1c1714", roughness: 0.4, metalness: 0.25}));
    const brass = keep(new THREE.MeshBasicMaterial({color: "#8a6a2f"}));
    const light = keep(new THREE.MeshBasicMaterial({color: "#cdb68c"}));
    const benchMat = keep(new THREE.MeshStandardMaterial({color: "#4a3324", roughness: 0.7}));
    const stone = keep(new THREE.MeshStandardMaterial({color: "#b9ad9a", roughness: 0.9}));
    const paving = keep(new THREE.MeshStandardMaterial({color: "#57514a", roughness: 0.95}));
    const unitBox = keep(new THREE.BoxGeometry(1, 1, 1));
    const unit = keep(new THREE.PlaneGeometry(1, 1));
    const box = (m: THREE.Material, w: number, h: number, d: number, x: number, y: number, z: number, parent: THREE.Object3D) => {
      const mesh = new THREE.Mesh(unitBox, m);
      mesh.scale.set(w, h, d);
      mesh.position.set(x, y, z);
      parent.add(mesh);
      return mesh;
    };

    // ----- Rooms -----
    const {shells, places} = set;
    const last = shells.length - 1;
    const groups: THREE.Group[] = [];
    const signs: (null | (() => void))[] = [];        // per room: removes its text panels again
    shells.forEach((sh) => {
      const g = new THREE.Group();
      const court = sh.kind === "court";
      const wall = court ? stone : wallMats[sh.tone % wallMats.length];
      const mid = sh.z - sh.depth / 2;
      const back = sh.z - sh.depth;
      box(court ? paving : floorMat, court ? 60 : sh.half * 2 + 0.6, 0.1, court ? sh.depth + 30 : sh.depth, 0, -0.05, court ? mid + 15 : mid, g);
      if (!court) {
        box(dark, sh.half * 2 + 0.6, 0.1, sh.depth, 0, sh.height + 0.05, mid, g);
        box(wall, 0.3, sh.height, sh.depth, -sh.half - 0.15, sh.height / 2, mid, g);
        box(wall, 0.3, sh.height, sh.depth, sh.half + 0.15, sh.height / 2, mid, g);
      } else {                                         // the front of the building: columns, a cornice, steps, wings to either side
        for (const b of sh.blocks) box(stone, 0.8, 7.2, 0.8, (b.x0 + b.x1) / 2, 3.6, (b.z0 + b.z1) / 2, g);
        box(stone, 13.4, 0.7, 1.9, 0, 7.55, back + 1.1, g);
        box(stone, 13.4, 0.16, 2.6, 0, 0.02, back + 1.3, g);
        for (const sx of [-1, 1]) box(stone, 16, sh.height, 0.3, sx * (sh.half + 8.3), sh.height / 2, back, g);
      }
      const cross = (z: number, doorX: number | null, span: number, high: number) => {   // a cross wall, with or without a door
        if (doorX === null) { box(wall, span * 2 + 0.6, high, 0.3, 0, high / 2, z, g); return; }
        const l = doorX - DOOR_W / 2, r = doorX + DOOR_W / 2;
        box(wall, l + span + 0.3, high, 0.3, (-span - 0.3 + l) / 2, high / 2, z, g);
        box(wall, span + 0.3 - r, high, 0.3, (r + span + 0.3) / 2, high / 2, z, g);
        box(wall, DOOR_W, high - DOOR_H, 0.3, doorX, DOOR_H + (high - DOOR_H) / 2, z, g);
        box(brass, DOOR_W + 0.16, 0.06, 0.34, doorX, DOOR_H + 0.03, z, g);
      };
      if (sh.index === 0 && !court) cross(sh.z, null, sh.half, sh.height);
      const next = shells[sh.index + 1];
      cross(back, next ? sh.exit : null, next ? Math.max(sh.half, next.half) : sh.half, next ? Math.max(sh.height, next.height) : sh.height);
      if (!court) box(light, sh.kind === "divided" ? 0.5 : 1.4, 0.02, Math.max(3, sh.depth - 5), sh.kind === "divided" ? sh.half / 2 : 0, sh.height - 0.02, mid, g);
      if (sh.kind === "divided") box(light, 0.5, 0.02, Math.max(3, sh.depth - 5), -sh.half / 2, sh.height - 0.02, mid, g);
      if (!court) for (const sx of [-1, 1]) box(brass, 0.03, 0.03, sh.depth, sx * (sh.half - 0.02), 0.09, mid, g);
      if (court) {
        // nothing to sit on outside
      } else if (sh.divider) {                                // the freestanding wall, a little lower than the room
        const d = sh.divider;
        box(wall, 0.3, sh.height - 1.0, d.z1 - d.z0, 0, (sh.height - 1.0) / 2, (d.z0 + d.z1) / 2, g);
        box(brass, 0.34, 0.05, d.z1 - d.z0, 0, sh.height - 1.0, (d.z0 + d.z1) / 2, g);
      } else if (sh.kind === "salon") {                // two benches for a long room
        for (const b of sh.blocks) box(benchMat, 0.7, 0.42, 2.2, 0, 0.21, (b.z0 + b.z1) / 2, g);
      } else {
        box(benchMat, 2.4, 0.42, 0.7, 0, 0.21, mid, g);
      }
      scene.add(g);
      groups.push(g);
      signs.push(null);
    });
    const dress = (i: number) => {                     // title wall and "next" sign: made when the room comes near
      if (signs[i]) return;
      const sh = shells[i], room = rooms[i], back = sh.z - sh.depth;
      const made: {dispose: () => void}[] = [];
      const meshes: THREE.Mesh[] = [];
      const panel = (tex: THREE.Texture, w: number, h: number, x: number, y: number, z = back + 0.17, turn = 0) => {
        const mat = new THREE.MeshBasicMaterial({map: tex, transparent: true});
        const mesh = new THREE.Mesh(unit, mat);
        mesh.scale.set(w, h, 1);
        mesh.position.set(x, y, z);
        mesh.rotation.y = turn;
        groups[i].add(mesh);
        made.push(tex, mat);
        meshes.push(mesh);
      };
      if (sh.kind === "court") {                       // the name over the door
        panel(textTexture([
          {text: "SICALIPSIS", font: "500 170px Fraunces, Georgia, serif", color: "#2a2520"},
          {text: "A VIRTUAL WUNDERKAMMER", font: "600 46px Inter, Arial, sans-serif", color: "#6b4f1c"},
        ], 2048, 512), 9.6, 2.4, 0, 5.6);
      } else if (sh.kind === "hall") {                 // the map: a name under each gallery's three works
        panel(textTexture([
          {text: "WELCOME", font: "600 34px Inter, Arial, sans-serif", color: "#d9a441"},
          {text: "Sicalipsis", font: "500 96px Fraunces, Georgia, serif", color: "#f1ebe2"},
          {text: "Early twentieth-century erotica in Spain", font: "400 38px Inter, Arial, sans-serif", color: "#cfc5b6"},
          {text: "Each gallery is shown here by three of its works. Click one to go in.", font: "400 28px Inter, Arial, sans-serif", color: "#9a8f80"},
        ], 1024, 512, "left"), 5.2, 2.6, sh.titleX, 2.5);
        for (const mark of sh.marks) panel(textTexture([
          {text: mark.title, font: "500 60px Fraunces, Georgia, serif", color: "#f1ebe2"},
          {text: mark.note.toUpperCase(), font: "600 28px Inter, Arial, sans-serif", color: "#d9a441"},
        ], 1280, 200), 6.4, 1.0, mark.x, 3.35, mark.z, mark.nx > 0 ? Math.PI / 2 : -Math.PI / 2);
      } else if (sh.titleX !== sh.entry) panel(textTexture([
        {text: `${room.period}`.toUpperCase(), font: "600 34px Inter, Arial, sans-serif", color: "#d9a441"},
        {text: room.title, font: "500 84px Fraunces, Georgia, serif", color: "#f1ebe2"},
        {text: room.subtitle || `${room.works.length} works`, font: "400 40px Inter, Arial, sans-serif", color: "#cfc5b6"},
        {text: `${room.works.length} works`, font: "400 28px Inter, Arial, sans-serif", color: "#9a8f80"},
      ], 1024, 512, "left"), 3.2, 1.6, sh.titleX, 1.9);
      if (i < last && sh.kind !== "court") {
        const next = rooms[i + 1];
        panel(textTexture([{text: `Next: ${next.period !== room.period ? next.period + " · " : ""}${next.title}`, font: "500 40px Inter, Arial, sans-serif", color: "#d9a441"}], 1024, 96),
          3.2, 0.3, sh.exit, DOOR_H + 0.42);
      }
      signs[i] = () => { meshes.forEach((m) => groups[i].remove(m)); made.forEach((d) => d.dispose()); };
    };
    // A thin line on the floor marks the suggested route.
    scene.add(new THREE.Line(keep(new THREE.BufferGeometry().setFromPoints(set.route.map((p) => new THREE.Vector3(p.x, 0.012, p.z)))),
      keep(new THREE.LineBasicMaterial({color: "#6b5327", transparent: true, opacity: 0.7}))));

    // ----- Works. Pictures and labels are loaded only when the visitor is near, a few at a time. -----
    const glowMat = keep(new THREE.MeshBasicMaterial({map: keep(glowTexture()), transparent: true, depthWrite: false}));
    const blank = keep(new THREE.MeshBasicMaterial({color: "#3a322b"}));
    const frameMat = keep(new THREE.MeshStandardMaterial({color: "#15110e", roughness: 0.6}));
    const bitmaps = typeof createImageBitmap === "function";   // decode pictures off the main thread where possible
    const bitmapLoader = new THREE.ImageBitmapLoader();
    bitmapLoader.setCrossOrigin("anonymous");
    bitmapLoader.setOptions({imageOrientation: "flipY", premultiplyAlpha: "none"});
    const plainLoader = new THREE.TextureLoader();
    plainLoader.setCrossOrigin("anonymous");
    type Hung = {place: Place; art: THREE.Mesh; label: THREE.Mesh; level: number; busy: boolean};
    const hung: Hung[] = places.map((place, index) => {
      const g = new THREE.Group();
      g.position.set(place.x, place.y, place.z);
      g.rotation.y = place.facing;
      const halo = new THREE.Mesh(unit, glowMat);
      halo.scale.set(place.width * (place.small ? 1.7 : 2.5), place.height * (place.small ? 1.6 : 2.3), 1);
      halo.position.z = 0.005;
      const frame = new THREE.Mesh(unitBox, frameMat);
      frame.scale.set(place.width + 0.08, place.height + 0.08, 0.05);
      frame.position.z = 0.02;
      const art = new THREE.Mesh(unit, blank);
      art.scale.set(place.width, place.height, 1);
      art.position.z = 0.05;
      art.userData.index = index;
      const label = new THREE.Mesh(unit, blank);
      label.scale.set(place.small ? 1.15 : 1.5, place.small ? 0.184 : 0.24, 1);
      label.position.set(0, -place.height / 2 - (place.small ? 0.15 : 0.22), 0.03);
      label.visible = false;
      g.add(halo, frame, art, label);
      groups[place.room].add(g);
      return {place, art, label, level: 0, busy: false};
    });
    let loading = 0;
    const show = (h: Hung, url: string, level: number) => {
      if (h.busy || loading >= 4) return;
      h.busy = true;
      loading++;
      const done = (tex: THREE.Texture | null) => {
        h.busy = false;
        loading--;
        if (tex) {
          tex.colorSpace = THREE.SRGBColorSpace;
          tex.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
          const old = h.art.material as THREE.MeshBasicMaterial;
          h.art.material = new THREE.MeshBasicMaterial({map: tex, toneMapped: false});
          if (old !== blank) { old.map?.dispose(); old.dispose(); }
        }
        h.level = level;
      };
      if (bitmaps) bitmapLoader.load(url, (bitmap) => { const t = new THREE.Texture(bitmap as any); t.needsUpdate = true; done(t); }, undefined, () => done(null));
      else plainLoader.load(url, done, undefined, () => done(null));
      if (!h.label.visible) {
        const w = h.place.work;
        const tex = textTexture([
          {text: w.title, font: "500 40px Fraunces, Georgia, serif", color: "#f1ebe2"},
          {text: [w.creator, w.date].filter(Boolean).join(" · ") || w.section, font: "400 26px Inter, Arial, sans-serif", color: "#b8ab9a"},
        ], 800, 128);
        h.label.material = new THREE.MeshBasicMaterial({map: tex, transparent: true});
        h.label.visible = true;
      }
    };
    const drop = (h: Hung) => {
      const m = h.art.material as THREE.MeshBasicMaterial;
      if (m !== blank) { m.map?.dispose(); m.dispose(); h.art.material = blank; }
      const l = h.label.material as THREE.MeshBasicMaterial;
      if (l !== blank) { l.map?.dispose(); l.dispose(); h.label.material = blank; h.label.visible = false; }
      h.level = 0;
    };

    // ----- The visitor: position, heading, and what stops them walking through walls. -----
    const pos = {x: shells[0].entry, z: shells[0].z - 1.4};
    let yaw = 0, pitch = 0;                           // yaw 0 looks down the suite of rooms
    let speed = 0, strafe = 0, spin = 0;              // current forward, sideways and turning speeds
    let focus = -1;
    let auto: {points: Point[]; face: Place | null} | null = null;
    let push = 0;                                     // momentum from the wheel
    const keys = new Set<string>();
    const roomOf = (z: number) => {
      for (const sh of shells) if (z > sh.z - sh.depth) return sh.index;
      return last;
    };
    const turnTo = (from: number, to: number) => from + Math.atan2(Math.sin(to - from), Math.cos(to - from));
    const heading = (dx: number, dz: number) => Math.atan2(-dx, -dz);
    const gap = DOOR_W / 2 - 0.3;
    const constrain = (x: number, z: number) => {     // keep inside the rooms; cross walls only at doors
      const sh = shells[roomOf(pos.z)];
      const front = sh.z, back = sh.z - sh.depth;
      x = Math.max(-sh.half + BODY, Math.min(sh.half - BODY, x));
      if (z < back + BODY && !(sh.index < last && Math.abs(x - sh.exit) < gap)) z = back + BODY;
      if (z > front - BODY && !(sh.index > 0 && Math.abs(x - sh.entry) < gap)) z = front - BODY;
      if (Math.abs(z - back) < BODY && sh.index < last) x = Math.max(sh.exit - gap, Math.min(sh.exit + gap, x));
      if (Math.abs(z - front) < BODY && sh.index > 0) x = Math.max(sh.entry - gap, Math.min(sh.entry + gap, x));
      for (const b of sh.blocks) {                    // benches and dividing walls: slide along them
        const r = grow(b, 0.4);
        if (x > r.x0 && x < r.x1 && z > r.z0 && z < r.z1) {
          if (pos.x <= r.x0 || pos.x >= r.x1) x = pos.x <= r.x0 ? r.x0 : r.x1;
          else z = pos.z <= r.z0 ? r.z0 : r.z1;
        }
      }
      return {x, z};
    };
    const around = (a: Point, b: Point, blocks: Rect[]): Point[] => {   // step round anything in the way
      for (const block of blocks) {
        const r = grow(block, 0.55);
        if (!crosses(a, b, r)) continue;
        const o = grow(block, 0.8);
        const corners = [{x: o.x0, z: o.z0}, {x: o.x1, z: o.z0}, {x: o.x1, z: o.z1}, {x: o.x0, z: o.z1}];
        const len = (path: Point[]) => path.reduce((sum, p, i) => sum + (i ? Math.hypot(p.x - path[i - 1].x, p.z - path[i - 1].z) : 0), 0);
        let best: Point[] | null = null;
        for (let i = 0; i < 4; i++) {
          const one = [a, corners[i], b];
          if (!crosses(a, corners[i], r) && !crosses(corners[i], b, r) && (!best || len(one) < len(best))) best = one;
        }
        if (!best) for (let i = 0; i < 4; i++) for (const j of [(i + 1) % 4, (i + 3) % 4]) {
          const two = [a, corners[i], corners[j], b];
          if (!crosses(a, corners[i], r) && !crosses(corners[j], b, r) && (!best || len(two) < len(best))) best = two;
        }
        if (best) return best.slice(1, -1);
      }
      return [];
    };
    const walkTo = (x: number, z: number, face: Place | null) => {   // through the doors, room by room
      const legs: Point[] = [{x: pos.x, z: pos.z}];
      const from = roomOf(pos.z), to = roomOf(z);
      for (let k = from; k < to; k++) { const b = shells[k].z - shells[k].depth; legs.push({x: shells[k].exit, z: b + 0.9}, {x: shells[k].exit, z: b - 0.9}); }
      for (let k = from; k > to; k--) { const f = shells[k].z; legs.push({x: shells[k].entry, z: f - 0.9}, {x: shells[k].entry, z: f + 0.9}); }
      legs.push({x, z});
      const points: Point[] = [];
      for (let i = 1; i < legs.length; i++) {
        const room = shells[roomOf((legs[i - 1].z + legs[i].z) / 2)];
        points.push(...around(legs[i - 1], legs[i], room.blocks), legs[i]);
      }
      auto = {points, face};
      push = 0;
    };
    const jump = (i: number) => {                     // straight to a room's entrance, facing its title wall
      const sh = shells[Math.max(0, Math.min(last, i))];
      pick(-1);
      auto = null;
      pos.x = sh.entry;
      pos.z = sh.z - 1.6;
      yaw = 0;
      pitch = 0;
      speed = strafe = push = 0;
    };
    const pick = (i: number) => {
      if (i >= 0 && hung[i].place.to != null) { jump(hung[i].place.to!); return; }   // in the hall: go into that gallery
      focus = i;
      setSelected(i >= 0 ? hung[i].place.work : null);
      if (i < 0) return;
      const p = hung[i].place;
      const sh = shells[p.room];
      const reach = p.small ? 2.3 : STAND;
      const room = p.nx !== 0 && sh.divider ? sh.half / 2 : reach;           // in a divided room, stand in the aisle
      const x = Math.max(-sh.half + BODY, Math.min(sh.half - BODY, p.x + p.nx * Math.min(reach, room + 0.4)));
      const z = Math.max(sh.z - sh.depth + BODY, Math.min(sh.z - BODY, p.z + p.nz * reach));
      if (Math.abs(roomOf(pos.z) - p.room) > 1) { pos.x = sh.entry; pos.z = sh.z - 1.2; }   // far away: start from that room's door
      walkTo(x, z, p);
    };
    api.current = {
      room: jump,
      select: (step) => {
        let i = focus + step;
        if (focus < 0) {                              // start from the work nearest the visitor
          let best = Infinity;
          hung.forEach((h, k) => { const d = Math.hypot(h.place.x - pos.x, h.place.z - pos.z) + (h.place.room === roomOf(pos.z) ? 0 : 50); if (d < best) { best = d; i = k; } });
        }
        pick(Math.max(0, Math.min(hung.length - 1, i)));
      },
      clear: () => pick(-1),
      hold: (key, down) => { if (down) { keys.add(key); auto = null; } else keys.delete(key); },
      look: () => { if (document.pointerLockElement === el) document.exitPointerLock(); else el.requestPointerLock?.(); },
    };

    // ----- Input -----
    const MOVE = new Set(["w", "a", "s", "d", "arrowup", "arrowdown", "arrowleft", "arrowright", "q", "e"]);
    const onWheel = (e: WheelEvent) => {
      if (!enteredRef.current || viewingRef.current) return;
      e.preventDefault();
      auto = null;
      push = Math.max(-12, Math.min(12, push - e.deltaY * 0.02));
    };
    let drag: {x: number; y: number} | null = null;
    let moved = 0;
    let locked = false;                               // mouse look: the pointer is held and moving the mouse turns the view
    const onLock = () => { locked = document.pointerLockElement === el; setLook(locked); if (locked) { drag = null; setEntered(true); } };
    const onMouse = (e: MouseEvent) => {
      if (!locked || viewingRef.current) return;
      if (auto && auto.face) auto.face = null;
      yaw -= e.movementX * 0.0023;
      pitch = Math.max(-0.7, Math.min(0.7, pitch - e.movementY * 0.0023));
    };
    const onDown = (e: PointerEvent) => {
      moved = 0;
      if (locked) { drag = null; return; }
      drag = {x: e.clientX, y: e.clientY};
      el.setPointerCapture(e.pointerId);
    };
    const onMove = (e: PointerEvent) => {
      if (!drag || !enteredRef.current) return;
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      moved += Math.abs(dx) + Math.abs(dy);
      drag = {x: e.clientX, y: e.clientY};
      if (moved > 6) {                                // dragging looks around
        if (auto && auto.face) auto.face = null;
        yaw += dx * 0.0045;
        pitch = Math.max(-0.7, Math.min(0.7, pitch + dy * 0.0032));
      }
    };
    const ray = new THREE.Raycaster();
    const ground = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    const onUp = (e: PointerEvent) => {
      const wasDrag = moved > 6;
      drag = null;
      if (wasDrag || !enteredRef.current) return;
      const r = el.getBoundingClientRect();
      // With mouse look on, a click acts on whatever is at the centre of the view.
      ray.setFromCamera(locked ? new THREE.Vector2(0, 0)
        : new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), camera);
      const hit = ray.intersectObjects(hung.filter((h) => groups[h.place.room].visible).map((h) => h.art))[0];
      if (hit) {                                      // first click walks up to the work, a second opens it
        const i = hit.object.userData.index;
        if (i === focus && !auto) openRef.current(hung[i].place.work);
        else pick(i);
        return;
      }
      const spot = new THREE.Vector3();               // a click on the floor walks there
      if (ray.ray.intersectPlane(ground, spot) && spot.distanceTo(camera.position) < 40) {
        const room = shells[roomOf(spot.z)];
        if (Math.abs(room.index - roomOf(pos.z)) <= 1) {
          pick(-1);
          walkTo(Math.max(-room.half + BODY, Math.min(room.half - BODY, spot.x)),
            Math.max(room.z - room.depth + BODY, Math.min(room.z - BODY, spot.z)), null);
        }
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (!enteredRef.current || viewingRef.current) return;
      const k = e.key.toLowerCase();
      if (MOVE.has(k)) { keys.add(k); auto = null; if (focus >= 0 && (k === "w" || k === "s" || k === "arrowup" || k === "arrowdown")) pick(-1); }
      else if (k === "shift") keys.add(k);
      else if (k === "pagedown" || k === "]") jump(roomOf(pos.z) + 1);
      else if (k === "pageup" || k === "[") jump(roomOf(pos.z) - 1);
      else if (k === "n") api.current!.select(1);
      else if (k === "p") api.current!.select(-1);
      else if (k === "enter" && focus >= 0) openRef.current(hung[focus].place.work);
      else if (k === "home") jump(0);
      else if (k === "end") jump(last);
      else if (k === "f") fullRef.current();
      else if (k === "m") mapRef.current();
      else if (k === "l") api.current!.look();
      else if (k === "escape") { if (focus >= 0) pick(-1); else if (!document.fullscreenElement) setEntered(false); }
      else return;
      e.preventDefault();
    };
    const onKeyUp = (e: KeyboardEvent) => keys.delete(e.key.toLowerCase());
    const onBlur = () => keys.clear();
    el.addEventListener("wheel", onWheel, {passive: false});
    el.addEventListener("pointerdown", onDown);
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("keydown", onKey);
    el.addEventListener("keyup", onKeyUp);
    el.addEventListener("blur", onBlur);
    el.addEventListener("mousemove", onMouse);
    document.addEventListener("pointerlockchange", onLock);

    const resize = () => {
      const w = el.clientWidth, h = el.clientHeight;
      renderer.setSize(w, h, false);
      camera.aspect = w / Math.max(1, h);
      camera.updateProjectionMatrix();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(el);
    resize();

    let frame = 0, raf = 0, lastRoom = -1, then = performance.now(), slow = 0, fast = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const now = performance.now();
      const real = (now - then) / 1000;
      const dt = Math.min(0.05, real);
      then = now;
      // Keep it smooth: lower the drawing resolution when frames run long, raise it again when there is room.
      if (real > 0.026) slow++; else if (real < 0.014) fast++;
      if (frame % 90 === 89) {
        const top = Math.min(window.devicePixelRatio, 2);
        if (slow > 30 && ratio > 1) { ratio = Math.max(1, ratio - 0.25); renderer.setPixelRatio(ratio); resize(); }   // never below the screen's own pixels
        else if (fast > 80 && ratio < top) { ratio = Math.min(top, ratio + 0.25); renderer.setPixelRatio(ratio); resize(); }
        slow = fast = 0;
      }

      if (auto) {                                     // walking somewhere on the visitor's behalf
        const goal = auto.points[0];
        const dx = goal.x - pos.x, dz = goal.z - pos.z;
        const dist = Math.hypot(dx, dz);
        const final = auto.points.length === 1;
        const pace = final ? Math.min(7.5, 1.2 + dist * 4.5) : 7.5;          // quick, easing in to the last stop
        const step = calm ? dist : Math.min(dist, pace * dt);
        if (dist > 0.02) {
          pos.x += (dx / dist) * step;
          pos.z += (dz / dist) * step;
          if (!auto.face || !final || dist > 1.8) { const t = turnTo(yaw, heading(dx, dz)); yaw += (t - yaw) * (calm ? 1 : Math.min(1, dt * 7)); }
        }
        if (dist <= 0.05 || step >= dist) {
          auto.points.shift();
          if (!auto.points.length) { if (!auto.face) auto = null; else auto.points.push({x: pos.x, z: pos.z}); }
        }
        if (auto && auto.face && auto.points.length === 1) {   // near the end: turn to the work
          const f = auto.face;
          const t = turnTo(yaw, heading(f.x - pos.x, f.z - pos.z));
          const tilt = Math.atan2(f.y - EYE, Math.hypot(f.x - pos.x, f.z - pos.z));
          yaw += (t - yaw) * (calm ? 1 : Math.min(1, dt * 9));
          pitch += (tilt - pitch) * (calm ? 1 : Math.min(1, dt * 9));
          if (Math.hypot(goal.x - pos.x, goal.z - pos.z) < 0.06 && Math.abs(t - yaw) < 0.01) auto = null;
        }
        speed = strafe = 0;
      } else {                                        // walking under the visitor's own control
        const run = keys.has("shift") ? 1.8 : 1;
        const fwd = (keys.has("w") || keys.has("arrowup") ? 1 : 0) - (keys.has("s") || keys.has("arrowdown") ? 1 : 0);
        const side = (keys.has("d") ? 1 : 0) - (keys.has("a") ? 1 : 0);
        const turn = (keys.has("arrowleft") || keys.has("q") ? 1 : 0) - (keys.has("arrowright") || keys.has("e") ? 1 : 0);
        const k = calm ? 1 : Math.min(1, dt * 12);     // quick to start and stop, without a jolt
        speed += (fwd * WALK * run - speed) * k;
        strafe += (side * WALK * 0.85 - strafe) * k;
        spin += (turn * 2.3 - spin) * (calm ? 1 : Math.min(1, dt * 14));
        yaw += spin * dt;
        const go = (speed + push) * dt;
        push *= Math.pow(0.006, dt);                   // the wheel's momentum dies away
        if (Math.abs(push) < 0.05) push = 0;
        if (Math.abs(go) > 1e-4 || Math.abs(strafe) > 1e-3) {
          const next = constrain(pos.x - Math.sin(yaw) * go + Math.cos(yaw) * strafe * dt, pos.z - Math.cos(yaw) * go - Math.sin(yaw) * strafe * dt);
          pos.x = next.x;
          pos.z = next.z;
          if (!turn && !drag && !locked) pitch += (0 - pitch) * Math.min(1, dt * 1.5);
        }
      }
      camera.position.set(pos.x, EYE, pos.z);
      camera.rotation.set(pitch, yaw, 0);
      lamp.position.set(pos.x, 3.4, pos.z);

      if (frame++ % 10 === 0) {
        const here = roomOf(pos.z);
        let sharp = 0;
        const byDistance = hung.map((h) => ({h, d: Math.hypot(h.place.x - pos.x, h.place.z - pos.z)})).filter((x) => x.d < FAR_DROP + 5 || x.h.level > 0);
        byDistance.sort((a, b) => a.d - b.d);
        for (const {h, d} of byDistance) {
          if (d < NEAR_SHARP && h.level < 2 && sharp++ < 2) show(h, h.place.work.image, 2);
          else if (d < NEAR_LOAD && h.level < 1 && Math.abs(h.place.room - here) <= 1) show(h, h.place.work.thumb, 1);
          else if (d > FAR_DROP && h.level > 0) drop(h);
        }
        groups.forEach((g, i) => {
          g.visible = Math.abs(i - here) <= 1;
          if (g.visible) dress(i);
          else if (signs[i] && Math.abs(i - here) > 3) { signs[i]!(); signs[i] = null; }
        });
        if (here !== lastRoom) {
          lastRoom = here;
          setRoomAt(here);
          const outside = shells[here].kind === "court";     // sky outside, darkness between the rooms inside
          scene.background = outside ? sky : backdrop;
          fog.color.copy(outside ? sky : backdrop);
        }
        if (focus >= 0 && !auto && Math.hypot(hung[focus].place.x - pos.x, hung[focus].place.z - pos.z) > 6.5) pick(-1);
      }
      renderer.render(scene, camera);
    };
    tick();

    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("keydown", onKey);
      el.removeEventListener("keyup", onKeyUp);
      el.removeEventListener("blur", onBlur);
      el.removeEventListener("mousemove", onMouse);
      document.removeEventListener("pointerlockchange", onLock);
      if (document.pointerLockElement === el) document.exitPointerLock();
      hung.forEach(drop);
      signs.forEach((undo) => undo && undo());
      dispose.forEach((d) => d.dispose());
      renderer.dispose();
      renderer.domElement.remove();
      api.current = null;
    };
  }, [set, rooms, view]);

  if (error) return <p className="sic-walk__status">{error}</p>;
  if (!works) return <p className="sic-walk__status">Opening the gallery…</p>;

  const room = rooms[Math.min(roomAt, rooms.length - 1)];
  const periods = Array.from(new Set(rooms.map((r) => r.period)));
  const portals = rooms.find((r) => r.kind === "hall")?.portals || [];
  const goTo = (i: number) => { api.current?.room(i); setMapOpen(false); refocus(); };
  const pad = (key: string, label: string, glyph: string) => (
    <button type="button" aria-label={label}
      onPointerDown={(e) => { e.preventDefault(); setEntered(true); api.current?.hold(key, true); }}
      onPointerUp={() => { api.current?.hold(key, false); refocus(); }} onPointerLeave={() => api.current?.hold(key, false)}>{glyph}</button>
  );

  return (
    <section className="sic-walk" aria-label="Walk-through gallery">
      <div className="sic-walk__bar">
        <label>
          <span>Collection</span>
          <select value={section} onChange={(e) => { setSection(e.target.value); setSelected(null); setViewing(null); setRoomAt(0); }}>
            {sections.map((s) => <option key={s}>{s}</option>)}
          </select>
        </label>
        <label>
          <span>Room</span>
          <select value={roomAt} disabled={view !== "walk"} onChange={(e) => { api.current?.room(Number(e.target.value)); refocus(); }}>
            {periods.map((period) => (
              <optgroup key={period} label={period}>
                {rooms.map((r, i) => (r.period === period ? (
                  <option key={i} value={i}>{r.title}{r.subtitle ? ` · ${r.subtitle}` : ""}</option>
                ) : null))}
              </optgroup>
            ))}
          </select>
        </label>
        <span className="sic-walk__count">{shown.length} works in {portals.length} galleries, {rooms.filter((r) => !r.kind).length} rooms</span>
        <div className="sic-walk__views" role="group" aria-label="View">
          <button type="button" aria-pressed={view === "walk"} onClick={() => setView("walk")}>Walk</button>
          <button type="button" aria-pressed={view === "list"} onClick={() => setView("list")}>List</button>
        </div>
      </div>

      {view === "walk" ? (
        <div className="sic-walk__stage" ref={stageRef} style={{height: full ? "100vh" : height}}>
          <div className="sic-walk__canvas" ref={mount} tabIndex={0}
            aria-label="Gallery rooms. W A S D or the arrow keys walk and turn; drag to look around, or press L for mouse look; N and P go to the next and previous work; Enter opens the selected work; Page Up and Page Down change room; M opens the map; F for full screen; Escape to leave." />
          {look && <span className="sic-walk__aim" aria-hidden="true" />}
          {room && (
            <div className="sic-walk__where" aria-live="polite">
              <span>{room.period}</span>
              <strong>{room.title}</strong>
              <em>{room.subtitle}</em>
            </div>
          )}
          <div className="sic-walk__tools">
            <button type="button" className="sic-walk__full" onClick={() => setMapOpen(true)}>Map</button>
            <button type="button" className="sic-walk__full" aria-pressed={look}
              onClick={() => { setEntered(true); api.current?.look(); }}>{look ? "Mouse look on (Esc)" : "Mouse look"}</button>
            <button type="button" className="sic-walk__full" onClick={toggleFull} aria-pressed={full}>
              {full ? "Exit full screen" : "Full screen"}
            </button>
          </div>
          {!entered && !viewing && (
            <button type="button" className="sic-walk__enter" onClick={refocus}>
              <strong>Enter the building</strong>
              <span>Drag to look around, or switch on mouse look. Walk with W A S D or the arrow keys, or click the floor to go there. In the entrance hall, click a picture to go into its gallery; the map takes you anywhere. Click a work for its label, and again to see it up close.</span>
            </button>
          )}
          {selected && !viewing && (
            <aside className="sic-walk__panel">
              <p className="sic-eyebrow">{selected.section}</p>
              <h3>{selected.title}</h3>
              <p>{[selected.creator, selected.date].filter(Boolean).join(" · ")}</p>
              {selected.pages > 1 && <p className="sic-walk__pages">{selected.pages} pages</p>}
              <div className="sic-walk__actions">
                <button type="button" className="sic-walk__open" onClick={() => setViewing(selected)}>Open</button>
                <button type="button" onClick={() => { api.current?.clear(); refocus(); }}>Close</button>
              </div>
            </aside>
          )}
          <div className="sic-walk__scrub">
            <button type="button" onClick={() => { api.current?.room(roomAt - 1); refocus(); }} disabled={roomAt === 0}>← Room</button>
            <button type="button" onClick={() => { api.current?.select(-1); refocus(); }}>‹ Previous work</button>
            <div className="sic-walk__pad" aria-label="Walk">
              {pad("arrowleft", "Turn left", "↺")}
              {pad("w", "Walk forward", "▲")}
              {pad("s", "Walk back", "▼")}
              {pad("arrowright", "Turn right", "↻")}
            </div>
            <button type="button" onClick={() => { api.current?.select(1); refocus(); }}>Next work ›</button>
            <button type="button" onClick={() => { api.current?.room(roomAt + 1); refocus(); }} disabled={roomAt >= rooms.length - 1}>Room →</button>
          </div>
          {mapOpen && (
            <div className="sic-map" role="dialog" aria-modal="true" aria-label="Map of the building">
              <header>
                <h3>Map of the building</h3>
                <button type="button" onClick={() => { setMapOpen(false); refocus(); }}>Close</button>
              </header>
              <button type="button" className="sic-map__hall" onClick={() => goTo(1)}>Entrance hall</button>
              <div className="sic-map__plan">
                {portals.map((portal) => (
                  <section key={portal.title} className="sic-map__gallery">
                    <button type="button" className="sic-map__enter" onClick={() => goTo(portal.to)}>
                      <span className="sic-map__thumbs">{portal.works.map((w) => <img key={w.id} src={w.thumb} alt="" />)}</span>
                      <strong>{portal.title}</strong>
                      <em>{portal.count} works · {portal.rooms} {portal.rooms === 1 ? "room" : "rooms"}</em>
                    </button>
                    {portal.rooms > 1 && (
                      <ol>
                        {rooms.map((r, i) => (i >= portal.to && i < portal.to + portal.rooms ? (
                          <li key={i}><button type="button" aria-current={i === roomAt} onClick={() => goTo(i)}>{r.title}{/^part /.test(r.subtitle) ? ` (${r.subtitle})` : ""}</button></li>
                        ) : null))}
                      </ol>
                    )}
                  </section>
                ))}
              </div>
            </div>
          )}
          {viewing && <WorkViewer key={viewing.id} work={viewing} full={full} onFull={toggleFull} onClose={closeViewer} />}
        </div>
      ) : (
        <div className="sic-walk__list">
          {rooms.map((r, i) => (r.kind ? null : (
            <section key={i}>
              <h3><small>{r.period}</small>{r.title}{r.subtitle ? ` · ${r.subtitle}` : ""}</h3>
              <ul>
                {r.works.map((w) => (
                  <li key={w.id}>
                    <a href={w.href || w.image}>
                      <img src={w.thumb} alt="" loading="lazy" width={w.w} height={w.h} />
                      <span>{w.title}</span>
                      <small>{[w.creator, w.date].filter(Boolean).join(" · ")}</small>
                    </a>
                  </li>
                ))}
              </ul>
            </section>
          )))}
        </div>
      )}
    </section>
  );
}
