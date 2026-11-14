import React, {useEffect, useMemo, useRef, useState} from "react";
import * as THREE from "three";
import site from "../data/site.json";

/**
 * Walk-through gallery: a hall in which every published work hangs in date
 * order, one room per year. Visitors walk with the scroll wheel, arrow keys or
 * touch, and select a work to read its label and open its item page.
 *
 * The works come from web/walk/works.json in the file bucket (written by
 * tools/make_walk.py), so the hall grows as works are published. Links to item
 * pages come from the site's own search index.
 *
 * Design notes, following what comparable projects found:
 *  - the visitor has to step in before the wheel is captured, and Esc steps
 *    out, so the page never traps scrolling;
 *  - every work is also in a plain chronological list (the "List" view), which
 *    is what screen readers, keyboards and browsers without WebGL get;
 *  - with "reduce motion" set, the camera moves without easing or sway.
 */

type Work = {
  id: string; title: string; creator: string; date: string; year: string;
  section: string; thumb: string; image: string; w: number; h: number; pages: number;
  href?: string;
};
type Slot = {work: Work; x: number; z: number; side: number; width: number; height: number};
type Marker = {label: string; z: number};

const HALL_HALF = 3.1;        // half the hall's width, metres
const HALL_HEIGHT = 4.4;
const EYE = 1.62;
const SPACING = 3.3;          // along the hall, between works on the same wall
const YEAR_GAP = 3.6;
const MAX_W = 2.4;
const MAX_H = 1.7;
const HANG = 1.85;           // height of each work's centre
const NEAR_LOAD = 34;         // load thumbnails within this distance
const NEAR_SHARP = 7;         // load the large image within this distance
const FAR_DROP = 48;          // free textures beyond this distance

function layout(works: Work[]) {
  const slots: Slot[] = [];
  const markers: Marker[] = [];
  let z = -6;
  let label = "";
  let n = 0;
  for (const work of works) {
    const group = work.year || "Undated";
    if (group !== label) {
      if (n % 2 === 1) z -= SPACING;
      z -= slots.length ? YEAR_GAP : 0;
      markers.push({label: group, z});
      z -= YEAR_GAP * 0.6;
      label = group;
      n = 0;
    }
    const aspect = work.w / Math.max(1, work.h);
    let height = MAX_H;
    let width = height * aspect;
    if (width > MAX_W) { width = MAX_W; height = width / aspect; }
    const side = n % 2 === 0 ? -1 : 1;
    slots.push({work, side, x: side * (HALL_HALF - 0.06), z, width, height});
    if (n % 2 === 1) z -= SPACING;
    n += 1;
  }
  return {slots, markers, length: Math.abs(z) + 8};
}

