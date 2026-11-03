import { afterEach, describe, expect, it } from "vitest";
import {
  askDefinitions,
  ELEMENT_DEFINED,
  installMainWorldDefinitions,
} from "./element-definitions";
import { nextFrame } from "./frames";
import { pageChange } from "./page-change";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  document.body.innerHTML = "";
});

/** Resolves `"changed"` when `wait` resolves first, else `"pending"` after `ms`. */
async function raced(wait: Promise<void>, ms: number): Promise<"changed" | "pending"> {
  return Promise.race([
    wait.then(() => "changed" as const),
    new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), ms)),
  ]);
}

describe("nextFrame", () => {
  it("resolves after the page's animation frame callbacks queued before it", async () => {
    const order: string[] = [];
    requestAnimationFrame(() => order.push("page"));
    await nextFrame();
    order.push("after");
    expect(order).toEqual(["page", "after"]);
  });

  it("waits one task on a hidden page, which renders no frame", async () => {
    Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
    cleanups.push(() => Reflect.deleteProperty(document, "hidden"));
    let frame = false;
    const handle = requestAnimationFrame(() => (frame = true));
    cleanups.push(() => cancelAnimationFrame(handle));
    const started = performance.now();
    await nextFrame();
    expect(frame).toBe(false);
    expect(performance.now() - started).toBeLessThan(16);
  });
});

describe("pageChange", () => {
  it("resolves soon after a DOM change, long before its bound", async () => {
    const wait = pageChange(document, Date.now() + 5_000);
    const started = performance.now();
    document.body.append(document.createElement("input"));
    expect(await raced(wait, 1_000)).toBe("changed");
    expect(performance.now() - started).toBeLessThan(200);
  });

  it("stays pending while nothing changes, and resolves at its bound", async () => {
    const until = Date.now() + 150;
    const wait = pageChange(document, until);
    expect(await raced(wait, 60)).toBe("pending");
    await wait;
    expect(Date.now()).toBeGreaterThanOrEqual(until - 5);
  });

  it("hears an attribute change inside a shadow tree", async () => {
    document.body.innerHTML = `<div id="host"></div>`;
    const root = document.querySelector("#host")!.attachShadow({ mode: "open" });
    root.innerHTML = `<button id="go" disabled>Go</button>`;
    const wait = pageChange(document, Date.now() + 5_000);
    root.querySelector("#go")!.removeAttribute("disabled");
    expect(await raced(wait, 1_000)).toBe("changed");
  });

  it("hears a CSS transition ending, which changes no node", async () => {
    document.body.innerHTML = `<style>#menu { transition: opacity 30ms; opacity: 0 }
      #menu.open { opacity: 1 }</style><div id="menu">Menu</div>`;
    const menu = document.querySelector<HTMLElement>("#menu")!;
    // Reading the style starts the transition from it.
    expect(getComputedStyle(menu).opacity).toBe("0");
    menu.classList.add("open");
    // The class change is a DOM change of its own; the transition's end is heard next.
    await pageChange(document, Date.now() + 1_000);
    const wait = pageChange(document, Date.now() + 5_000);
    expect(await raced(wait, 1_000)).toBe("changed");
  });

  it("hears a same-document URL change", async () => {
    const before = location.href;
    cleanups.push(() => history.replaceState(null, "", before));
    const wait = pageChange(document, Date.now() + 5_000);
    history.pushState(null, "", "#next");
    expect(await raced(wait, 1_000)).toBe("changed");
  });

  it("resolves at once when it is stopped", async () => {
    const stop = new AbortController();
    const wait = pageChange(document, Date.now() + 5_000, stop.signal);
    stop.abort();
    expect(await raced(wait, 50)).toBe("changed");
  });

  it("hears the page define a custom element it has not defined yet", async () => {
    cleanups.push(installMainWorldDefinitions());
    const name = `x-change-${crypto.randomUUID().slice(0, 8)}`;
    document.body.innerHTML = `<${name}></${name}>`;
    const wait = pageChange(document, Date.now() + 5_000);
    // The upgrade attaches a shadow root and renders into it, which no observer reports.
    customElements.define(
      name,
      class extends HTMLElement {
        constructor() {
          super();
          this.attachShadow({ mode: "open" }).innerHTML = `<input type="password">`;
        }
      },
    );
    expect(await raced(wait, 1_000)).toBe("changed");
  });
});

describe("askDefinitions", () => {
  it("asks about each undefined name once and hears each definition", async () => {
    cleanups.push(installMainWorldDefinitions());
    const name = `x-ask-${crypto.randomUUID().slice(0, 8)}`;
    document.body.innerHTML = `<${name}></${name}><${name}></${name}><span></span>`;
    const asked: unknown[] = [];
    const listen = (event: Event) => asked.push((event as CustomEvent).detail);
    document.addEventListener("pateat-await-definition", listen);
    cleanups.push(() => document.removeEventListener("pateat-await-definition", listen));
    askDefinitions(document, []);
    askDefinitions(document, []);
    expect(asked).toEqual([name]);
    let defined = 0;
    const count = () => (defined += 1);
    addEventListener(ELEMENT_DEFINED, count);
    cleanups.push(() => removeEventListener(ELEMENT_DEFINED, count));
    customElements.define(name, class extends HTMLElement {});
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(defined).toBe(1);
  });

  it("asks about undefined names inside shadow trees", () => {
    const name = `x-inner-${crypto.randomUUID().slice(0, 8)}`;
    document.body.innerHTML = `<div id="host"></div>`;
    const root = document.querySelector("#host")!.attachShadow({ mode: "open" });
    root.innerHTML = `<${name}></${name}>`;
    const asked: unknown[] = [];
    const listen = (event: Event) => asked.push((event as CustomEvent).detail);
    document.addEventListener("pateat-await-definition", listen);
    cleanups.push(() => document.removeEventListener("pateat-await-definition", listen));
    askDefinitions(document, [root]);
    expect(asked).toEqual([name]);
  });
});
