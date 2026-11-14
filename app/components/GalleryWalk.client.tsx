import React, {useEffect, useMemo, useRef, useState} from "react";
import * as THREE from "three";
import site from "../data/site.json";
import plan from "../data/gallery_periods.json";

/**
 * Walk-through gallery: the published works staged as an exhibition that the
 * visitor is free to roam.
 *
 * The works are arranged by period (app/data/gallery_periods.json) and, within a
 * period, by collection and series. Each group is a room.
 *
 * Moving: drag to look around; W A S D or the arrow keys to walk and turn; the
 * wheel walks forward and back; a click on the floor walks there; a click on a
 * work walks up to it and shows its label. "Open" shows the work in a viewer
 * inside the gallery (zoom, pages, full screen). Buttons step through the works
 * in the suggested order, which a line on the floor also marks.
 *
 * Staging choices, from exhibition research and comparable web galleries:
 *  - a suite of rooms with doors on alternating sides, so the exit is never in
 *    view from the entrance (exits compete with exhibits for attention: Melton,
 *    Bitgood) and the visit turns instead of running straight;
 *  - a title wall and one key work face each entrance, in the first sightline;
 *  - a suggested route, but free choice of where to go (free-choice visiting);
 *  - a bench marks the middle of every room; labels sit in the same place under
 *    every work; text is short (Serrell; Smithsonian accessibility guidelines);
 *  - keys and the wheel are captured only after the visitor steps in;
 *  - every work is also in a plain list by room, the view for screen readers,
 *    keyboards and browsers without WebGL; "reduce motion" removes easing.
 *
 * The works come from web/walk/works.json in the file bucket (tools/make_walk.py).
 */

type Work = {
  id: string; title: string; creator: string; date: string; year: string; estimated?: boolean;
  section: string; series: string; thumb: string; image: string; w: number; h: number; pages: number;
  href?: string;
};
type Room = {period: string; title: string; subtitle: string; works: Work[]};
type Place = {work: Work; room: number; x: number; z: number; facing: number; nx: number; nz: number; width: number; height: number};
type Shell = {z: number; depth: number; entry: number; index: number};
type Point = {x: number; z: number};

const HALF = 6.5;             // half a room's width, metres
const HEIGHT = 4.6;
const EYE = 1.62;
const HANG = 1.58;            // height of each work's centre
const STEP = 2.7;             // between works on one wall
const MAX_W = 2.0;
const MAX_H = 1.6;
const DOOR_X = 4;             // doors sit this far left or right of the centre line
const DOOR_W = 2.4;
const DOOR_H = 2.9;
const STAND = 3.0;            // viewing distance from a wall
const BODY = 0.5;             // how close the visitor can get to a wall
const WALK = 3.4;             // metres per second
const NEAR_LOAD = 30;
const NEAR_SHARP = 6.5;
const FAR_DROP = 44;

function makeRooms(works: Work[]): Room[] {
  const rooms: Room[] = [];
  const size = plan.roomSize;
  for (const period of plan.periods as any[]) {
    const inPeriod = works.filter((w) => (period.undated ? !w.year : w.year && +w.year >= period.from && +w.year <= period.to));
    const sections = [...plan.sections, ...Array.from(new Set(inPeriod.map((w) => w.section))).filter((s) => !plan.sections.includes(s))];
    for (const section of sections) {
      const group = inPeriod.filter((w) => w.section === section);
      let batch: Work[] = [];
      const flush = () => {
        if (!batch.length) return;
        const series = Array.from(new Set(batch.map((w) => w.series).filter(Boolean)));
        const years = batch.map((w) => w.year).filter(Boolean).sort();
        const span = years.length ? (years[0] === years[years.length - 1] ? years[0] : `${years[0]} to ${years[years.length - 1]}`) : "";
        const single = series.length === 1 && series[0].toLowerCase() !== section.toLowerCase();
        rooms.push({period: period.title, title: section, subtitle: [single ? series[0] : "", span].filter(Boolean).join(" · "), works: batch});
        batch = [];
      };
      group.forEach((w, i) => {
        const next = group[i + 1];
        batch.push(w);
        // Close the room when it is full, or at a change of series once it is half full.
        if (batch.length >= size || (next && next.series !== w.series && batch.length >= size / 2)) flush();
      });
      flush();
    }
  }
  return rooms;
}

