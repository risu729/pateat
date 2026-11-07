import { afterEach, describe, expect, it, vi } from "vitest";
import { watchFrameShown } from "./frame-shown";

// Frames in Chromium (ADR 0086). The test page itself runs in Vitest's frame.
const frames: HTMLIFrameElement[] = [];
afterEach(() => {
  for (const element of frames.splice(0)) element.remove();
});

/** A frame of the test page's origin, styled `style`, once its document loaded. */
async function frame(style: string): Promise<HTMLIFrameElement> {
  const element = document.createElement("iframe");
  element.setAttribute("style", style);
  element.srcdoc = `<!doctype html><body style="margin:0"><input type="password"></body>`;
  const loaded = new Promise((resolve) =>
    element.addEventListener("load", resolve, { once: true }),
  );
  document.body.append(element);
  frames.push(element);
  await loaded;
  return element;
}

/**
 * The frame's window as a document inside a page of another origin sees it: no frame
 * element to read, so only its observer tells.
 */
function crossOrigin(element: HTMLIFrameElement): Window {
  const view = element.contentWindow!;
  return new Proxy(view, {
    get: (target, key) => {
      if (key === "frameElement") return null;
      const value: unknown = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

const visible = "width:300px;height:200px;border:0";
const hidden: [string, string][] = [
  ["display: none", "display:none"],
  ["empty", "width:0;height:0;border:0"],
  ["one pixel", "width:1px;height:1px;border:0"],
  ["off-screen", `position:fixed;left:-5000px;top:0;${visible}`],
  ["below the fold", `position:absolute;left:0;top:${innerHeight + 2000}px;${visible}`],
];

describe("whether a frame shows in the tab's page", () => {
  it("always holds for the tab's own page", () => {
    const watch = watchFrameShown(window.top!, () => undefined);
    expect(watch.shown()).toBe(true);
    watch.stop();
  });

  it("reads a frame of the page's own origin from its element, at once", async () => {
    const shown = watchFrameShown((await frame(visible)).contentWindow!, () => undefined);
    expect(shown.shown()).toBe(true);
    shown.stop();
    for (const [, style] of [...hidden, ["visibility: hidden", `visibility:hidden;${visible}`]]) {
      // eslint-disable-next-line no-await-in-loop
      const watch = watchFrameShown((await frame(style!)).contentWindow!, () => undefined);
      expect(watch.shown(), style).toBe(false);
      watch.stop();
    }
  });

  it("reads a frame inside a page of another origin from its observer", async () => {
    const element = await frame(visible);
    const watch = watchFrameShown(crossOrigin(element), () => undefined);
    // Nothing is known before the observer's first reading.
    expect(watch.shown()).toBe(false);
    await vi.waitFor(() => expect(watch.shown()).toBe(true));
    watch.stop();
    for (const [label, style] of hidden) {
      // eslint-disable-next-line no-await-in-loop
      const other = watchFrameShown(crossOrigin(await frame(style)), () => undefined);
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(other.shown(), label).toBe(false);
      other.stop();
    }
  });

  it("says when a hidden frame shows, and when it hides again", async () => {
    const element = await frame("display:none");
    const changed = vi.fn();
    const watch = watchFrameShown(crossOrigin(element), changed);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(changed).not.toHaveBeenCalled();
    element.setAttribute("style", visible);
    await vi.waitFor(() => expect(changed).toHaveBeenCalledTimes(1));
    expect(watch.shown()).toBe(true);
    // Shrunk to a pixel, it stays in the viewport: the resize tells.
    element.setAttribute("style", "width:1px;height:1px;border:0");
    await vi.waitFor(() => expect(changed).toHaveBeenCalledTimes(2));
    expect(watch.shown()).toBe(false);
    watch.stop();
  });
});
