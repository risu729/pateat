import { afterEach, describe, expect, it } from "vitest";
import type { TargetRequirement } from "../login/wire";
import { targetCheck, targetState } from "./target-state";

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

  // For the log (ADR 0019): why an advance on its next step's own path was not confirmed.
  it("counts an inert control, or one inside an inert element, as not clickable (#853)", () => {
    page(`<a href="javascript:void(0)" id="sign-in" inert>Log in</a>`);
    expect(targetState(document, signIn, "clickable")).toBe("unusable");
    expect(targetCheck(document, signIn, "clickable")).toBe("not-clickable");
    // The page lifts it once the fields are filled.
    document.getElementById("sign-in")!.removeAttribute("inert");
    expect(targetState(document, signIn, "clickable")).toBe("unique");
    page(`<div inert><button id="sign-in">Log in</button></div>`);
    expect(targetState(document, signIn, "clickable")).toBe("unusable");
  });

  it("names the check that decided each state, as codes", () => {
    const check = (html: string, require: TargetRequirement = "described-writable") => {
      page(html);
      return targetCheck(document, password, require);
    };
    expect(check(`<input id="pw" type="password">`)).toBe("ok");
    expect(check(`<input id="other" type="password">`)).toBe("missing");
    expect(check(`<input id="pw" type="password"><input id="pw" type="password">`)).toBe(
      "matches-2",
    );
    expect(check(`<input id="pw"><input id="pw"><input id="pw">`.repeat(4))).toBe("matches-9");
    // Not seen at all is told apart from shown but taking no input.
    expect(check(`<div hidden><input id="pw" type="password"></div>`)).toBe("hidden-attr");
    expect(check(`<input id="pw" type="password" hidden>`, "writable")).toBe("hidden-attr");
    expect(check(`<div style="display:none"><input id="pw" type="password"></div>`)).toBe(
      "not-rendered",
    );
    expect(check(`<input id="pw" type="password" style="visibility:hidden">`)).toBe("not-rendered");
    expect(
      check(`<button id="pw" type="button" style="display:none">Next</button>`, "clickable"),
    ).toBe("not-rendered");
    expect(check(`<input id="pw" type="password" disabled>`)).toBe("not-writable");
    expect(check(`<input id="pw" type="password" readonly>`)).toBe("not-writable");
    expect(
      check(`<button id="pw" type="button" disabled>Next</button>`, "described-clickable"),
    ).toBe("not-clickable");
    expect(check(`<div aria-hidden="true"><input id="pw" type="password"></div>`)).toBe(
      "hidden-attr",
    );
    expect(check(`<div inert><input id="pw" type="password"></div>`)).toBe("hidden-attr");
    expect(check(`<div style="opacity:0"><input id="pw" type="password"></div>`)).toBe(
      "transparent",
    );
    expect(
      check(`<input id="pw" type="password" style="width:1px;height:1px;padding:0;border:0">`),
    ).toBe("tiny");
    expect(check(`<input id="pw" type="password" style="position:absolute;left:-10000px">`)).toBe(
      "off-start",
    );
    // The input the email view keeps for the browser: hidden from assistive technology first.
    page(emailView);
    expect(targetCheck(document, password, "described-writable")).toBe("hidden-attr");
    expect(targetCheck(document, password, "present")).toBe("ok");
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

      it("reads hidden text and refuses a text too long to read in full", () => {
        for (const html of [
          `<a href="#" aria-label="Select Password."><span aria-hidden="true">Send code</span></a>`,
          `<button type="button" aria-label="Select Password.">Select<span hidden>Sign out</span></button>`,
          `<a href="#" aria-label="Select Password.">Send a code to your phone${" now".repeat(40)}</a>`,
          `<a href="#" aria-label="Select Password.">${"Select ".repeat(80)}</a>`,
        ]) {
          choice(html);
          expect(targetState(document, named, "clickable"), html).toBe("unique");
          expect(targetState(document, named, "password-choice"), html).toBe("unusable");
        }
        // A neutral text longer than a button's text still counts when it is read in full.
        choice(`<a href="#" aria-label="Select Password.">${"Select ".repeat(30)}</a>`);
        expect(targetState(document, named, "password-choice")).toBe("unique");
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
