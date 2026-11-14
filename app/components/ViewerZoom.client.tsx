import {useEffect} from "react";

/**
 * Makes a double-click in the item viewer zoom back out once the image is
 * zoomed in as far as it goes. (By default every double-click zooms in, and at
 * full zoom nothing happens.)
 *
 * The viewer does not hand out its zoom component, so it is looked up through
 * the viewer's own state. If a later version of the viewer changes how that is
 * kept, this quietly does nothing and the viewer behaves as it did before.
 */
type Zoomer = {
  viewport?: {getZoom: (current?: boolean) => number; getMaxZoom: () => number; goHome: () => void};
  addHandler: (name: string, fn: (event: {preventDefaultAction?: boolean}) => void) => void;
};

function zoomerFor(node: Element | null): Zoomer | null {
  for (let el: Element | null = node; el; el = el.parentElement) {
    const key = Object.keys(el).find((k) => k.startsWith("__reactFiber$"));
    let fiber = key ? (el as unknown as Record<string, any>)[key] : null;
    for (let i = 0; fiber && i < 500; i++, fiber = fiber.return) {
      const value = fiber.memoizedProps?.value;
      if (value && value.openSeadragonViewer?.addHandler) return value.openSeadragonViewer;
    }
    if (key) return null;
  }
  return null;
}

export default function ViewerZoom() {
  useEffect(() => {
    const done = new WeakSet<object>();
    const attach = () => {
      document.querySelectorAll(".openseadragon-canvas").forEach((canvas) => {
        const zoomer = zoomerFor(canvas);
        if (!zoomer || done.has(zoomer)) return;
        done.add(zoomer);
        zoomer.addHandler("canvas-double-click", (event) => {
          const view = zoomer.viewport;
          if (view && view.getZoom() >= view.getMaxZoom() * 0.98) {
            event.preventDefaultAction = true;      // already fully zoomed in: go back to the whole page
            view.goHome();
          }
        });
      });
    };
    let queued = 0;
    const observer = new MutationObserver(() => {
      window.clearTimeout(queued);
      queued = window.setTimeout(attach, 300);
    });
    observer.observe(document.body, {childList: true, subtree: true});
    attach();
    return () => { observer.disconnect(); window.clearTimeout(queued); };
  }, []);
  return null;
}
