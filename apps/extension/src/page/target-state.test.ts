import { afterEach, describe, expect, it } from "vitest";
import { targetState } from "./target-state";

// Runs in Chromium (vitest browser mode) so layout and computed styles decide what shows.
const page = (html: string) => {
  document.body.innerHTML = html;
};
afterEach(() => {
  document.body.innerHTML = "";
});
const password = { by: "id", value: "pw" } as const;
const signIn = { by: "id", value: "sign-in" } as const;

describe("targetState", () => {
  // An identifier-first form that swaps in its password view in the same document, as
  // Microsoft Entra's (2026-10-17): its email view keeps an off-screen, transparent password
  // input hidden from assistive technology for the browser to fill.
  const emailView = `<form id="email-view">
      <input id="email" type="email" aria-label="Email">
      <input id="pw" type="password" aria-hidden="true" tabindex="-1"
        style="position:absolute;left:-10000px;opacity:0">
      <button id="next" type="submit">Next</button>
      <button id="sign-in" type="button" aria-hidden="true">Sign in</button>
    </form>`;

  it("counts an input kept for the browser as usable, but not as described", () => {
    page(emailView);
    // The step's own wait takes it, so an advance measured with it never confirms.
    expect(targetState(document, password, "writable")).toBe("unique");
    expect(targetState(document, password, "described-writable")).toBe("unusable");
    expect(targetState(document, signIn, "clickable")).toBe("unique");
    expect(targetState(document, signIn, "described-clickable")).toBe("unusable");
    expect(targetState(document, password, "present")).toBe("unique");
  });

  it("counts the password view's input as described while it fades and slides in", () => {
    page(emailView);
    document.getElementById("email-view")!.remove();
    document.body.insertAdjacentHTML(
      "beforeend",
      `<form id="password-view" style="opacity:0">
        <input id="pw" type="password" aria-label="Password">
        <button id="sign-in" type="submit">Sign in</button>
      </form>`,
    );
    const view = document.getElementById("password-view")!;
    view
      .animate(
        [
          { opacity: 0, transform: "translateX(100%)" },
          { opacity: 1, transform: "none" },
        ],
        { duration: 5000, fill: "forwards" },
      )
      .pause();
    expect(getComputedStyle(view).opacity).toBe("0");
    expect(targetState(document, password, "described-writable")).toBe("unique");
    expect(targetState(document, signIn, "described-clickable")).toBe("unique");
  });

  it("refuses a disabled, transparent or tiny input as described", () => {
    for (const style of ["opacity:0", "width:1px;height:1px;padding:0;border:0"]) {
      page(`<input id="pw" type="password" style="${style}">`);
      expect(targetState(document, password, "writable"), style).toBe("unique");
      expect(targetState(document, password, "described-writable"), style).toBe("unusable");
    }
    page(`<input id="pw" type="password" disabled>`);
    expect(targetState(document, password, "described-writable")).toBe("unusable");
    page(`<input id="pw" type="password"><input id="pw" type="password">`);
    expect(targetState(document, password, "described-writable")).toBe("ambiguous");
  });
});