function stage(rooms: Room[]) {
  const places: Place[] = [];
  const route: Point[] = [];
  const shells: Shell[] = [];
  let z = 0;
  const fit = (w: Work) => {
    const aspect = w.w / Math.max(1, w.h);
    let height = MAX_H, width = height * aspect;
    if (width > MAX_W) { width = MAX_W; height = width / aspect; }
    return {width, height};
  };
  rooms.forEach((room, index) => {
    const entry = index % 2 === 0 ? DOOR_X : -DOOR_X;   // entrance side alternates
    const s = Math.sign(entry);
    const rest = room.works.slice(1);
    const near = rest.slice(0, Math.ceil(rest.length / 2));
    const far = rest.slice(near.length);
    const depth = Math.max(9, 2.4 + STEP * Math.max(near.length, 1));
    const back = z - depth;
    route.push({x: entry, z: z + 0.2}, {x: s * (HALF - STAND), z: z - 1.2});
    near.forEach((work, i) => {                          // the wall beside the entrance, front to back
      const wz = z - 1.9 - i * STEP;
      places.push({work, room: index, x: s * (HALF - 0.07), z: wz, facing: -s * Math.PI / 2, nx: -s, nz: 0, ...fit(work)});
      route.push({x: s * (HALF - STAND), z: wz});
    });
    const hero = room.works[0];                          // the key work, on the title wall facing the entrance
    places.push({work: hero, room: index, x: entry, z: back + 0.22, facing: 0, nx: 0, nz: 1, ...fit(hero)});   // clear of the wall's thickness
    route.push({x: entry, z: back + STAND + 0.4}, {x: 0, z: z - depth / 2 - 1.6});
    far.forEach((work, i) => {                           // the far wall, front to back, ending at the exit
      const wz = z - 1.9 - i * STEP;
      places.push({work, room: index, x: -s * (HALF - 0.07), z: wz, facing: s * Math.PI / 2, nx: s, nz: 0, ...fit(work)});
      route.push({x: -s * (HALF - STAND), z: wz});
    });
    route.push({x: -entry, z: back + 1.4});
    shells.push({z, depth, entry, index});
    z = back;
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

/** The work itself, shown inside the gallery: zoom, pan, pages, full screen. */
function WorkViewer({work, full, onFull, onClose}: {work: Work; full: boolean; onFull: () => void; onClose: () => void}) {
  const [page, setPage] = useState(1);
  const [view, setView] = useState({zoom: 1, x: 0, y: 0});
  const [ready, setReady] = useState(false);
  const frame = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const drag = useRef<{x: number; y: number} | null>(null);
  const src = work.image.replace(/0001\.jpg$/, `${String(page).padStart(4, "0")}.jpg`);
  const go = (n: number) => { setPage(Math.max(1, Math.min(work.pages, n))); setView({zoom: 1, x: 0, y: 0}); setReady(false); };
  const zoomBy = (factor: number, cx = 0, cy = 0) => setView((v) => {
    const zoom = Math.max(1, Math.min(8, v.zoom * factor));
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
      zoomBy(Math.exp(-e.deltaY * 0.0015), e.clientX - r.left - r.width / 2, e.clientY - r.top - r.height / 2);
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
          <button type="button" onClick={() => zoomBy(1.4)} aria-label="Zoom in">+</button>
          <button type="button" onClick={onFull} aria-pressed={full}>{full ? "Exit full screen" : "Full screen"}</button>
          {work.href && <a href={work.href}>Item page</a>}
          <button type="button" className="sic-viewer__close" onClick={onClose}>Close</button>
        </div>
      </header>
      <div className="sic-viewer__frame" ref={frame}
        style={{cursor: view.zoom > 1 ? "grab" : "zoom-in"}}
        onDoubleClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          if (view.zoom > 1) setView({zoom: 1, x: 0, y: 0});
          else zoomBy(2.5, e.clientX - r.left - r.width / 2, e.clientY - r.top - r.height / 2);
        }}
        onPointerDown={(e) => { drag.current = {x: e.clientX, y: e.clientY}; e.currentTarget.setPointerCapture(e.pointerId); }}
        onPointerMove={(e) => {
          if (!drag.current || view.zoom <= 1) return;
          const dx = e.clientX - drag.current.x, dy = e.clientY - drag.current.y;
          drag.current = {x: e.clientX, y: e.clientY};
          setView((v) => ({...v, x: v.x + dx, y: v.y + dy}));
        }}
        onPointerUp={() => { drag.current = null; }}>
        <img src={src} alt={work.pages > 1 ? `${work.title}, page ${page}` : work.title} draggable={false}
          onLoad={() => setReady(true)}
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
  const mount = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const api = useRef<{room: (i: number) => void; select: (step: number) => void; clear: () => void; hold: (key: string, down: boolean) => void} | null>(null);
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
  const toggleFull = () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else stageRef.current?.requestFullscreen?.().then(() => { setEntered(true); if (!viewingRef.current) mount.current?.focus(); }).catch(() => {});
  };
  const fullRef = useRef(toggleFull);
  fullRef.current = toggleFull;
  const openRef = useRef<(w: Work) => void>(() => {});
  openRef.current = (w) => setViewing(w);
  const closeViewer = () => { setViewing(null); setEntered(true); setTimeout(() => mount.current?.focus(), 0); };

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
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    el.appendChild(renderer.domElement);
    renderer.domElement.setAttribute("aria-hidden", "true");

    const scene = new THREE.Scene();
    const backdrop = new THREE.Color("#0c0b0a");
    scene.background = backdrop;
    scene.fog = new THREE.Fog(backdrop, 16, 44);
    const camera = new THREE.PerspectiveCamera(62, 1, 0.1, 70);
    camera.rotation.order = "YXZ";
    scene.add(new THREE.HemisphereLight(0xfff1dc, 0x2a221c, 1.55));
    const lamp = new THREE.PointLight(0xffe2b8, 18, 20, 1.5);
    scene.add(lamp);

    const dispose: {dispose: () => void}[] = [];
    const keep = <T extends {dispose: () => void}>(x: T) => { dispose.push(x); return x; };
    const wall = keep(new THREE.MeshStandardMaterial({color: "#3b332d", roughness: 0.95}));
    const dark = keep(new THREE.MeshStandardMaterial({color: "#14110f", roughness: 1}));
    const floorMat = keep(new THREE.MeshStandardMaterial({color: "#1c1714", roughness: 0.4, metalness: 0.25}));
    const brass = keep(new THREE.MeshBasicMaterial({color: "#8a6a2f"}));
    const light = keep(new THREE.MeshBasicMaterial({color: "#cdb68c"}));
    const benchMat = keep(new THREE.MeshStandardMaterial({color: "#4a3324", roughness: 0.7}));
    const unitBox = keep(new THREE.BoxGeometry(1, 1, 1));
    const unit = keep(new THREE.PlaneGeometry(1, 1));
    const box = (m: THREE.Material, w: number, h: number, d: number, x: number, y: number, z: number, parent: THREE.Object3D) => {
      const mesh = new THREE.Mesh(unitBox, m);
      mesh.scale.set(w, h, d);
      mesh.position.set(x, y, z);
      parent.add(mesh);
      return mesh;
    };

    // Rooms: floor, ceiling, side walls, a back wall with the exit, a title wall, a bench.
    const {shells, places} = set;
    const last = shells.length - 1;
    const total = Math.abs(set.end) + 6;
    box(floorMat, HALF * 2 + 0.6, 0.1, total + 8, 0, -0.05, -total / 2 + 4, scene);
    box(dark, HALF * 2 + 0.6, 0.1, total + 8, 0, HEIGHT + 0.05, -total / 2 + 4, scene);
    const groups: THREE.Group[] = [];
    const doorway = (z: number, doorX: number, parent: THREE.Object3D) => {   // a cross wall with one opening
      const leftEdge = doorX - DOOR_W / 2, rightEdge = doorX + DOOR_W / 2;
      box(wall, leftEdge + HALF, HEIGHT, 0.3, (-HALF + leftEdge) / 2, HEIGHT / 2, z, parent);
      box(wall, HALF - rightEdge, HEIGHT, 0.3, (rightEdge + HALF) / 2, HEIGHT / 2, z, parent);
      box(wall, DOOR_W, HEIGHT - DOOR_H, 0.3, doorX, DOOR_H + (HEIGHT - DOOR_H) / 2, z, parent);
      box(brass, DOOR_W + 0.16, 0.06, 0.34, doorX, DOOR_H + 0.03, z, parent);
    };
    shells.forEach((shell) => {
      const g = new THREE.Group();
      const room = rooms[shell.index];
      const mid = shell.z - shell.depth / 2;
      const back = shell.z - shell.depth;
      box(wall, 0.3, HEIGHT, shell.depth, -HALF - 0.15, HEIGHT / 2, mid, g);
      box(wall, 0.3, HEIGHT, shell.depth, HALF + 0.15, HEIGHT / 2, mid, g);
      if (shell.index === 0) box(wall, HALF * 2, HEIGHT, 0.3, 0, HEIGHT / 2, shell.z, g);
      if (shell.index < last) doorway(back, -shell.entry, g);
      else box(wall, HALF * 2, HEIGHT, 0.3, 0, HEIGHT / 2, back, g);
      box(light, 1.4, 0.02, Math.max(3, shell.depth - 5), 0, HEIGHT - 0.02, mid, g);        // ceiling light
      box(benchMat, 2.4, 0.42, 0.7, 0, 0.21, mid, g);                                        // bench
      for (const sx of [-1, 1]) box(brass, 0.03, 0.03, shell.depth, sx * (HALF - 0.02), 0.09, mid, g);
      const s = Math.sign(shell.entry);                                                      // title wall, beside the key work
      const title = keep(textTexture([
        {text: `${room.period}`.toUpperCase(), font: "600 34px Inter, Arial, sans-serif", color: "#d9a441"},
        {text: room.title, font: "500 84px Fraunces, Georgia, serif", color: "#f1ebe2"},
        {text: room.subtitle || `${room.works.length} works`, font: "400 40px Inter, Arial, sans-serif", color: "#cfc5b6"},
        {text: `Room ${shell.index + 1} of ${rooms.length} · ${room.works.length} works`, font: "400 28px Inter, Arial, sans-serif", color: "#9a8f80"},
      ], 1024, 512, "left"));
      const panel = new THREE.Mesh(unit, keep(new THREE.MeshBasicMaterial({map: title, transparent: true})));
      panel.scale.set(3.2, 1.6, 1);
      panel.position.set(shell.entry - s * 3.0, 1.9, back + 0.17);
      g.add(panel);
      if (shell.index < last) {                                                              // what is through the exit
        const next = rooms[shell.index + 1];
        const sign = keep(textTexture([{text: `Next: ${next.title}${next.subtitle ? " · " + next.subtitle : ""}`, font: "500 40px Inter, Arial, sans-serif", color: "#d9a441"}], 1024, 96));
        const over = new THREE.Mesh(unit, keep(new THREE.MeshBasicMaterial({map: sign, transparent: true})));
        over.scale.set(3.2, 0.3, 1);
        over.position.set(-shell.entry, DOOR_H + 0.42, back + 0.17);
        g.add(over);
      }
      scene.add(g);
      groups.push(g);
    });
    // A thin line on the floor marks the suggested route.
    scene.add(new THREE.Line(keep(new THREE.BufferGeometry().setFromPoints(set.route.map((p) => new THREE.Vector3(p.x, 0.012, p.z)))),
      keep(new THREE.LineBasicMaterial({color: "#6b5327", transparent: true, opacity: 0.7}))));

    // Works. Pictures and labels are loaded only when the visitor is near.
    const glowMat = keep(new THREE.MeshBasicMaterial({map: keep(glowTexture()), transparent: true, depthWrite: false}));
    const blank = keep(new THREE.MeshBasicMaterial({color: "#3a322b"}));
    const frameMat = keep(new THREE.MeshStandardMaterial({color: "#15110e", roughness: 0.6}));
    const loader = new THREE.TextureLoader();
    loader.setCrossOrigin("anonymous");
    type Hung = {place: Place; art: THREE.Mesh; label: THREE.Mesh; level: number; busy: boolean};
    const hung: Hung[] = places.map((place, index) => {
      const g = new THREE.Group();
      g.position.set(place.x, HANG, place.z);
      g.rotation.y = place.facing;
      const halo = new THREE.Mesh(unit, glowMat);
      halo.scale.set(place.width * 2.5, place.height * 2.3, 1);
      halo.position.z = 0.005;
      const frame = new THREE.Mesh(unitBox, frameMat);
      frame.scale.set(place.width + 0.1, place.height + 0.1, 0.05);
      frame.position.z = 0.02;
      const art = new THREE.Mesh(unit, blank);
      art.scale.set(place.width, place.height, 1);
      art.position.z = 0.05;
      art.userData.index = index;
      const label = new THREE.Mesh(unit, blank);
      label.scale.set(1.5, 0.24, 1);
      label.position.set(0, -place.height / 2 - 0.22, 0.03);
      label.visible = false;
      g.add(halo, frame, art, label);
      groups[place.room].add(g);
      return {place, art, label, level: 0, busy: false};
    });
    const show = (h: Hung, url: string, level: number) => {
      if (h.busy) return;
      h.busy = true;
      loader.load(url, (tex) => {
        h.busy = false;
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
        const old = h.art.material as THREE.MeshBasicMaterial;
        h.art.material = new THREE.MeshBasicMaterial({map: tex, toneMapped: false});
        if (old !== blank) { old.map?.dispose(); old.dispose(); }
        h.level = level;
      }, undefined, () => { h.busy = false; h.level = level; });
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
    const constrain = (x: number, z: number) => {     // keep inside the rooms; cross walls only at doors
      const sh = shells[roomOf(pos.z)];
      const front = sh.z, back = sh.z - sh.depth;
      const gap = DOOR_W / 2 - 0.3;
      x = Math.max(-HALF + BODY, Math.min(HALF - BODY, x));
      if (z < back + BODY && !(sh.index < last && Math.abs(x + sh.entry) < gap)) z = back + BODY;
      if (z > front - BODY && !(sh.index > 0 && Math.abs(x - sh.entry) < gap)) z = front - BODY;
      if (Math.abs(z - back) < BODY && sh.index < last) x = Math.max(-sh.entry - gap, Math.min(-sh.entry + gap, x));
      if (Math.abs(z - front) < BODY && sh.index > 0) x = Math.max(sh.entry - gap, Math.min(sh.entry + gap, x));
      const mid = sh.z - sh.depth / 2;                // step round the bench
      if (Math.abs(x) < 1.2 + 0.4 && Math.abs(z - mid) < 0.35 + 0.4) {
        if (Math.abs(pos.z - mid) >= 0.75) z = mid + Math.sign(pos.z - mid) * 0.75;
        else x = Math.sign(pos.x || 1) * 1.6;
      }
      return {x, z};
    };
    const walkTo = (x: number, z: number, face: Place | null) => {   // through the doors, room by room
      const points: Point[] = [];
      const from = roomOf(pos.z), to = roomOf(z);
      for (let k = from; k < to; k++) { const b = shells[k].z - shells[k].depth; points.push({x: -shells[k].entry, z: b + 0.9}, {x: -shells[k].entry, z: b - 0.9}); }
      for (let k = from; k > to; k--) { const f = shells[k].z; points.push({x: shells[k].entry, z: f - 0.9}, {x: shells[k].entry, z: f + 0.9}); }
      points.push({x, z});
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
    };
    const pick = (i: number) => {
      focus = i;
      setSelected(i >= 0 ? hung[i].place.work : null);
      if (i < 0) return;
      const p = hung[i].place;
      const sh = shells[p.room];
      const x = Math.max(-HALF + BODY, Math.min(HALF - BODY, p.x + p.nx * STAND));
      const z = Math.max(sh.z - sh.depth + BODY, Math.min(sh.z - BODY, p.z + p.nz * STAND));
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
    };

    // ----- Input -----
    const MOVE = new Set(["w", "a", "s", "d", "arrowup", "arrowdown", "arrowleft", "arrowright", "q", "e"]);
    const onWheel = (e: WheelEvent) => {
      if (!enteredRef.current || viewingRef.current) return;
      e.preventDefault();
      auto = null;
      push = Math.max(-9, Math.min(9, push - e.deltaY * 0.012));
    };
    let drag: {x: number; y: number} | null = null;
    let moved = 0;
    const onDown = (e: PointerEvent) => { drag = {x: e.clientX, y: e.clientY}; moved = 0; el.setPointerCapture(e.pointerId); };
    const onMove = (e: PointerEvent) => {
      if (!drag || !enteredRef.current) return;
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      moved += Math.abs(dx) + Math.abs(dy);
      drag = {x: e.clientX, y: e.clientY};
      if (moved > 6) {                                // dragging looks around
        if (auto && auto.face) auto.face = null;
        yaw += dx * 0.0042;
        pitch = Math.max(-0.7, Math.min(0.7, pitch + dy * 0.003));
      }
    };
    const ray = new THREE.Raycaster();
    const ground = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    const onUp = (e: PointerEvent) => {
      const wasDrag = moved > 6;
      drag = null;
      if (wasDrag || !enteredRef.current) return;
      const r = el.getBoundingClientRect();
      ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), camera);
      const hit = ray.intersectObjects(hung.filter((h) => groups[h.place.room].visible).map((h) => h.art))[0];
      if (hit) { pick(hit.object.userData.index); return; }
      const spot = new THREE.Vector3();               // a click on the floor walks there
      if (ray.ray.intersectPlane(ground, spot) && spot.distanceTo(camera.position) < 40) {
        const room = shells[roomOf(spot.z)];
        if (Math.abs(room.index - roomOf(pos.z)) <= 1) {
          pick(-1);
          walkTo(Math.max(-HALF + BODY, Math.min(HALF - BODY, spot.x)),
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

    const resize = () => {
      const w = el.clientWidth, h = el.clientHeight;
      renderer.setSize(w, h, false);
      camera.aspect = w / Math.max(1, h);
      camera.updateProjectionMatrix();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(el);
    resize();

    let frame = 0, raf = 0, lastRoom = -1, then = performance.now();
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const now = performance.now();
      const dt = Math.min(0.05, (now - then) / 1000);
      then = now;

      if (auto) {                                     // walking somewhere on the visitor's behalf
        const goal = auto.points[0];
        const dx = goal.x - pos.x, dz = goal.z - pos.z;
        const dist = Math.hypot(dx, dz);
        const step = calm ? dist : Math.min(dist, WALK * 1.25 * dt);
        if (dist > 0.02) {
          pos.x += (dx / dist) * step;
          pos.z += (dz / dist) * step;
          if (!auto.face || auto.points.length > 1 || dist > 1.6) { const t = turnTo(yaw, heading(dx, dz)); yaw += (t - yaw) * (calm ? 1 : Math.min(1, dt * 4)); }
        }
        if (dist <= 0.05 || step >= dist) {
          auto.points.shift();
          if (!auto.points.length) { if (!auto.face) auto = null; else auto.points.push({x: pos.x, z: pos.z}); }
        }
        if (auto && auto.face && auto.points.length === 1) {   // near the end: turn to the work
          const f = auto.face;
          const t = turnTo(yaw, heading(f.x - pos.x, f.z - pos.z));
          yaw += (t - yaw) * (calm ? 1 : Math.min(1, dt * 5));
          pitch += (Math.atan2(HANG - EYE, Math.hypot(f.x - pos.x, f.z - pos.z)) - pitch) * (calm ? 1 : Math.min(1, dt * 5));
          if (Math.hypot(goal.x - pos.x, goal.z - pos.z) < 0.06 && Math.abs(t - yaw) < 0.01) auto = null;
        }
      } else {                                        // walking under the visitor's own control
        const run = keys.has("shift") ? 1.8 : 1;
        const fwd = (keys.has("w") || keys.has("arrowup") ? 1 : 0) - (keys.has("s") || keys.has("arrowdown") ? 1 : 0);
        const side = (keys.has("d") ? 1 : 0) - (keys.has("a") ? 1 : 0);
        const turn = (keys.has("arrowleft") || keys.has("q") ? 1 : 0) - (keys.has("arrowright") || keys.has("e") ? 1 : 0);
        yaw += turn * 1.7 * dt;
        const speed = (fwd * WALK * run + push) * dt;
        push *= Math.pow(0.02, dt);                    // the wheel's momentum dies away
        if (Math.abs(push) < 0.05) push = 0;
        if (speed || side) {
          const next = constrain(pos.x - Math.sin(yaw) * speed + Math.cos(yaw) * side * WALK * 0.8 * dt,
            pos.z - Math.cos(yaw) * speed - Math.sin(yaw) * side * WALK * 0.8 * dt);
          pos.x = next.x;
          pos.z = next.z;
          if (!turn) pitch += (0 - pitch) * Math.min(1, dt * 1.5);
        }
      }
      camera.position.set(pos.x, EYE, pos.z);
      camera.rotation.set(pitch, yaw, 0);
      lamp.position.set(pos.x, 3.5, pos.z);

      if (frame++ % 12 === 0) {
        const here = roomOf(pos.z);
        let sharp = 0;
        for (const h of hung) {
          const d = Math.hypot(h.place.x - pos.x, h.place.z - pos.z);
          if (d < NEAR_SHARP && h.level < 2 && sharp++ < 2) show(h, h.place.work.image, 2);
          else if (d < NEAR_LOAD && h.level < 1 && Math.abs(h.place.room - here) <= 1) show(h, h.place.work.thumb, 1);
          else if (d > FAR_DROP && h.level > 0) drop(h);
        }
        groups.forEach((g, i) => { g.visible = Math.abs(i - here) <= 1; });
        if (here !== lastRoom) { lastRoom = here; setRoomAt(here); }
        if (focus >= 0 && !auto && Math.hypot(hung[focus].place.x - pos.x, hung[focus].place.z - pos.z) > 6) pick(-1);
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
      hung.forEach(drop);
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
  const pad = (key: string, label: string, glyph: string) => (
    <button type="button" aria-label={label}
      onPointerDown={(e) => { e.preventDefault(); setEntered(true); api.current?.hold(key, true); }}
      onPointerUp={() => api.current?.hold(key, false)} onPointerLeave={() => api.current?.hold(key, false)}>{glyph}</button>
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
          <select value={roomAt} disabled={view !== "walk"}
            onChange={(e) => { api.current?.room(Number(e.target.value)); setEntered(true); mount.current?.focus(); }}>
            {periods.map((period) => (
              <optgroup key={period} label={period}>
                {rooms.map((r, i) => (r.period === period ? (
                  <option key={i} value={i}>{i + 1}. {r.title}{r.subtitle ? ` · ${r.subtitle}` : ""}</option>
                ) : null))}
              </optgroup>
            ))}
          </select>
        </label>
        <span className="sic-walk__count">{shown.length} works in {rooms.length} rooms</span>
        <div className="sic-walk__views" role="group" aria-label="View">
          <button type="button" aria-pressed={view === "walk"} onClick={() => setView("walk")}>Walk</button>
          <button type="button" aria-pressed={view === "list"} onClick={() => setView("list")}>List</button>
        </div>
      </div>

      {view === "walk" ? (
        <div className="sic-walk__stage" ref={stageRef} style={{height: full ? "100vh" : height}}>
          <div className="sic-walk__canvas" ref={mount} tabIndex={0}
            onBlur={() => { if (!document.fullscreenElement && !viewingRef.current) setEntered(false); }}
            aria-label="Gallery rooms. W A S D or the arrow keys walk and turn; drag to look around; N and P go to the next and previous work; Enter opens the selected work; Page Up and Page Down change room; F for full screen; Escape to leave." />
          {room && (
            <div className="sic-walk__where" aria-live="polite">
              <span>{room.period}</span>
              <strong>{room.title}</strong>
              <em>{room.subtitle}</em>
            </div>
          )}
          <button type="button" className="sic-walk__full" onClick={toggleFull} aria-pressed={full}>
            {full ? "Exit full screen" : "Full screen"}
          </button>
          {!entered && !viewing && (
            <button type="button" className="sic-walk__enter" onClick={() => { setEntered(true); mount.current?.focus(); }}>
              <strong>Enter the exhibition</strong>
              <span>Drag to look around. Walk with W A S D or the arrow keys, or click the floor to go there. Click a work for its label, then Open to see it up close. Esc to leave.</span>
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
                <button type="button" onClick={() => api.current?.clear()}>Close</button>
              </div>
            </aside>
          )}
          <div className="sic-walk__scrub">
            <button type="button" onClick={() => api.current?.room(roomAt - 1)} disabled={roomAt === 0}>← Room</button>
            <button type="button" onClick={() => { setEntered(true); api.current?.select(-1); }}>‹ Previous work</button>
            <div className="sic-walk__pad" aria-label="Walk">
              {pad("arrowleft", "Turn left", "↺")}
              {pad("w", "Walk forward", "▲")}
              {pad("s", "Walk back", "▼")}
              {pad("arrowright", "Turn right", "↻")}
            </div>
            <button type="button" onClick={() => { setEntered(true); api.current?.select(1); }}>Next work ›</button>
            <button type="button" onClick={() => api.current?.room(roomAt + 1)} disabled={roomAt >= rooms.length - 1}>Room →</button>
          </div>
          {viewing && <WorkViewer key={viewing.id} work={viewing} full={full} onFull={toggleFull} onClose={closeViewer} />}
        </div>
      ) : (
        <div className="sic-walk__list">
          {rooms.map((r, i) => (
            <section key={i}>
              <h3><small>{r.period}</small>{i + 1}. {r.title}{r.subtitle ? ` · ${r.subtitle}` : ""}</h3>
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
          ))}
        </div>
      )}
    </section>
  );
}
