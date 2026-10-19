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

  // A page that asks how to confirm the sign-in (ADR 0048): the button is pressed only
  // while its rendered text names the password choice.
  describe("a button that goes on to the password", () => {
    const choose = { by: "id", value: "choose" } as const;

    it("takes a shown button whose text names the password, enabled or not", () => {
      for (const html of [
        `<button id="choose" type="button">Password</button>`,
        `<button id="choose" type="button" disabled><span>Use your</span> password</button>`,
        `<div id="choose" role="button">パスワードでログイン</div>`,
        `<input id="choose" type="button" value="Sign in with password">`,
      ]) {
        page(html);
        expect(targetState(document, choose, "password-choice"), html).toBe("unique");
      }
    });

    it("refuses another way, a hidden button and an element that is no button", () => {
      for (const html of [
        `<button id="choose" type="button">Mobile</button>`,
        `<button id="choose" type="button">Forgot password?</button>`,
        `<button id="choose" type="button">ワンタイムパスワード</button>`,
        `<button id="choose" type="button" hidden>Password</button>`,
        `<span id="choose">Password</span>`,
        `<a id="choose" href="/password">Password</a>`,
      ]) {
        page(html);
        expect(targetState(document, choose, "password-choice"), html).toBe("unusable");
      }
      // The page shows the button's text, whatever its locator says.
      page(`<button id="choose" type="button" aria-label="Password">Text me a code</button>`);
      expect(targetState(document, choose, "password-choice")).toBe("unusable");
    });

    // ADR 0048 amendment of 2026-10-19: controls that show the same neutral text.
    describe("named by its accessible name", () => {
      const named = { by: "accessible-name", value: "Select Password." } as const;
      const phone = { by: "accessible-name", value: "Select Phone" } as const;
      const choice = (control: string) =>
        page(`<form>${control}<a href="#" aria-label="Select Phone">Select</a></form>`);

      it("takes a neutral text whose name names the password, a fragment link too", () => {
        for (const html of [
          `<a href="#" aria-label="Select Password.">Select</a>`,
          `<button type="button" aria-label="Select Password.">Select</button>`,
          `<div role="button" aria-label="Select Password.">Choose</div>`,
          `<a href="#" aria-label="Select Password."><svg width="20" height="20"></svg></a>`,
        ]) {
          choice(html);
          expect(targetState(document, named, "password-choice"), html).toBe("unique");
          expect(targetState(document, named, "clickable"), html).toBe("unique");
          expect(targetState(document, phone, "password-choice"), html).toBe("unusable");
        }
      });

      it("refuses a visible text with a refused word, and a name that names another way", () => {
        for (const html of [
          `<button type="button" aria-label="Select Password.">Send code</button>`,
          `<a href="#" aria-label="Select Password.">Use mobile</a>`,
        ]) {
          choice(html);
          expect(targetState(document, named, "password-choice"), html).toBe("unusable");
        }
        // A text that names the password is not enough when the name names another way.
        page(`<button id="choose" type="button" aria-label="Select Phone">Password</button>`);
        expect(targetState(document, choose, "password-choice")).toBe("unusable");
      });

      it("counts a fragment link as clickable only through its accessible name", () => {
        page(`<a id="choose" href="#" aria-label="Select Password.">Select</a>`);
        expect(targetState(document, named, "clickable")).toBe("unique");
        expect(targetState(document, named, "described-clickable")).toBe("unique");
        expect(targetState(document, choose, "clickable")).toBe("unusable");
        expect(targetState(document, choose, "password-choice")).toBe("unusable");
        // A link that opens elsewhere is no control at all.
        page(`<a href="#" target="_blank" aria-label="Select Password.">Select</a>`);
        expect(targetState(document, named, "password-choice")).toBe("missing");
        page(`<a href="#" aria-label="Select Password." aria-disabled="true">Select</a>`);
        expect(targetState(document, named, "clickable")).toBe("unusable");
      });
    });
  });
});
