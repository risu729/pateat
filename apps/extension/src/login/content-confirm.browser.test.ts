import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { observedPath } from "../observation/path";
import { installLoginContent } from "./content";

const { sent, reply } = vi.hoisted(() => ({
  sent: [] as Record<string, unknown>[],
  reply: {
    value: {} as Record<string, unknown>,
    /** The answer while the page shows another path than the test page's own. */
    elsewhere: undefined as Record<string, unknown> | undefined,
    home: "",
  },
}));

vi.mock("wxt/browser", () => ({
  browser: {
    runtime: {
      id: "synthetic-extension",
      onMessage: { addListener: () => undefined, removeListener: () => undefined },
    },
  },
}));
vi.mock("../messaging/protocol", () => ({
  sendMessage: async (_channel: string, message: Record<string, unknown>) => {
    sent.push({ ...message, at: location.pathname });
    return reply.elsewhere && location.pathname !== reply.home ? reply.elsewhere : reply.value;
  },
}));

let uninstall: (() => void) | undefined;
beforeEach(() => {
  sent.length = 0;
  reply.elsewhere = undefined;
  reply.home = location.pathname;
});
afterEach(() => {
  uninstall?.();
  uninstall = undefined;
  vi.useRealTimers();
  document.body.innerHTML = "";
});

const path = () => observedPath(location.pathname);
const ready = () => sent.filter((message) => message["type"] === "login.document.ready");

describe("a page Pateat does not fill (ADR 0035)", () => {
  it("reports its first step shown at once, whether its form shows an amount, and the person's submit", async () => {
    reply.value = {
      ok: false,
      reason: "recipe-not-found",
      starts: [],
      confirm: { path: path(), require: "writable", targets: [{ by: "id", value: "code" }] },
    };
    document.body.innerHTML = `<main><form id="pay">
      <p>Total <span>¥1,200</span></p>
      <label>Code <input id="code" autocomplete="one-time-code" value="9999"></label>
      <button id="confirm">Confirm</button></form>
      <form id="search"><input id="q"><button id="go">Search</button></form></main>`;
    // The page itself stays: the test page must not navigate.
    for (const form of document.forms) form.addEventListener("submit", (e) => e.preventDefault());
    uninstall = installLoginContent();
    await vi.waitFor(() =>
      expect(ready()).toContainEqual(
        expect.objectContaining({ shown: { path: path(), amount: true } }),
      ),
    );
    // An event a script makes is not the person's submit, nor is a submit of another form.
    const submitted = () =>
      sent.filter((message) => message["type"] === "login.document.person-submitted");
    document.querySelector("#pay")!.dispatchEvent(new SubmitEvent("submit", { bubbles: true }));
    await userEvent.click(document.querySelector("#go")!);
    expect(submitted()).toEqual([]);
    await userEvent.click(document.querySelector("#confirm")!);
    await userEvent.click(document.querySelector("#confirm")!);
    await vi.waitFor(() =>
      expect(submitted()).toEqual([
        {
          version: 1,
          type: "login.document.person-submitted",
          token: expect.any(String),
          at: expect.any(String),
        },
      ]),
    );
    // Nothing of the page's text or values is sent.
    expect(JSON.stringify(sent)).not.toMatch(/1,200|9999|Confirm/u);
  });

  it("reports its first step once all of it shows, with no amount outside the step's form", async () => {
    reply.value = {
      ok: false,
      reason: "recipe-not-found",
      starts: [],
      confirm: {
        path: path(),
        require: "writable",
        targets: [
          { by: "id", value: "code" },
          { by: "id", value: "loose" },
        ],
      },
    };
    document.body.innerHTML = `<main><p>¥1,200</p><form><input id="code"></form></main>`;
    uninstall = installLoginContent();
    await vi.waitFor(() => expect(ready().length).toBe(1));
    document.body.insertAdjacentHTML("beforeend", `<input id="loose">`);
    await vi.waitFor(() =>
      expect(ready()).toContainEqual(
        expect.objectContaining({ shown: { path: path(), amount: false } }),
      ),
    );
  });

  it("reports no amount when its first step is in no form", async () => {
    reply.value = {
      ok: false,
      reason: "recipe-not-found",
      starts: [],
      confirm: { path: path(), require: "writable", targets: [{ by: "id", value: "code" }] },
    };
    document.body.innerHTML = `<main><p>¥1,200</p><input id="code"></main>`;
    uninstall = installLoginContent();
    await vi.waitFor(() =>
      expect(ready()).toContainEqual(expect.objectContaining({ shown: { path: path() } })),
    );
  });

  it("announces a move in place and back, then reports its first step and the person's submit again", async () => {
    const home = location.pathname;
    reply.value = {
      ok: false,
      reason: "recipe-not-found",
      starts: [],
      confirm: { path: path(), require: "writable", targets: [{ by: "id", value: "code" }] },
    };
    // The worker names no first step on the other path.
    reply.elsewhere = { ok: false, reason: "recipe-not-found", starts: [] };
    const announced = () =>
      ready()
        .filter((message) => !message["shown"])
        .map((message) => message["at"]);
    document.body.innerHTML = `<form id="pay"><input id="code"><button id="confirm">Confirm</button></form>`;
    document.forms[0]!.addEventListener("submit", (e) => e.preventDefault());
    uninstall = installLoginContent();
    const shownCount = () => ready().filter((message) => message["shown"]).length;
    const submitted = () =>
      sent.filter((message) => message["type"] === "login.document.person-submitted").length;
    await vi.waitFor(() => expect(shownCount()).toBe(1));
    await userEvent.click(document.querySelector("#confirm")!);
    expect(submitted()).toBe(1);
    try {
      history.pushState(null, "", "/pateat-elsewhere");
      // The worker hears of the other path, so it logs the visit as left.
      await vi.waitFor(() => expect(announced()).toEqual([home, "/pateat-elsewhere"]));
      await userEvent.click(document.querySelector("#confirm")!);
      expect(submitted()).toBe(1);
      history.pushState(null, "", home);
      await vi.waitFor(() => expect(announced()).toEqual([home, "/pateat-elsewhere", home]));
      await vi.waitFor(() => expect(shownCount()).toBe(2));
      await userEvent.click(document.querySelector("#confirm")!);
      expect(submitted()).toBe(2);
    } finally {
      history.replaceState(null, "", home);
    }
  });
});

