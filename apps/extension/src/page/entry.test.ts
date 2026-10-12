import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { entryElementRefusal, entryHosts, renderedControlText, showsSignUp } from "./entry";

// Runs in Chromium (vitest browser mode) so layout and visibility are real. Synthetic
// hosts only.
let path: string;
beforeEach(() => {
  path = location.pathname + location.search;
});
afterEach(() => {
  history.replaceState(null, "", path);
  document.body.innerHTML = "";
});
const first = <T extends Element>(selector: string) => document.querySelector<T>(selector)!;

describe("entryHosts", () => {
  it("lists the hosts the page's query and its navigating links name, once each", () => {
    history.replaceState(
      null,
      "",
      `${location.pathname}?return_to=%2Fbookmarks&ref=https%3A%2F%2Fref.example%2F`,
    );
    document.body.innerHTML = `
      <a href="https://accounts.synthetic.example/login?next=%2F%2Fevil.example%2F">Login</a>
      <a href="https://accounts.synthetic.example/signup">Create account</a>
      <a href="javascript:void 0">Script</a>
      <a>No href</a>
      <a href="https://other.example/">Other</a>`;
    expect(entryHosts(document)).toEqual([
      location.hostname,
      "ref.example",
      "accounts.synthetic.example",
      "evil.example",
      "other.example",
    ]);
  });
});

describe("entryElementRefusal", () => {
  it.each([
    [`<a id="t" href="https://accounts.synthetic.example/login">Login</a>`, undefined],
    [
      `<a id="t" href="https://accounts.synthetic.example/login" target="_self">Login</a>`,
      undefined,
    ],
    [
      `<a id="t" href="https://accounts.synthetic.example/login" target=" _SELF ">Login</a>`,
      undefined,
    ],
    [
      `<a id="t" href="https://accounts.synthetic.example/login" target="_blank">Login</a>`,
      "new-window",
    ],
    [
      `<a id="t" href="https://accounts.synthetic.example/login" target="_top">Login</a>`,
      "new-window",
    ],
    [`<button id="t">Login</button>`, "not-link"],
    [`<a id="t">Login</a>`, "not-link"],
    [`<a id="t" href="javascript:void 0">Login</a>`, "script-link"],
    [`<a id="t" href="#" onclick="return false">Login</a>`, "script-link"],
    [`<a id="t" href="https://accounts.synthetic.example/login" hidden>Login</a>`, "hidden"],
    [
      `<a id="t" href="https://accounts.synthetic.example/login" style="visibility: hidden">Login</a>`,
      "hidden",
    ],
    [
      `<a id="t" href="https://accounts.synthetic.example/login"><img alt="Login" src="data:,"></a>`,
      "no-text",
    ],
    [`<a id="t" href="JavaScript:void 0">Login</a>`, "script-link"],
    [`<a id="t" href=" javascript:void 0">Login</a>`, "script-link"],
    [`<a id="t" href="java&#9;script:void 0">Login</a>`, "script-link"],
    [
      `<a id="t" href="https://accounts.synthetic.example/login" style="opacity: 0">Login</a>`,
      "hidden",
    ],
    [
      `<div style="display: none"><a id="t" href="https://accounts.synthetic.example/login">Login</a></div>`,
      "hidden",
    ],
    [
      `<div inert><a id="t" href="https://accounts.synthetic.example/login">Login</a></div>`,
      "hidden",
    ],
    [
      `<div aria-hidden="true"><a id="t" href="https://accounts.synthetic.example/login">Login</a></div>`,
      "hidden",
    ],
    [
      `<details><summary>Menu</summary><a id="t" href="https://accounts.synthetic.example/login">Login</a></details>`,
      "hidden",
    ],
    [
      `<a id="t" href="https://accounts.synthetic.example/login" aria-label="Login"><svg width="10" height="10"></svg></a>`,
      "no-text",
    ],
    [
      `<a id="t" href="https://accounts.synthetic.example/login"><span hidden>Login</span>&nbsp;</a>`,
      "no-text",
    ],
    // An empty target is refused too: only a missing one or `_self` keeps the press in the tab.
    [`<a id="t" href="https://accounts.synthetic.example/login" target="">Login</a>`, "new-window"],
    [
      `<a id="t" href="https://accounts.synthetic.example/login" target="_parent">Login</a>`,
      "new-window",
    ],
  ])("%s", (html, refusal) => {
    document.body.innerHTML = html;
    expect(entryElementRefusal(first("#t"))).toBe(refusal);
  });
});

describe("renderedControlText", () => {
  it("reads rendered text, an input's value, and never an image's alt", () => {
    document.body.innerHTML = `
      <a id="a" href="/x">  Log
        in <img alt="icon" src="data:,"></a>
      <input id="b" type="submit" value="Sign in">
      <input id="c" type="image" alt="Sign in" src="data:,">
      <a id="d" href="/x"><img alt="Sign in" src="data:,"></a>`;
    expect(renderedControlText(first("#a"))).toBe("Log in");
    expect(renderedControlText(first("#b"))).toBe("Sign in");
    expect(renderedControlText(first("#c"))).toBeUndefined();
    expect(renderedControlText(first("#d"))).toBeUndefined();
  });
});

describe("showsSignUp", () => {
  it.each([
    [
      "a sign-in form",
      `<form><input autocomplete="username"><input type="password" autocomplete="current-password"></form>`,
      false,
    ],
    [
      "a lone new-password field",
      `<form><input autocomplete="username"><input type="password" autocomplete="new-password"></form>`,
      false,
    ],
    [
      "a new password beside its confirmation",
      `<form><input type="password" autocomplete="new-password"><input type="password"></form>`,
      true,
    ],
    [
      "two password fields in one form",
      `<form><input type="password"><input type="password"></form>`,
      true,
    ],
    [
      "two password fields outside any form",
      `<input type="password"><input type="password">`,
      true,
    ],
    [
      "one password field in each of two forms",
      `<form><input type="password"></form><form><input type="password"></form>`,
      false,
    ],
    [
      "a hidden confirmation field",
      `<form><input type="password" autocomplete="new-password"><input type="password" hidden></form>`,
      false,
    ],
    [
      "a new password shown as text, in capitals, beside a password field",
      `<form><input type="text" autocomplete="New-Password"><input type="password"></form>`,
      true,
    ],
    [
      "two password fields joined to one form by its `form` attribute",
      `<form id="f"></form><input type="password" form="f"><input type="password" form="f">`,
      true,
    ],
    [
      "a sectioned new password beside a confirmation not displayed",
      `<form><input type="password" autocomplete="section-a new-password"><input type="password" style="display: none"></form>`,
      false,
    ],
  ])("%s", (_label, html, expected) => {
    document.body.innerHTML = html;
    expect(showsSignUp(document)).toBe(expected);
  });
});
