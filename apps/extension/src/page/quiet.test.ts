import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { breaksQuiet, settled } from "./quiet";

const xlink = "http://www.w3.org/1999/xlink";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  document.body.innerHTML = "";
});

/** The records a change of the page makes, as an observer of every change hears them. */
function records(change: () => void): MutationRecord[] {
  const observer = new MutationObserver(() => undefined);
  observer.observe(document.body, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
  });
  change();
  // Taken before the observer's callback would receive them.
  const taken = observer.takeRecords();
  observer.disconnect();
  return taken;
}
/** When, in ms after the call, `settled` resolved while `animate` ran every frame. */
async function settledAfter(animate: (tick: number) => void): Promise<number | undefined> {
  const began = Date.now();
  let at: number | undefined;
  void settled(document, 1000, began + 5000).then(() => (at = Date.now() - began));
  let tick = 0;
  const animation = setInterval(() => animate(++tick), 16);
  await vi.advanceTimersByTimeAsync(5_100);
  clearInterval(animation);
  return at;
}

describe("breaksQuiet", () => {
  it("counts node and text changes and the listed attributes, not other attributes", () => {
    document.body.innerHTML =
      '<main><p>Text</p><div role="progressbar"></div><svg><use></use></svg></main>';
    const main = document.querySelector("main")!;
    const counted = (change: () => void) => records(change).some(breaksQuiet);
    expect(counted(() => main.append(document.createElement("p")))).toBe(true);
    expect(counted(() => (main.querySelector("p")!.firstChild!.nodeValue = "New"))).toBe(true);
    expect(counted(() => main.setAttribute("class", "shown"))).toBe(true);
    expect(counted(() => main.setAttribute("hidden", ""))).toBe(true);
    expect(counted(() => main.querySelector("[role]")!.setAttribute("aria-valuenow", "5"))).toBe(
      false,
    );
    expect(counted(() => main.setAttribute("data-render", "done"))).toBe(false);
    // A namespaced attribute does not count, even under a listed local name.
    expect(
      counted(() => main.querySelector("use")!.setAttributeNS(xlink, "xlink:href", "#a")),
    ).toBe(false);
  });
});

describe("settled", () => {
  it("resolves after a quiet second while only unlisted attributes animate", async () => {
    document.body.innerHTML =
      '<div role="progressbar" aria-valuenow="0"></div><svg><rect></rect><use></use></svg>';
    const bar = document.querySelector("[role=progressbar]")!;
    const rect = document.querySelector("rect")!;
    const use = document.querySelector("use")!;
    const at = await settledAfter((tick) => {
      bar.setAttribute("aria-valuenow", String(tick % 100));
      rect.setAttribute("transform", `rotate(${tick % 360})`);
      use.setAttributeNS(xlink, "xlink:href", `#frame-${tick % 2}`);
    });
    expect(at).toBeGreaterThanOrEqual(1000);
    expect(at).toBeLessThan(1100);
  });

  it("waits until its bound while a listed attribute keeps changing", async () => {
    document.body.innerHTML = "<main></main>";
    const main = document.querySelector("main")!;
    const at = await settledAfter((tick) => main.setAttribute("class", `frame-${tick}`));
    expect(at).toBe(5000);
  });
});
