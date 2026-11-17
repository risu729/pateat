import { afterEach, describe, expect, it, vi } from "vitest";
import { cdp, userEvent } from "vitest/browser";
import { observedPath } from "../observation/path";
import { installLoginContent } from "./content";
import { watchPersonSteps } from "./person-step";

const { sent } = vi.hoisted(() => ({ sent: [] as Record<string, unknown>[] }));
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
    sent.push(message);
    return { ok: false, reason: "recipe-not-found", starts: [] };
  },
}));

// The person's own sign-in step in the tab's top document (ADR 0034 amendment of
// 2026-11-17), read in Chromium for real trusted input. The test page is a frame of the
// runner, so `top` stands in for the tab's top document.
let stop: (() => void) | undefined;
const home = location.pathname;
afterEach(() => {
  stop?.();
  stop = undefined;
  document.body.innerHTML = "";
  sent.length = 0;
  history.replaceState(null, "", home);
});

function page(html: string, top = true) {
  document.body.innerHTML = html;
  // The test page itself stays.
  for (const form of document.forms) form.addEventListener("submit", (e) => e.preventDefault());
  const report = vi.fn();
  stop = watchPersonSteps(document, report, { top });
  return report;
}
const emailForm = (value = "person@login.example", style = "") => `
  <div id="banner">Accept cookies</div><input id="search" placeholder="Search">
  <form id="email"><input id="address" type="email" value="${value}" style="${style}">
  <button id="next">Next</button><button id="show" type="button">Show</button></form>`;
const $ = <T extends Element = HTMLElement>(selector: string) =>
  document.querySelector<T>(selector)!;

describe("the person's own sign-in step", () => {
  it("is a real click on the form's submit button, or a real Enter in its input", async () => {
    const clicked = page(emailForm());
    await userEvent.click($("#show"));
    expect(clicked).not.toHaveBeenCalled();
    await userEvent.click($("#next"));
    expect(clicked).toHaveBeenCalledOnce();
    stop?.();
    const entered = page(emailForm(""));
    await userEvent.type($("#address"), "person@login.example{Enter}");
    // The Enter, and the click on Next the browser makes for it; each says the same.
    expect(entered).toHaveBeenCalled();
    stop?.();
    const user = page(`<form><input id="user" autocomplete="username" value="person"></form>`);
    await userEvent.type($("#user"), "{Enter}");
    expect(user).toHaveBeenCalledOnce();
  });

  it("is no submit or click a script makes while the person's activation lasts", async () => {
    const report = page(emailForm());
    // The person clicks something else, as a cookie banner, or types in a search box.
    await userEvent.click($("#banner"));
    await userEvent.type($("#search"), "x");
    expect(navigator.userActivation.isActive).toBe(true);
    const form = $<HTMLFormElement>("#email");
    form.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));
    form.requestSubmit();
    $("#next").click();
    $("#address").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(report).not.toHaveBeenCalled();
  });

  it("is no other key in the form's input", async () => {
    const report = page(emailForm());
    await userEvent.type($("#address"), "x");
    await userEvent.keyboard("{Tab}");
    expect(report).not.toHaveBeenCalled();
  });

  it("is no Enter that ends an input method's composition", async () => {
    const report = page(emailForm(""));
    await userEvent.click($("#address"));
    const session = cdp();
    await session.send("Input.imeSetComposition", {
      text: "あ",
      selectionStart: 1,
      selectionEnd: 1,
    });
    const composing = vi.fn();
    $("#address").addEventListener("keydown", (event) => composing(event.isComposing));
    await session.send("Input.dispatchKeyEvent", {
      type: "rawKeyDown",
      key: "Enter",
      code: "Enter",
      windowsVirtualKeyCode: 13,
    });
    await session.send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "Enter",
      code: "Enter",
      windowsVirtualKeyCode: 13,
    });
    expect(composing).toHaveBeenCalledWith(true);
    expect(report).not.toHaveBeenCalled();
  });

  it("needs a shown identifier or password input that holds a value", async () => {
    for (const html of [
      emailForm(""),
      emailForm("person@login.example", "display:none"),
      `<form><input id="q" value="shoes"><input type="hidden" autocomplete="username" value="x">
        <button id="next">Find</button></form>`,
    ]) {
      const report = page(html);
      // eslint-disable-next-line no-await-in-loop
      await userEvent.click($("#next"));
      expect(report).not.toHaveBeenCalled();
      stop?.();
    }
    const password = page(`<form><input type="password" value="secret">
      <button id="next">Sign in</button></form>`);
    await userEvent.click($("#next"));
    expect(password).toHaveBeenCalledOnce();
  });

  it("is never a frame's", async () => {
    const report = page(emailForm(), false);
    await userEvent.click($("#next"));
    expect(report).not.toHaveBeenCalled();
  });

  it("is reported by the login content script with the page's observed path only", async () => {
    // A path with a segment that may carry a token, which the report leaves out.
    history.replaceState(null, "", "/reset/3f2b8c1d4e5a6b7c8d9e0f1a2b3c4d5e/password");
    expect(observedPath(location.pathname)).not.toBe(location.pathname);
    document.body.innerHTML = emailForm();
    $<HTMLFormElement>("#email").addEventListener("submit", (e) => e.preventDefault());
    stop = installLoginContent({ top: true });
    await userEvent.click($("#next"));
    await vi.waitFor(() =>
      expect(sent.filter((message) => message["type"] === "login.document.person-step")).toEqual([
        {
          version: 1,
          type: "login.document.person-step",
          token: expect.any(String),
          path: observedPath(location.pathname),
        },
      ]),
    );
  });
});