function textTexture(lines: {text: string; font: string; color: string}[], width: number, height: number) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d")!;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const step = height / (lines.length + 1);
  lines.forEach((line, i) => {
    ctx.font = line.font;
    ctx.fillStyle = line.color;
    let text = line.text;
    while (text.length > 4 && ctx.measureText(text).width > width - 24) text = text.slice(0, -2);
    if (text !== line.text) text = text.trimEnd() + "…";
    ctx.fillText(text, width / 2, step * (i + 1));
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
  const g = ctx.createRadialGradient(128, 110, 10, 128, 128, 128);
  g.addColorStop(0, "rgba(255, 236, 200, 0.34)");
  g.addColorStop(0.55, "rgba(255, 226, 180, 0.10)");
  g.addColorStop(1, "rgba(255, 226, 180, 0)");
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
  const [selected, setSelected] = useState<Work | null>(null);
  const [year, setYear] = useState("");
  const [progress, setProgress] = useState(0);
  const mount = useRef<HTMLDivElement>(null);
  const api = useRef<{goTo: (t: number) => void; select: (step: number) => void; clear: () => void} | null>(null);
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
        let hrefs: Record<string, string> = {};
        try {
          const index = await (await fetch(`${base}/api/search-records.json`)).json();
          const records = Array.isArray(index) ? index : index.records || [];
          for (const r of records) {
            const m = /\/images\/([^/]+)\/thumb\.jpg/.exec(r.thumbnail || "");
            if (m && r.href) hrefs[m[1]] = `${base}${r.href}`;
          }
        } catch { /* links simply stay off */ }
        const list: Work[] = data.works.map((w: Work) => ({
          ...w, thumb: swap(w.thumb), image: swap(w.image), href: hrefs[w.id],
        }));
        if (live) setWorks(list);
      } catch (e) {
        if (live) setError("The gallery could not be loaded.");
      }
    })();
    return () => { live = false; };
  }, []);

  const sections = useMemo(() => ["All", ...Array.from(new Set((works || []).map((w) => w.section)))], [works]);
  const shown = useMemo(() => (works || []).filter((w) => section === "All" || w.section === section), [works, section]);
  const plan = useMemo(() => layout(shown), [shown]);

  useEffect(() => {
    const el = mount.current;
    if (!el || view !== "walk" || !shown.length) return;
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
    scene.fog = new THREE.Fog(backdrop, 9, 46);
    const camera = new THREE.PerspectiveCamera(58, 1, 0.1, 60);
    camera.position.set(0, EYE, 0);
    scene.add(new THREE.HemisphereLight(0xfff1dc, 0x241d18, 1.5));
    const lamp = new THREE.PointLight(0xffe2b8, 14, 16, 1.6);
    scene.add(lamp);

    // The hall: floor, ceiling and two walls, long enough for every work.
    const L = plan.length;
    const mid = -L / 2 + 4;
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(HALL_HALF * 2, L),
      new THREE.MeshStandardMaterial({color: "#191512", roughness: 0.42, metalness: 0.25}));
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(0, 0, mid);
    const ceiling = new THREE.Mesh(new THREE.PlaneGeometry(HALL_HALF * 2, L),
      new THREE.MeshStandardMaterial({color: "#0f0d0c", roughness: 1}));
    ceiling.rotation.x = Math.PI / 2;
    ceiling.position.set(0, HALL_HEIGHT, mid);
    const wallMaterial = new THREE.MeshStandardMaterial({color: "#3a322c", roughness: 0.95});
    const wallGeometry = new THREE.PlaneGeometry(L, HALL_HEIGHT);
    const left = new THREE.Mesh(wallGeometry, wallMaterial);
    left.rotation.y = Math.PI / 2;
    left.position.set(-HALL_HALF, HALL_HEIGHT / 2, mid);
    const right = new THREE.Mesh(wallGeometry, wallMaterial);
    right.rotation.y = -Math.PI / 2;
    right.position.set(HALL_HALF, HALL_HEIGHT / 2, mid);
    const skirting = new THREE.MeshBasicMaterial({color: "#8a6a2f"});
    for (const s of [-1, 1]) {
      const rail = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.03, L), skirting);
      rail.position.set(s * (HALL_HALF - 0.02), 0.09, mid);
      scene.add(rail);
    }
    // A line of light down the middle of the ceiling.
    const strip = new THREE.Mesh(new THREE.PlaneGeometry(0.5, L), new THREE.MeshBasicMaterial({color: "#ffe9c7"}));
    strip.rotation.x = Math.PI / 2;
    strip.position.set(0, HALL_HEIGHT - 0.01, mid);
    scene.add(floor, ceiling, left, right, strip);

    // Year markers: the year set into the floor and hung overhead.
    const disposables: {dispose: () => void}[] = [wallGeometry, wallMaterial, skirting];
    for (const m of plan.markers) {
      const tex = textTexture([{text: m.label, font: "500 150px Fraunces, Georgia, serif", color: "#d9a441"}], 640, 256);
      const mat = new THREE.MeshBasicMaterial({map: tex, transparent: true, fog: true});
      const onFloor = new THREE.Mesh(new THREE.PlaneGeometry(3.4, 1.36), mat);
      onFloor.rotation.x = -Math.PI / 2;
      onFloor.position.set(0, 0.012, m.z - 0.4);
      const banner = new THREE.Mesh(new THREE.PlaneGeometry(2.2, 0.88), mat);
      banner.position.set(0, HALL_HEIGHT - 0.85, m.z - 0.2);
      const beam = new THREE.Mesh(new THREE.BoxGeometry(HALL_HALF * 2, 0.06, 0.06), skirting);
      beam.position.set(0, HALL_HEIGHT - 0.3, m.z - 0.2);
      scene.add(onFloor, banner, beam);
      disposables.push(tex, mat);
    }

    // One frame per work. Pictures and labels are loaded only when the visitor is near.
    const glow = glowTexture();
    const glowMaterial = new THREE.MeshBasicMaterial({map: glow, transparent: true, depthWrite: false});
    const blank = new THREE.MeshBasicMaterial({color: "#3a322b"});
    const frameMaterial = new THREE.MeshStandardMaterial({color: "#15110e", roughness: 0.6});
    const unit = new THREE.PlaneGeometry(1, 1);
    const box = new THREE.BoxGeometry(1, 1, 1);
    disposables.push(glow, glowMaterial, blank, frameMaterial, unit, box);
    const loader = new THREE.TextureLoader();
    loader.setCrossOrigin("anonymous");
    type Hung = {slot: Slot; art: THREE.Mesh; label: THREE.Mesh; level: 0 | 1 | 2; busy: boolean};
    const hung: Hung[] = plan.slots.map((slot) => {
      const group = new THREE.Group();
      group.position.set(slot.x, HANG, slot.z);
      group.rotation.y = slot.side < 0 ? Math.PI / 2 : -Math.PI / 2;
      const halo = new THREE.Mesh(unit, glowMaterial);
      halo.scale.set(slot.width * 2.4, slot.height * 2.2, 1);
      halo.position.z = 0.005;
      const frame = new THREE.Mesh(box, frameMaterial);
      frame.scale.set(slot.width + 0.1, slot.height + 0.1, 0.05);
      frame.position.z = 0.02;
      const art = new THREE.Mesh(unit, blank);
      art.scale.set(slot.width, slot.height, 1);
      art.position.z = 0.05;
      art.userData.index = 0;
      const label = new THREE.Mesh(unit, blank);
      label.scale.set(1.5, 0.24, 1);
      label.position.set(0, -slot.height / 2 - 0.22, 0.03);
      label.visible = false;
      group.add(halo, frame, art, label);
      scene.add(group);
      return {slot, art, label, level: 0, busy: false};
    });
    hung.forEach((h, i) => { h.art.userData.index = i; });

    const show = (h: Hung, url: string, level: 1 | 2) => {
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
        const w = h.slot.work;
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

    // Movement.
    const end = -(L - 12);
    let target = 0;       // where the visitor is heading along the hall
    let sway = 0;         // look left/right from the pointer
    let focus: Hung | null = null;
    const look = new THREE.Vector3(0, EYE, -10);
    const want = new THREE.Vector3(0, EYE, -10);
    const clamp = (v: number) => Math.max(end, Math.min(0, v));
    const pick = (h: Hung | null) => {
      focus = h;
      if (h) target = h.slot.z;
      setSelected(h ? h.slot.work : null);
    };
    api.current = {
      goTo: (t) => { pick(null); target = clamp(t * end); },
      select: (step) => {
        const z = camera.position.z;
        let i = focus ? hung.indexOf(focus) + step
          : hung.reduce((best, h, k) => (Math.abs(h.slot.z - z) < Math.abs(hung[best].slot.z - z) ? k : best), 0);
        pick(hung[Math.max(0, Math.min(hung.length - 1, i))]);
      },
      clear: () => pick(null),
    };

    const onWheel = (e: WheelEvent) => {
      if (!enteredRef.current) return;
      e.preventDefault();
      if (focus) pick(null);
      target = clamp(target - e.deltaY * 0.012);
    };
    let dragY: number | null = null;
    let moved = 0;
    const onDown = (e: PointerEvent) => { dragY = e.clientY; moved = 0; };
    const onMove = (e: PointerEvent) => {
      const r = el.getBoundingClientRect();
      if (!calm) sway = ((e.clientX - r.left) / r.width - 0.5) * 0.9;
      if (dragY !== null && enteredRef.current) {
        const d = e.clientY - dragY;
        moved += Math.abs(d);
        dragY = e.clientY;
        if (e.pointerType !== "mouse") { if (focus) pick(null); target = clamp(target + d * 0.03); }
      }
    };
    const ray = new THREE.Raycaster();
    const onUp = (e: PointerEvent) => {
      dragY = null;
      if (moved > 8 || !enteredRef.current) return;
      const r = el.getBoundingClientRect();
      ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), camera);
      const hit = ray.intersectObjects(hung.map((h) => h.art))[0];
      pick(hit ? hung[hit.object.userData.index] : null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (!enteredRef.current) return;
      const k = e.key;
      if (k === "ArrowUp" || k === "w") { pick(null); target = clamp(target - 2.2); }
      else if (k === "ArrowDown" || k === "s") { pick(null); target = clamp(target + 2.2); }
      else if (k === "ArrowRight") api.current!.select(1);
      else if (k === "ArrowLeft") api.current!.select(-1);
      else if (k === "Home") { pick(null); target = 0; }
      else if (k === "End") { pick(null); target = end; }
      else if (k === "Escape") { if (focus) pick(null); else setEntered(false); }
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

    let frame = 0;
    let raf = 0;
    let lastYear = "";
    let lastProgress = -1;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const ease = calm ? 1 : 0.075;
      const goalX = focus ? -focus.slot.side * 0.75 : 0;
      camera.position.z += (target - camera.position.z) * ease;
      camera.position.x += (goalX - camera.position.x) * ease;
      if (focus) want.set(focus.slot.x, HANG, focus.slot.z);
      else want.set(Math.sin(sway) * 6, EYE - 0.05, camera.position.z - 10);
      look.lerp(want, calm ? 1 : 0.09);
      camera.lookAt(look);
      lamp.position.set(camera.position.x, 3.4, camera.position.z - 1.5);

      if (frame++ % 12 === 0) {
        const z = camera.position.z;
        let sharp = 0;
        for (const h of hung) {
          const d = Math.abs(h.slot.z - z);
          if (d < NEAR_SHARP && h.level < 2 && sharp++ < 2) show(h, h.slot.work.image, 2);
          else if (d < NEAR_LOAD && h.level < 1) show(h, h.slot.work.thumb, 1);
          else if (d > FAR_DROP && h.level > 0) drop(h);
        }
        const here = plan.markers.filter((m) => m.z >= z - 1.5).pop() || plan.markers[0];
        if (here && here.label !== lastYear) { lastYear = here.label; setYear(here.label); }
        const p = Math.round((z / end) * 1000) / 1000;
        if (p !== lastProgress) { lastProgress = p; setProgress(p); }
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
      disposables.forEach((d) => d.dispose());
      floor.geometry.dispose();
      ceiling.geometry.dispose();
      strip.geometry.dispose();
      renderer.dispose();
      renderer.domElement.remove();
      api.current = null;
    };
  }, [plan, view, shown.length]);

  if (error) return <p className="sic-walk__status">{error}</p>;
  if (!works) return <p className="sic-walk__status">Opening the gallery…</p>;

  const years = plan.markers.map((m) => m.label).filter((y) => y !== "Undated");
  const undated = shown.filter((w) => !w.year).length;
  const byYear: Record<string, Work[]> = {};
  shown.forEach((w) => { (byYear[w.year || "Undated"] ||= []).push(w); });

  return (
    <section className="sic-walk" aria-label="Walk-through gallery">
      <div className="sic-walk__bar">
        <label>
          <span>Collection</span>
          <select value={section} onChange={(e) => { setSection(e.target.value); setSelected(null); }}>
            {sections.map((s) => <option key={s}>{s}</option>)}
          </select>
        </label>
        <span className="sic-walk__count">
          {shown.length} works{years.length ? `, ${years[0]} to ${years[years.length - 1]}` : ""}{undated ? `, ${undated} undated` : ""}
        </span>
        <div className="sic-walk__views" role="group" aria-label="View">
          <button type="button" aria-pressed={view === "walk"} onClick={() => setView("walk")}>Walk</button>
          <button type="button" aria-pressed={view === "list"} onClick={() => setView("list")}>List</button>
        </div>
      </div>

      {view === "walk" ? (
        <div className="sic-walk__stage" style={{height}}>
          <div className="sic-walk__canvas" ref={mount} tabIndex={0} onBlur={() => setEntered(false)}
            aria-label="Gallery hall. Use the arrow keys to walk and to move between works; Escape to leave." />
          <div className="sic-walk__year" aria-live="polite">{year}</div>
          {!entered && (
            <button type="button" className="sic-walk__enter"
              onClick={() => { setEntered(true); mount.current?.focus(); }}>
              <strong>Enter the gallery</strong>
              <span>Scroll or use the arrow keys to walk. Select a work to read its label. Esc to leave.</span>
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
          <label className="sic-walk__scrub">
            <span>{years[0]}</span>
            <input type="range" min={0} max={1000} value={Math.round(progress * 1000)}
              aria-label="Position in the gallery, from earliest to latest"
              onChange={(e) => api.current?.goTo(Number(e.target.value) / 1000)} />
            <span>{undated ? "Undated" : years[years.length - 1]}</span>
          </label>
        </div>
      ) : (
        <div className="sic-walk__list">
          {Object.entries(byYear).map(([y, items]) => (
            <section key={y}>
              <h3>{y}</h3>
              <ul>
                {items.map((w) => (
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