describe("a page that looks like a verification but is not sent (ADR 0035)", () => {
  it("reports a secret answer of type text asked before an action, the person signed in earlier", async () => {
    vi.useFakeTimers();
    reply.value = { ok: false, reason: "recipe-not-found", starts: [], generate: true };
    // A profile change asks the secret question; nothing was submitted in this page.
    document.body.innerHTML = `<main><h1>Change your profile</h1><form>
      <label for="a">Answer to your secret question</label><input id="a" type="text">
      <button>Save</button></form></main>`;
    uninstall = installLoginContent();
    await vi.advanceTimersByTimeAsync(10_100);
    expect(ready()).toContainEqual(
      expect.objectContaining({ unoffered: { path: path(), why: "text-answer" } }),
    );
  });

  it("reports a secret question right after this page's password submit as part of the sign-in", async () => {
    vi.useFakeTimers();
    const home = location.pathname;
    reply.value = { ok: false, reason: "recipe-not-found", starts: [], generate: true };
    // A password form the page itself submits, before Pateat would offer it.
    document.body.innerHTML = `<form id="signin"><input type="password" disabled><button>Sign in</button></form>`;
    uninstall = installLoginContent();
    await vi.advanceTimersByTimeAsync(0);
    document.forms[0]!.dispatchEvent(new SubmitEvent("submit", { bubbles: true }));
    try {
      // The site asks its secret question next, in place.
      history.pushState(null, "", "/pateat-question");
      document.body.innerHTML = `<form><label for="a">秘密の質問の答え</label><input id="a" type="text"></form>`;
      await vi.advanceTimersByTimeAsync(10_100);
      const reasons = ready().flatMap((message) =>
        message["unoffered"] ? [(message["unoffered"] as { why: string }).why] : [],
      );
      expect(reasons).toContain("after-sign-in");
      expect(reasons).not.toContain("text-answer");
    } finally {
      history.replaceState(null, "", home);
    }
  });

  it("reports a frame the worker asks about once a later reading finds a secret answer", async () => {
    vi.useFakeTimers();
    reply.value = { ok: false, reason: "recipe-not-found", frame: true };
    document.body.innerHTML = `<main><p>Loading</p></main>`;
    uninstall = installLoginContent();
    await vi.advanceTimersByTimeAsync(0);
    expect(ready()).toHaveLength(1);
    document.body.insertAdjacentHTML(
      "beforeend",
      `<form><input type="text" name="secret_answer" aria-label="Secret answer"></form>`,
    );
    // The frame is read again a second later, not on each change.
    expect(ready()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(ready()).toContainEqual(
      expect.objectContaining({ unoffered: { path: path(), why: "frame" } }),
    );
    await vi.advanceTimersByTimeAsync(10_000);
    expect(ready().filter((message) => message["unoffered"])).toHaveLength(1);
  });

  it("never reports a frame whose readings find nothing", async () => {
    vi.useFakeTimers();
    reply.value = { ok: false, reason: "recipe-not-found", frame: true };
    document.body.innerHTML = `<main><label>Your answer<input type="text"></label></main>`;
    uninstall = installLoginContent();
    await vi.advanceTimersByTimeAsync(11_000);
    expect(ready()).toHaveLength(1);
  });
});
