import React, {useEffect, useMemo, useRef, useState} from "react";
import * as THREE from "three";
import site from "../data/site.json";
import plan from "../data/gallery_periods.json";

/**
 * Walk-through gallery: the published works staged as an exhibition.
 *
 * The works are arranged by period (app/data/gallery_periods.json) and, within a
 * period, by collection and series. Each group is a room. The visitor follows a
 * marked route with the scroll wheel, arrow keys or touch, can stop at any work,
 * and can jump to any room from the room list.
 *
 * Staging choices, from exhibition research and comparable web galleries:
 *  - a suite of rooms with doors on alternating sides, so the exit is never in
 *    view from the entrance (exits compete with exhibits for attention: Melton,
 *    Bitgood) and the route turns instead of running straight;
 *  - a title wall and one key work face each entrance, in the first sightline;
 *  - the route follows the wall beside the entrance first, then the far wall;
 *  - a bench marks the middle of every room; labels sit in the same place under
 *    every work; text is short (Serrell; Smithsonian accessibility guidelines);
 *  - the wheel is captured only after the visitor steps in, Esc steps out;
 *  - every work is also in a plain list by room, the view for screen readers,
 *    keyboards and browsers without WebGL; "reduce motion" removes camera easing.
 *
 * The works come from web/walk/works.json in the file bucket (tools/make_walk.py).
 */

type Work = {
  id: string; title: string; creator: string; date: string; year: string; estimated?: boolean;
  section: string; series: string; thumb: string; image: string; w: number; h: number; pages: number;
  href?: string;
};
type Room = {period: string; title: string; subtitle: string; works: Work[]};
type Place = {work: Work; room: number; x: number; z: number; facing: number; width: number; height: number};
type Stop = {x: number; z: number; room: number; place?: number};

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
const STAND = 3.1;            // viewing distance from a wall
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
        rooms.push({
          period: period.title,
          title: section,
          subtitle: [single ? series[0] : "", span].filter(Boolean).join(" · "),
          works: batch,
        });
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
  const stops: Stop[] = [];
  const shells: {z: number; depth: number; entry: number; index: number}[] = [];
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
    stops.push({x: entry, z: z + 0.2, room: index});
    stops.push({x: s * (HALF - STAND), z: z - 1.2, room: index});
    near.forEach((work, i) => {                          // the wall beside the entrance, front to back
      const wz = z - 1.9 - i * STEP;
      places.push({work, room: index, x: s * (HALF - 0.07), z: wz, facing: -s * Math.PI / 2, ...fit(work)});
      stops.push({x: s * (HALF - STAND), z: wz, room: index, place: places.length - 1});
    });
    const hero = room.works[0];                          // the key work, on the title wall facing the entrance
    places.push({work: hero, room: index, x: entry, z: back + 0.07, facing: 0, ...fit(hero)});
    stops.push({x: entry, z: back + STAND + 0.4, room: index, place: places.length - 1});
    stops.push({x: 0, z: z - depth / 2 - 1.6, room: index});   // round the bench in the middle
    far.forEach((work, i) => {                           // the far wall, front to back, ending at the exit
      const wz = z - 1.9 - i * STEP;
      places.push({work, room: index, x: -s * (HALF - 0.07), z: wz, facing: s * Math.PI / 2, ...fit(work)});
      stops.push({x: -s * (HALF - STAND), z: wz, room: index, place: places.length - 1});
    });
    stops.push({x: -entry, z: back + 1.4, room: index});
    shells.push({z, depth, entry, index});
    z = back;
  });
  if (stops.length) stops.push({x: stops[stops.length - 1].x, z: z + 0.9, room: rooms.length - 1});
  const at: number[] = [0];
  for (let i = 1; i < stops.length; i++) at.push(at[i - 1] + Math.hypot(stops[i].x - stops[i - 1].x, stops[i].z - stops[i - 1].z));
  return {places, stops, at, shells, length: at[at.length - 1] || 1, end: z};
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

