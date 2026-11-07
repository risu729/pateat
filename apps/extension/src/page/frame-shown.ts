// Whether a frame's document shows in its tab's page, read from inside the frame (ADR 0086).

/** A watch of whether this document shows in its tab's page. */
export type FrameShown = {
  /** Whether the document shows now. */
  shown(): boolean;
  /** Ends the watch. */
  stop(): void;
};

/**
 * Whether each frame element from `view` up that this document may read, as one in a page
 * of its own origin, is rendered (not `display: none` nor `visibility: hidden`), more than
 * a pixel each way and in its page's viewport; and whether that reached the tab's page.
 */
function elementsShown(view: Window): { shown: boolean; top: boolean } {
  let current: Window = view;
  while (current.top !== current) {
    let element: Element | null;
    try {
      element = current.frameElement;
    } catch {
      element = null;
    }
    // A page of another origin around the frame: only the observer can tell.
    if (!element) return { shown: true, top: false };
    const parent = element.ownerDocument.defaultView;
    if (!parent) return { shown: false, top: false };
    const box = element.getBoundingClientRect();
    if (
      !element.checkVisibility({ visibilityProperty: true }) ||
      box.width <= 1 ||
      box.height <= 1 ||
      box.right <= 0 ||
      box.bottom <= 0 ||
      box.left >= parent.innerWidth ||
      box.top >= parent.innerHeight
    )
      return { shown: false, top: false };
    current = parent;
  }
  return { shown: true, top: true };
}

/**
 * Watches whether this document shows in its tab's page, so a frame's page is sent for
 * generation only once the person can see it (ADR 0086). The tab's own page always does.
 * A frame does while its viewport is more than a pixel each way and part of it lies in the
 * tab's viewport: read from its frame element where the page around it is of its own
 * origin, and otherwise as an `IntersectionObserver` with the implicit root reads it from
 * inside the frame. A `display: none`, empty, one-pixel or off-screen frame does not, and
 * one below the fold does once scrolled to. `changed` hears each change the observer or a
 * resize of the frame shows. Without an observer, a frame inside a page of another origin
 * never shows.
 */
export function watchFrameShown(view: Window, changed: () => void): FrameShown {
  if (view.top === view) return { shown: () => true, stop: () => undefined };
  const Observer = (view as Window & typeof globalThis).IntersectionObserver as
    | typeof IntersectionObserver
    | undefined;
  // False until the observer's first reading, which comes at the frame's next rendering.
  let intersecting = false;
  const shown = () => {
    if (view.innerWidth <= 1 || view.innerHeight <= 1) return false;
    const elements = elementsShown(view);
    return elements.shown && (elements.top || intersecting);
  };
  let last = shown();
  const read = () => {
    if (shown() === last) return;
    last = !last;
    changed();
  };
  const observer = Observer
    ? new Observer((entries) => {
        const entry = entries.at(-1);
        if (!entry) return;
        intersecting = entry.isIntersecting;
        read();
      })
    : undefined;
  observer?.observe(view.document.documentElement);
  view.addEventListener("resize", read);
  return {
    shown,
    stop: () => {
      observer?.disconnect();
      view.removeEventListener("resize", read);
    },
  };
}
