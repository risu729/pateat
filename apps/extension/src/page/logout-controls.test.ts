import { afterEach, describe, expect, it } from "vitest";
import {
  findLogoutTargets,
  localLogoutControl,
  logoutControlName,
  logoutName,
  shownLayers,
} from "./logout-controls";

// Runs in Chromium (vitest browser mode): an account switch's logout controls (ADR 0063).
const page = (html: string) => {
  document.body.innerHTML = html;
};
afterEach(() => {
  document.body.innerHTML = "";
});

describe("logout words", () => {
  it.each([
    "Log out",
    "Logout",
    "LOG OFF",
    "Sign out",
    "sign-off",
    "Ｌｏｇ ｏｕｔ",
    "ログアウト",
    "サインアウトする",
    "ログオフ",
    "サインオフ",
    "Sign out and use another account",
  ])("reads %s as a logout", (name) => {
    expect(logoutName(name)).toBe("logout");
  });

  it.each([
    "Log out of other devices",
    "Sign out of all other sessions",
    "Sign out everywhere else",
    "Log out all devices except this one",
    "Sign out other accounts",
    "このデバイス以外からログアウト",
    "他の端末からログアウト",
    "ほかのアカウントからログアウト",
  ])("reads %s as a logout elsewhere", (name) => {
    expect(logoutName(name)).toBe("elsewhere");
  });

  it.each(["Logo", "Sign up", "Outlook", "Blogout", "Checkout", "Log in"])(
    "reads %s as no logout",
    (name) => {
      expect(logoutName(name)).toBeUndefined();
    },
  );
});

describe("the page's own logout control", () => {
  it("finds the one shown control that says it logs out, by its text, label, title or icon", () => {
    for (const html of [
      `<header><a href="/home">Home</a><button type="button">Log out</button></header>`,
      `<nav><a href="/bye" aria-label="Sign out"><svg></svg></a></nav>`,
      `<nav><button type="button" title="ログアウト"><img alt="" src="data:,"></button></nav>`,
      `<nav><button type="button"><img alt="Sign out" src="data:,"></button></nav>`,
      `<ul role="menu"><li role="menuitem" tabindex="-1"><span>Log out</span></li></ul>`,
    ]) {
      page(html);
      const found = localLogoutControl(document);
      expect(found, html).toBeInstanceOf(HTMLElement);
    }
  });

  it("finds none in fields, labels, settings, hidden controls or long text, and ambiguity in two", () => {
    page(`
      <label><input type="checkbox"> Log out when I close the browser</label>
      <div role="switch" aria-checked="false" tabindex="0">Sign out after an hour</div>
      <button type="button" hidden>Log out</button>
      <button type="button" style="display: none">Sign out</button>
      <button type="button">Log out of other devices</button>
      <p>To sign out, use the menu.</p>
      <button type="button">${"Read how to log out of this site safely and quickly ".repeat(3)}</button>
    `);
    expect(localLogoutControl(document)).toBe("none");
    page(`<header><button type="button">Log out</button></header>
      <footer><a href="/logout">Sign out</a></footer>`);
    expect(localLogoutControl(document)).toBe("ambiguous");
  });

  it("takes the inner control of a menu item that holds a link saying the same", () => {
    page(`<ul role="menu"><li role="menuitem"><a href="/logout" id="out">Log out</a></li></ul>`);
    expect(localLogoutControl(document)).toBe(document.getElementById("out"));
  });
});

describe("logout click locators", () => {
  it("names menu items by their text and icon-only controls by aria-label or title", () => {
    page(`
      <button type="button" aria-label="Account menu"><svg></svg></button>
      <a href="/settings" title="Settings"><svg></svg></a>
      <ul role="menu"><li role="menuitem">Sign out</li></ul>
    `);
    const [menu] = findLogoutTargets(document, { by: "accessible-name", value: "Account menu" });
    expect(menu).toBe(document.querySelector("button"));
    expect(logoutControlName(menu!)).toBe("Account menu");
    expect(findLogoutTargets(document, { by: "accessible-name", value: "Settings" })).toEqual([
      document.querySelector("a"),
    ]);
    expect(findLogoutTargets(document, { by: "text", value: "Sign out" })).toEqual([
      document.querySelector("li"),
    ]);
  });

  it("counts the dialogs and menus the page shows", () => {
    page(`<div role="menu" hidden></div><div role="dialog" aria-modal="true">Sure?</div>`);
    expect(shownLayers(document)).toBe(1);
    document.querySelector("[role='menu']")!.removeAttribute("hidden");
    expect(shownLayers(document)).toBe(2);
  });
});