export default function GalleryWalk({height = "78vh"}: {height?: string}) {
  const [works, setWorks] = useState<Work[] | null>(null);
  const [error, setError] = useState("");
  const [section, setSection] = useState("All");
  const [view, setView] = useState<"walk" | "list">("walk");
  const [entered, setEntered] = useState(false);
  const [full, setFull] = useState(false);
  const [selected, setSelected] = useState<Work | null>(null);
  const [roomAt, setRoomAt] = useState(0);
  const [progress, setProgress] = useState(0);
  const mount = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const api = useRef<{goTo: (t: number) => void; room: (i: number) => void; select: (step: number) => void; clear: () => void} | null>(null);
  const enteredRef = useRef(false);
  enteredRef.current = entered;

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
    else stageRef.current?.requestFullscreen?.().then(() => { setEntered(true); mount.current?.focus(); }).catch(() => {});
  };
  const fullRef = useRef(toggleFull);
  fullRef.current = toggleFull;

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
    const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 70);
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
    set.shells.forEach((shell) => {
      const g = new THREE.Group();
      const room = rooms[shell.index];
      const mid = shell.z - shell.depth / 2;
      const back = shell.z - shell.depth;
      box(wall, 0.3, HEIGHT, shell.depth, -HALF - 0.15, HEIGHT / 2, mid, g);
      box(wall, 0.3, HEIGHT, shell.depth, HALF + 0.15, HEIGHT / 2, mid, g);
      if (shell.index === 0) doorway(shell.z, shell.entry, g);
      if (shell.index < rooms.length - 1) doorway(back, -shell.entry, g);
      else box(wall, HALF * 2, HEIGHT, 0.3, 0, HEIGHT / 2, back, g);
      box(light, 1.4, 0.02, Math.max(3, shell.depth - 5), 0, HEIGHT - 0.02, mid, g);        // ceiling light
      box(benchMat, 2.4, 0.42, 0.7, 0, 0.21, mid, g);                                        // bench
      for (const sx of [-1, 1]) box(brass, 0.03, 0.03, shell.depth, sx * (HALF - 0.02), 0.09, mid, g);
      // Title wall: beside the key work, facing the entrance.
      const s = Math.sign(shell.entry);
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
      if (shell.index < rooms.length - 1) {                                                // what is through the exit
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

    // A thin line on the floor marks the route.
    const routePoints = set.stops.map((p) => new THREE.Vector3(p.x, 0.012, p.z));
    const route = new THREE.Line(keep(new THREE.BufferGeometry().setFromPoints(routePoints)),
      keep(new THREE.LineBasicMaterial({color: "#6b5327", transparent: true, opacity: 0.7})));
    scene.add(route);

    // Works. Pictures and labels are loaded only when the visitor is near.
    const glowMat = keep(new THREE.MeshBasicMaterial({map: keep(glowTexture()), transparent: true, depthWrite: false}));
    const blank = keep(new THREE.MeshBasicMaterial({color: "#3a322b"}));
    const frameMat = keep(new THREE.MeshStandardMaterial({color: "#15110e", roughness: 0.6}));
    const loader = new THREE.TextureLoader();
    loader.setCrossOrigin("anonymous");
    type Hung = {place: Place; art: THREE.Mesh; label: THREE.Mesh; level: number; busy: boolean};
    const hung: Hung[] = set.places.map((place, index) => {
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

    // The route as distances: where a point on it is, and where each work's viewing spot falls.
    const {stops, at, length} = set;
    const pointAt = (d: number) => {
      const t = Math.max(0, Math.min(length, d));
      let i = 1;
      while (i < at.length - 1 && at[i] < t) i++;
      const a = stops[i - 1], b = stops[i];
      const f = (t - at[i - 1]) / Math.max(1e-6, at[i] - at[i - 1]);
      return {x: a.x + (b.x - a.x) * f, z: a.z + (b.z - a.z) * f, room: f < 0.5 ? a.room : b.room};
    };
    const spot: number[] = [];                       // distance along the route of each work
    stops.forEach((p, i) => { if (p.place !== undefined) spot[p.place] = at[i]; });
    const order = spot.map((d, i) => [d, i]).sort((a, b) => a[0] - b[0]).map((x) => x[1]);
    const roomStart = set.shells.map((sh) => at[stops.findIndex((p) => p.room === sh.index)] + 1.6);

    let target = 0.6, here = 0.6, sway = 0, tilt = 0;
    let focus = -1;
    const look = new THREE.Vector3(stops[0].x, EYE, stops[0].z - 6);
    const want = look.clone();
    const clamp = (v: number) => Math.max(0, Math.min(length, v));
    const pick = (i: number) => {
      focus = i;
      if (i >= 0) target = spot[i];
      setSelected(i >= 0 ? hung[i].place.work : null);
    };
    api.current = {
      goTo: (t) => { pick(-1); target = clamp(t * length); },
      room: (i) => { pick(-1); target = clamp(roomStart[Math.max(0, Math.min(roomStart.length - 1, i))]); },
      select: (step) => {
        let pos: number;
        if (focus >= 0) pos = order.indexOf(focus) + step;
        else if (step > 0) { pos = order.findIndex((i) => spot[i] > here - 0.3); if (pos < 0) pos = order.length - 1; }
        else { pos = -1; order.forEach((i, k) => { if (spot[i] < here + 0.3) pos = k; }); if (pos < 0) pos = 0; }
        pick(order[Math.max(0, Math.min(order.length - 1, pos))]);
      },
      clear: () => pick(-1),
    };

    const onWheel = (e: WheelEvent) => {
      if (!enteredRef.current) return;
      e.preventDefault();
      if (focus >= 0) pick(-1);
      target = clamp(target + e.deltaY * 0.012);
    };
    let drag: {x: number; y: number} | null = null;
    let moved = 0;
    const onDown = (e: PointerEvent) => { drag = {x: e.clientX, y: e.clientY}; moved = 0; };
    const onMove = (e: PointerEvent) => {
      const r = el.getBoundingClientRect();
      if (!calm && e.pointerType === "mouse") {
        sway = ((e.clientX - r.left) / r.width - 0.5) * 1.3;
        tilt = ((e.clientY - r.top) / r.height - 0.5) * 0.35;
      }
      if (drag && enteredRef.current) {
        const dy = e.clientY - drag.y;
        moved += Math.abs(dy) + Math.abs(e.clientX - drag.x);
        drag = {x: e.clientX, y: e.clientY};
        if (e.pointerType !== "mouse") { if (focus >= 0) pick(-1); target = clamp(target - dy * 0.03); }
      }
    };
    const ray = new THREE.Raycaster();
    const onUp = (e: PointerEvent) => {
      drag = null;
      if (moved > 8 || !enteredRef.current) return;
      const r = el.getBoundingClientRect();
      ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), camera);
      const hit = ray.intersectObjects(hung.filter((h) => groups[h.place.room].visible).map((h) => h.art))[0];
      pick(hit ? hit.object.userData.index : -1);
    };
    const onKey = (e: KeyboardEvent) => {
      if (!enteredRef.current) return;
      const k = e.key;
      const current = pointAt(here).room;
      if (k === "ArrowUp" || k === "w") { pick(-1); target = clamp(target + 2.2); }
      else if (k === "ArrowDown" || k === "s") { pick(-1); target = clamp(target - 2.2); }
      else if (k === "ArrowRight") api.current!.select(1);
      else if (k === "ArrowLeft") api.current!.select(-1);
      else if (k === "PageDown") api.current!.room(current + 1);
      else if (k === "PageUp") api.current!.room(current - 1);
      else if (k === "Home") { pick(-1); target = 0.6; }
      else if (k === "End") { pick(-1); target = length; }
      else if (k === "f") fullRef.current();
      else if (k === "Escape") { if (focus >= 0) pick(-1); else if (!document.fullscreenElement) setEntered(false); }
      else return;
      e.preventDefault();
    };
    el.addEventListener("wheel", onWheel, {passive: false});
    el.addEventListener("pointerdown", onDown);
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("keydown", onKey);

    const resize = () => {
      const w = el.clientWidth, h = el.clientHeight;
      renderer.setSize(w, h, false);
      camera.aspect = w / Math.max(1, h);
      camera.updateProjectionMatrix();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(el);
    resize();

    let frame = 0, raf = 0, lastRoom = -1, lastProgress = -1;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const ease = calm ? 1 : 0.07;
      here += (target - here) * ease;
      const p = pointAt(here);
      camera.position.set(p.x, EYE, p.z);
      // Look at the selected work, or the work whose viewing spot is closest, or along the route.
      let near = focus;
      if (near < 0) {
        let best = 1.25;
        for (const i of order) { const d = Math.abs(spot[i] - here); if (d < best) { best = d; near = i; } }
      }
      if (near >= 0) {
        const place = hung[near].place;
        want.set(place.x, HANG, place.z);
      } else {
        const ahead = pointAt(here + 3.2);
        want.set(ahead.x, EYE - 0.05, ahead.z);
      }
      look.lerp(want, calm ? 1 : 0.06);
      camera.lookAt(look);
      if (focus < 0 && !calm) { camera.rotateY(-sway * 0.5); camera.rotateX(-tilt * 0.5); }
      lamp.position.set(p.x, 3.5, p.z);

      if (frame++ % 12 === 0) {
        let sharp = 0;
        for (const h of hung) {
          const d = Math.hypot(h.place.x - p.x, h.place.z - p.z);
          if (d < NEAR_SHARP && h.level < 2 && sharp++ < 2) show(h, h.place.work.image, 2);
          else if (d < NEAR_LOAD && h.level < 1 && Math.abs(h.place.room - p.room) <= 1) show(h, h.place.work.thumb, 1);
          else if (d > FAR_DROP && h.level > 0) drop(h);
        }
        groups.forEach((g, i) => { g.visible = Math.abs(i - p.room) <= 1; });
        if (p.room !== lastRoom) { lastRoom = p.room; setRoomAt(p.room); }
        const pr = Math.round((here / length) * 1000) / 1000;
        if (pr !== lastProgress) { lastProgress = pr; setProgress(pr); }
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

  return (
    <section className="sic-walk" aria-label="Walk-through gallery">
      <div className="sic-walk__bar">
        <label>
          <span>Collection</span>
          <select value={section} onChange={(e) => { setSection(e.target.value); setSelected(null); setRoomAt(0); }}>
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
            onBlur={() => { if (!document.fullscreenElement) setEntered(false); }}
            aria-label="Gallery rooms. Up and down arrows walk the route; left and right move between works; Page Up and Page Down change room; F for full screen; Escape to leave." />
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
          {!entered && (
            <button type="button" className="sic-walk__enter" onClick={() => { setEntered(true); mount.current?.focus(); }}>
              <strong>Enter the exhibition</strong>
              <span>Scroll or use the arrow keys to follow the route through the rooms. Select a work to read its label. Esc to leave.</span>
            </button>
          )}
          {selected && (
            <aside className="sic-walk__panel">
              <p className="sic-eyebrow">{selected.section}</p>
              <h3>{selected.title}</h3>
              <p>{[selected.creator, selected.date].filter(Boolean).join(" · ")}</p>
              {selected.pages > 1 && <p className="sic-walk__pages">{selected.pages} pages</p>}
              <div className="sic-walk__actions">
                {selected.href && <a className="canopy-button canopy-button--primary" href={selected.href}>Open item</a>}
                <button type="button" onClick={() => api.current?.select(-1)} aria-label="Previous work">←</button>
                <button type="button" onClick={() => api.current?.select(1)} aria-label="Next work">→</button>
                <button type="button" onClick={() => api.current?.clear()}>Close</button>
              </div>
            </aside>
          )}
          <div className="sic-walk__scrub">
            <button type="button" onClick={() => api.current?.room(roomAt - 1)} disabled={roomAt === 0}>← Room</button>
            <input type="range" min={0} max={1000} value={Math.round(progress * 1000)}
              aria-label="Position along the route, from the first room to the last"
              onChange={(e) => api.current?.goTo(Number(e.target.value) / 1000)} />
            <button type="button" onClick={() => api.current?.room(roomAt + 1)} disabled={roomAt >= rooms.length - 1}>Room →</button>
          </div>
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
