import type { LoginObservation } from "@pateat/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listControls, otherAccountMiss } from "../page/account-list";
import { findTargets } from "../page/targets";
import {
  extractAccountListObservation,
  extractEntryObservation,
  extractLocalLogout,
  extractLoginObservation,
  extractLogoutObservation,
  extractPasskeyObservation,
  extractSignedInObservation,
  fieldsMissDetail,
} from "./extract";

import { registerLoginReaders } from "../../test/observation/login-readers";
import { registerLoginLocators } from "../../test/observation/login-locators";
import { registerLoginCandidates } from "../../test/observation/login-candidates";
import { registerLoginVisibility } from "../../test/observation/login-visibility";
import { registerLoginKnownFields } from "../../test/observation/login-known-fields";
import { registerLoginShadowRedaction } from "../../test/observation/login-shadow-redaction";
import { registerSignedInReaders } from "../../test/observation/signed-in-readers";
import { registerSignedInNearButtons } from "../../test/observation/signed-in-near-buttons";
import { registerSignedInCandidates } from "../../test/observation/signed-in-candidates";

/** Closed shadow roots, which a content script reaches through `dom.openOrClosedShadowRoot`. */
const closedRoots = vi.hoisted(() => new WeakMap<Element, ShadowRoot>());
vi.mock("wxt/browser", () => ({
  browser: {
    dom: {
      openOrClosedShadowRoot: (element: HTMLElement) =>
        closedRoots.get(element) ?? element.shadowRoot,
    },
  },
}));
/** Gives the element `selector` names a shadow root holding `html`. */
const shadow = (selector: string, html: string, mode: ShadowRootMode = "open") => {
  const host = document.querySelector(selector)!;
  const root = host.attachShadow({ mode });
  if (mode === "closed") closedRoots.set(host, root);
  root.innerHTML = html;
  return root;
};

// Runs in Chromium (vitest browser mode) so layout, visibility and labels are real.
const page = (html: string, title = "") => {
  document.title = title;
  document.body.innerHTML = html;
};
const observe = (): LoginObservation => {
  const result = extractLoginObservation();
  if (!result.ok) throw new Error(`no observation: ${result.reason}`);
  return result.observation;
};
const summary = (observation: LoginObservation) =>
  observation.candidates.map(({ id: _id, ...rest }) => rest);

let path: string;
beforeEach(() => {
  path = location.pathname + location.search;
});
afterEach(() => {
  history.replaceState(null, "", path);
  document.body.innerHTML = "";
});

describe("extractLoginObservation", () => {
  registerLoginReaders({ page, observe, summary });
  registerLoginLocators({ page, observe, summary });
  registerLoginCandidates({ page, shadow, observe, summary });
  registerLoginVisibility({ page, shadow, observe, summary });
  registerLoginKnownFields({ page, observe, summary });
  registerLoginShadowRedaction({ page, shadow, observe, summary });
});

describe("extractSignedInObservation", () => {
  const signedIn = (): LoginObservation => {
    const result = extractSignedInObservation();
    if (!result.ok) throw new Error(`no observation: ${result.reason}`);
    return result.observation;
  };

  registerSignedInReaders({ page, observe, summary, signedIn });
  registerSignedInNearButtons({ page, observe, signedIn });
  registerSignedInCandidates({ page, shadow, observe, summary, signedIn });
});

describe("extractAccountListObservation", () => {
  it("describes a saved-profile list without its addresses", () => {
    page(
      `<header><button>me@example.com</button></header>
      <h1>Sign in to Example</h1>
      <div role="list">
        <div role="link" tabindex="0"><span>Taro</span><span>taro@example.com</span><span>Last used</span></div>
        <div role="link" tabindex="0"><span>r***@example.com</span></div>
      </div>
      <div style="cursor: pointer"><span>Sign in with another profile</span></div>
      <a href="/signup">Sign up</a>`,
      "Sign in | Example",
    );
    const result = extractAccountListObservation();
    if (!result.ok) throw new Error(result.reason);
    const { observation } = result;
    expect(observation.accounts).toEqual(["Taro [email] Last used", "[email]"]);
    // Both are entries Pateat clicks itself.
    expect(observation.accountEntries).toBe(2);
    expect(observation.complete).toBe(true);
    expect(summary(observation)).toEqual([
      {
        role: "button",
        target: { by: "text", value: "Sign in with another profile" },
        label: "Sign in with another profile",
      },
      { role: "button", target: { by: "text", value: "Sign up" }, label: "Sign up" },
    ]);
    expect(JSON.stringify(observation)).not.toContain("example.com");
  });

  it("sends a passkey button beside the list, also one no text names (ADR 0079)", () => {
    page(
      `<h1>Sign in to Example</h1>
      <div role="list">
        <div role="link" tabindex="0"><span>taro@example.com</span></div>
      </div>
      <button>Sign in with another profile</button>
      <button id="passkey-login" aria-label="Sign in with a passkey"><svg></svg></button>`,
    );
    const result = extractAccountListObservation();
    if (!result.ok) throw new Error(result.reason);
    const targets = summary(result.observation).map((candidate) => candidate.target);
    expect(targets).toContainEqual({ by: "id", value: "passkey-login" });
    expect(targets).toContainEqual({ by: "text", value: "Sign in with another profile" });
    expect(targets.filter((target) => target.value === "passkey-login")).toHaveLength(1);
  });

  it("hides a saved profile named by a username as [account], everywhere", () => {
    // Instagram's saved profile on 2026-10-12, with a made-up username.
    page(
      `<h1>Welcome back, Taro.Yamada</h1>
      <div>
        <div>
          <div><div role="img"><svg></svg></div><div><span>taro.yamada</span></div></div>
          <div role="button"><div role="button" aria-label="Continue as taro.yamada">Continue</div></div>
        </div>
        <div role="button" aria-label="Use another profile">Use another profile</div>
        <a role="link" href="/accounts/emailsignup/">Create new account</a>
      </div>`,
    );
    // Without a matching name, nothing is listed.
    expect(extractAccountListObservation()).toEqual({ ok: false, reason: "no-candidates" });
    const result = extractAccountListObservation(document, ["taro.yamada"]);
    if (!result.ok) throw new Error(result.reason);
    const { observation } = result;
    expect(observation.accounts).toEqual(["[account]"]);
    // A name beside buttons is no entry: only a list button leads on from it.
    expect(observation.accountEntries).toBe(0);
    // The heading is a text beside the buttons too, which may name another account.
    expect(observation.headings).toEqual(["[account]"]);
    expect(summary(observation).map((candidate) => candidate.target)).toEqual([
      { by: "text", value: "Continue" },
      { by: "text", value: "Use another profile" },
      { by: "text", value: "Create new account" },
    ]);
    expect(JSON.stringify(observation).toLowerCase()).not.toContain("taro");
  });

  it("hides a name in every form it shows in, and other texts beside buttons", () => {
    page(
      `<main>
        <h1>ようこそ＠ＴＡＲＯ.yamadaさん</h1>
        <section><span>taro.yamada</span><button aria-label="Continue as taro.yamada">Continue</button></section>
        <section><span>hanako.s</span><button>Switch</button></section>
        <button>Use another profile</button><button>Use an app</button>
        <button>taro.yamadaとして続行</button><button>Retaro.yamada2</button>
      </main>`,
    );
    const result = extractAccountListObservation(document, ["taro.yamada"]);
    if (!result.ok) throw new Error(result.reason);
    const { observation } = result;
    expect(observation.accounts).toEqual(["[account]"]);
    // A Latin name touching kana is still hidden, with its leading @ and in any width.
    expect(observation.headings).toEqual(["ようこそ[account]さん"]);
    // A control naming the account is left out; "an" in "another" is not a name, and a
    // name inside a longer Latin word is not this one.
    expect(summary(observation).map((candidate) => candidate.label)).toEqual([
      "Continue",
      "Switch",
      "Use another profile",
      "Use an app",
      "Retaro.yamada2",
    ]);
    const sent = JSON.stringify(observation).normalize("NFKC").toLowerCase();
    expect(sent.replaceAll("retaro.yamada2", "")).not.toContain("taro");
    expect(sent).not.toContain("hanako");
  });

  it("does not send a list whose path names the account", () => {
    history.replaceState(null, "", "/u/taro/");
    page(`<div><span>taro</span><button>Continue</button></div>`);
    expect(extractAccountListObservation(document, ["taro"])).toEqual({
      ok: false,
      reason: "unsupported-page",
    });
    // The raw path is read, before a token-like name becomes `[id]` (ADR 0039).
    const name = "taro0123456789abcdef";
    history.replaceState(null, "", `/u/${name}/`);
    page(`<div><span>${name}</span><button>Continue</button></div>`);
    expect(extractAccountListObservation(document, [name])).toEqual({
      ok: false,
      reason: "unsupported-page",
    });
  });

  it("sends a list on a path with a token-like segment as [id] (ADR 0039)", () => {
    history.replaceState(null, "", "/123e4567-e89b-12d3-a456-426614174000/oauth2/authorize");
    page(`<div><span>taro</span><button>Continue</button></div>`);
    expect(extractAccountListObservation(document, ["taro"])).toMatchObject({
      ok: true,
      observation: { path: "/[id]/oauth2/authorize", accounts: ["[account]"] },
    });
  });

  it("refuses a page with a field or without a shown account", () => {
    page(`<button>taro@example.com</button><input type="password">`);
    expect(extractAccountListObservation()).toEqual({ ok: false, reason: "no-candidates" });
    page(`<button>Sign in</button><footer>Contact help@example.com</footer>`);
    expect(extractAccountListObservation()).toEqual({ ok: false, reason: "no-candidates" });
    page(
      `<button>Sign in</button><p>Contact <a href="mailto:help@example.com">help@example.com</a></p>`,
    );
    expect(extractAccountListObservation()).toEqual({ ok: false, reason: "no-candidates" });
    page(`<nav><a href="/me">taro@example.com</a></nav>`);
    expect(extractAccountListObservation()).toEqual({ ok: false, reason: "no-candidates" });
  });

  it("leaves out controls whose text repeats", () => {
    page(
      `<button>a@example.com</button><button>Remove</button><button>Remove</button>
      <button>Continue</button>`,
    );
    const result = extractAccountListObservation();
    if (!result.ok) throw new Error(result.reason);
    expect(summary(result.observation).map((candidate) => candidate.label)).toEqual(["Continue"]);
  });

  it("never sends a fullwidth address", () => {
    page(
      `<button>ｔａｒｏ＠ｅｘａｍｐｌｅ．ｃｏｍ</button><button>ｔａｒｏ@example.com</button>
      <button>Not ｈａｎａ＠ｅｘａｍｐｌｅ．ｃｏｍ?</button>`,
    );
    const result = extractAccountListObservation();
    if (!result.ok) throw new Error(result.reason);
    expect(result.observation.accounts).toEqual(["[email]", "[email]", "Not [email]?"]);
    expect(result.observation.accountEntries).toBe(3);
    expect(JSON.stringify(result.observation)).not.toMatch(/[@＠]|ｅｘａｍｐｌｅ|example/u);
  });

  it("takes a contact address in the page's text beside a button, for the AI to judge", () => {
    page(`<main><button>Sign in</button><p>Contact help@example.com</p></main>`);
    const result = extractAccountListObservation();
    if (!result.ok) throw new Error(result.reason);
    expect(result.observation.accounts).toEqual(["Contact [email]"]);
    expect(result.observation.accountEntries).toBe(0);
  });

  it("lists an entry inside a beside text once", () => {
    page(`<p>Signed in: <span tabindex="0">a@example.com</span></p><button>Continue</button>`);
    const result = extractAccountListObservation();
    if (!result.ok) throw new Error(result.reason);
    expect(result.observation.accounts).toEqual(["[email]"]);
    expect(result.observation.accountEntries).toBe(1);
  });

  it("describes Wise's shown account beside its buttons", () => {
    page(
      `<h1>Welcome back</h1>
      <div><div>TY</div><h3>Taro</h3><p>t***@example.com</p>
        <button><span>Log back in</span></button><button><span>Use another account</span></button>
      </div>`,
      "Log in | Example",
    );
    const result = extractAccountListObservation();
    if (!result.ok) throw new Error(result.reason);
    expect(result.observation.accounts).toEqual(["[email]"]);
    // The address is shown beside the buttons, so no account is an entry.
    expect(result.observation.accountEntries).toBe(0);
    expect(summary(result.observation).map((candidate) => candidate.label)).toEqual([
      "Log back in",
      "Use another account",
    ]);
    expect(JSON.stringify(result.observation)).not.toContain("example.com");
  });

  it("counts only the entries among the listed accounts", () => {
    // myUNSW's sign-in page on 2026-10-13, with a made-up address: the button holds it.
    page(`<h1>Sign in</h1><button>Agree and sign on taro@example.com</button>`);
    const button = extractAccountListObservation();
    if (!button.ok) throw new Error(button.reason);
    expect(button.observation.accounts).toEqual(["Agree and sign on [email]"]);
    expect(button.observation.accountEntries).toBe(1);
    // An entry, an address beside buttons and a name beside buttons: one entry.
    page(
      `<main>
        <div role="list"><div role="link" tabindex="0">a@example.com</div></div>
        <section><h3>Taro</h3><p>t***@example.com</p>
          <button>Log back in</button><button>Use another account</button></section>
        <section><span>hanako.s</span><button>Continue</button></section>
      </main>`,
    );
    const mixed = extractAccountListObservation(document, ["hanako.s"]);
    if (!mixed.ok) throw new Error(mixed.reason);
    expect(mixed.observation.accounts).toEqual(["[email]", "[email]", "[account]"]);
    expect(mixed.observation.accountEntries).toBe(1);
  });

  it("is incomplete when list controls are left out", () => {
    page(
      `<button>a@example.com</button>${Array.from(
        { length: 9 },
        (_, index) => `<button>Option ${index}</button>`,
      ).join("")}`,
    );
    const result = extractAccountListObservation();
    if (!result.ok) throw new Error(result.reason);
    expect(result.observation.candidates).toHaveLength(8);
    expect(result.observation.complete).toBe(false);
    expect(result.gap).toBe("too-many-controls");
  });

  it("leaves the page footer's controls out of a list, but not a card's footer", () => {
    const links = Array.from(
      { length: 9 },
      (_, index) => `<a href="/page-${index}">Page ${index}</a>`,
    ).join("");
    // Instagram's saved-profile page on 2026-10-13: 16 footer links went over 8.
    for (const footer of [
      `<footer role="contentinfo">${links}</footer>`,
      `<div role="contentinfo">${links}</div>`,
      `<footer>${links}</footer>`,
    ]) {
      page(
        `<main><button>a@example.com</button><button>Use another profile</button></main>${footer}`,
      );
      const result = extractAccountListObservation();
      if (!result.ok) throw new Error(result.reason);
      expect(result.gap, footer).toBeUndefined();
      expect(summary(result.observation).map((candidate) => candidate.label)).toEqual([
        "Use another profile",
      ]);
    }
    // A footer inside a section is the section's, as a card's actions.
    page(
      `<section><button>a@example.com</button><footer><button>Use another profile</button></footer></section>`,
    );
    const card = extractAccountListObservation();
    if (!card.ok) throw new Error(card.reason);
    expect(summary(card.observation).map((candidate) => candidate.label)).toEqual([
      "Use another profile",
    ]);
    // A main region inside a footer is the page's content, not its footer.
    page(
      `<div role="contentinfo"><main><button>a@example.com</button><button>Use another profile</button></main></div>`,
    );
    const wrapped = extractAccountListObservation();
    if (!wrapped.ok) throw new Error(wrapped.reason);
    expect(summary(wrapped.observation).map((candidate) => candidate.label)).toEqual([
      "Use another profile",
    ]);
  });

  it("names a list control only when the login finds that one control, footer or not", () => {
    // A main button repeated as a footer link is no single control for the login either.
    page(
      `<main><button>a@example.com</button><button>Continue</button></main><footer><a href="/x">Continue</a></footer>`,
    );
    const repeated = extractAccountListObservation();
    if (!repeated.ok) throw new Error(repeated.reason);
    const offered = summary(repeated.observation).map((candidate) => candidate.label);
    expect(offered.includes("Continue")).toBe(
      listControls(document, { by: "text", value: "Continue" }, "continue").length === 1,
    );
    // A footer-only switch is no control to send the list for.
    page(
      `<main><button>a@example.com</button></main><footer><a href="/switch">Use another account</a></footer>`,
    );
    const footerOnly = extractAccountListObservation();
    if (!footerOnly.ok) throw new Error(footerOnly.reason);
    expect(summary(footerOnly.observation)).toEqual([]);
    expect(otherAccountMiss(document)).toBe("other-in-chrome");
  });

  it("names the first cause of an incomplete list, without page text (ADR 0019)", () => {
    const gap = (html: string) => {
      page(html);
      const result = extractAccountListObservation();
      if (!result.ok) throw new Error(`no observation: ${result.reason}`);
      return [result.observation.complete, result.gap];
    };
    const continueButton = `<button>Continue</button>`;
    expect(gap(`<button>a@example.com</button>${continueButton}`)).toEqual([true, undefined]);
    for (const [html, expected] of [
      [
        `${Array.from({ length: 9 }, (_, at) => `<button>a${at}@example.com</button>`).join("")}${continueButton}`,
        "too-many-accounts",
      ],
      // An address that survives redaction is never sent, so its account is left out.
      [`<button>a@example.com @home</button>${continueButton}`, "unlisted-accounts"],
      [
        `<button>a@example.com</button>${continueButton}<div>${"<i></i>".repeat(4001)}</div>`,
        "too-many-elements",
      ],
    ] as const)
      expect(gap(html), html).toEqual([false, expected]);
    // A field in a shadow root is the page's own (ADR 0070): a page showing one is no list.
    page(`<button>a@example.com</button>${continueButton}<div id="host"></div>`);
    shadow("#host", `<input type="password">`);
    expect(extractAccountListObservation()).toEqual({ ok: false, reason: "no-candidates" });
  });
});

describe("extractEntryObservation (ADR 0031)", () => {
  // Synthetic hosts; the worker answers which hosts are on the page's site.
  const onSite = (url: URL) =>
    url.hostname === "synthetic.example" || url.hostname.endsWith(".synthetic.example");
  const entry = () => {
    const result = extractEntryObservation(document, onSite);
    if (!result.ok) throw new Error(`no observation: ${result.reason}`);
    return result.observation;
  };

  it("names a link by its text even when a role=button element elsewhere shares it", () => {
    page(
      `<header><a href="https://www.synthetic.example/login">Sign in</a></header>
      <main><div role="button" tabindex="0">Sign in</div></main>`,
    );
    expect(entry().candidates.map(({ target }) => target)).toEqual([
      { by: "text", value: "Sign in" },
    ]);
    expect(findTargets(document, { by: "text", value: "Sign in" }, { links: true })).toHaveLength(
      1,
    );
  });

  it("lists the page's on-site links and buttons, header and navigation first", () => {
    page(
      `<main>
        <h1>Synthetic art</h1>
        <a href="https://www.synthetic.example/ranking">Ranking</a>
        <button type="button">Show more</button>
      </main>
      <header>
        <a href="https://accounts.synthetic.example/signup">Create account</a>
        <a href="https://accounts.synthetic.example/login?return_to=%2Fbookmarks">Login</a>
        <a href="https://other.example/oauth">Continue with Other</a>
        <a href="https://accounts.synthetic.example/login?next=https%3A%2F%2Fother.example%2F">Other login</a>
        <a href="https://accounts.synthetic.example/login?next=%2F%2Fother.example%2F">Relative other</a>
        <a href="http://accounts.synthetic.example/login">Plain login</a>
        <a href="https://accounts.synthetic.example/login" target="_blank">New tab login</a>
        <a href="https://accounts.synthetic.example/login" target="_self">Same tab login</a>
        <a href="javascript:void 0">Script link</a>
        <a href="https://www.synthetic.example/icon"><img alt="Icon only" src="data:,"></a>
        <a href="https://www.synthetic.example/hidden" hidden>Hidden link</a>
        <button disabled>Disabled</button>
        <button aria-disabled="true">Marked disabled</button>
      </header>
      <form role="search"><input type="search" name="q"><button>Search</button></form>
      <form><button>Form without fields</button></form>`,
      "Synthetic art",
    );
    const observation = entry();
    expect(observation.complete).toBe(true);
    expect(observation.accounts).toBeUndefined();
    // `observe` lists the kept controls in document order.
    expect(observation.candidates.map((candidate) => [candidate.role, candidate.label])).toEqual([
      ["link", "Ranking"],
      ["button", "Show more"],
      ["link", "Create account"],
      ["link", "Login"],
      // This test page is served over plain HTTP, so an `http:` link on the site is kept
      // (ADR 0050); `entry.test.ts` covers its refusal on an HTTPS page.
      ["link", "Plain login"],
      ["link", "Same tab login"],
      // A script link is described as the button it acts as; only a link is ever pressed.
      ["button", "Script link"],
      ["button", "Form without fields"],
    ]);
    // Neither the page's query nor any `href` is described.
    expect(JSON.stringify(observation)).not.toContain("synthetic.example/");
    expect(JSON.stringify(observation)).not.toContain("return_to");
  });

  it("keeps header controls past the 48-candidate limit without marking the page incomplete", () => {
    const filler = Array.from(
      { length: 60 },
      (_, index) => `<a href="https://www.synthetic.example/work/${index}">Work ${index}</a>`,
    ).join("");
    page(
      `<main>${filler}</main>
      <nav><a href="https://accounts.synthetic.example/login">Login</a></nav>`,
    );
    const observation = entry();
    expect(observation.candidates).toHaveLength(48);
    expect(observation.complete).toBe(true);
    expect(observation.candidates.map((candidate) => candidate.label)).toContain("Login");
    expect(observation.candidates.map((candidate) => candidate.label)).not.toContain("Work 47");
  });

  it("drops every link when no host is on the site and describes no field", () => {
    page(
      `<a href="https://accounts.synthetic.example/login">Login</a>
      <input type="text" name="nickname">`,
    );
    const result = extractEntryObservation(document, () => false);
    expect(result).toEqual({ ok: false, reason: "no-candidates" });
  });

  it("drops a link that downloads and one the page's base target opens elsewhere", () => {
    page(
      `<a href="https://accounts.synthetic.example/login" download>Download login</a>
      <a href="https://accounts.synthetic.example/login">Login</a>`,
    );
    expect(entry().candidates.map((candidate) => candidate.label)).toEqual(["Login"]);
    const base = document.createElement("base");
    base.target = "_blank";
    document.head.append(base);
    try {
      expect(extractEntryObservation(document, onSite)).toEqual({
        ok: false,
        reason: "no-candidates",
      });
    } finally {
      base.remove();
    }
  });

  it("sends a path that may carry a token with [id] in its place, and no token locator (ADR 0039)", () => {
    const token = "SYNTHETIC0TOKEN1234";
    page(
      `<a id="${token}" href="https://accounts.synthetic.example/login">Login</a>
      <a id="help" href="https://www.synthetic.example/help">Help</a>`,
    );
    for (const [raw, sent] of [
      ["/s/0123456789abcdef0123456789abcdef/", "/s/[id]/"],
      // An Okta-style authorization server ID.
      ["/oauth2/aus1a2b3c4d5e6f7g8h9/v1/authorize", "/oauth2/[id]/v1/authorize"],
    ] as const) {
      history.replaceState(null, "", raw);
      const observation = entry();
      expect(observation.path, raw).toBe(sent);
      expect(observation.candidates.map(({ target }) => target)).toEqual([
        { by: "text", value: "Login" },
        { by: "id", value: "help" },
      ]);
      const sentText = JSON.stringify(observation);
      expect(sentText).not.toContain(token);
      expect(sentText).not.toContain("aus1a2b3c4d5e6f7g8h9");
    }
    // A path without a token keeps the link's ID.
    history.replaceState(null, "", "/oauth2/default/v1/authorize");
    expect(entry().candidates[0]!.target).toEqual({ by: "id", value: token });
  });
});

describe("passkey-only start observation", () => {
  it("extracts only visible sign-in controls and redacts the page URL", () => {
    history.replaceState(null, "", "/login?token=synthetic-private-token");
    page(`<h1>Sign in</h1><button id="login-key">Sign in with a passkey</button>
      <button hidden>Create a passkey</button><input type="hidden" value="synthetic-private-value">`);
    const result = extractPasskeyObservation(document);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);
    expect(result.observation.candidates).toContainEqual(
      expect.objectContaining({
        role: "button",
        label: "Sign in with a passkey",
        target: { by: "id", value: "login-key" },
      }),
    );
    const serialized = JSON.stringify(result.observation);
    expect(serialized).not.toContain("synthetic-private");
    expect(serialized).not.toContain("Create a passkey");
  });

  it("reads a pointer tab stop without a role as the passkey button (Logi ID, 2026-11-07)", () => {
    // Logi ID's page for a device that signed in with a passkey before, shortened; its
    // hCaptcha keeps two hidden text areas, and its "forgot your passkey" link names a
    // passkey too but is no sign-in button (#1375).
    page(`<style>.button, .forgot_link { cursor: pointer }</style>
      <div class="description">このデバイスでは以前にパスキーでログインしています。</div>
      <div class="captcha"><textarea name="h-captcha-response" style="display: none"></textarea></div>
      <div class="submit"><div class="button" tabindex="0"><p class="button_text">🔑 パスキーを使用してログイン</p></div></div>
      <a class="forgot_link" tabindex="0">パスキーを忘れた場合</a>
      <a class="forgot_link" tabindex="0">サインイン</a>`);
    const result = extractPasskeyObservation(document);
    if (!result.ok) throw new Error(result.reason);
    const target = { by: "text", value: "🔑 パスキーを使用してログイン" } as const;
    expect(result.observation.candidates).toEqual([
      { id: "c1", role: "button", label: "🔑 パスキーを使用してログイン", target },
    ]);
    expect(findTargets(document, target)).toEqual([document.querySelector(".button")]);
  });

  it("locates a role button that names a passkey by its text, only when no other has it", () => {
    page(`<div role="button">Sign in with a passkey</div>`);
    const result = extractPasskeyObservation(document);
    if (!result.ok) throw new Error(result.reason);
    expect(result.observation.candidates.map(({ target }) => target)).toEqual([
      { by: "text", value: "Sign in with a passkey" },
    ]);
    page(
      `<div role="button">Sign in with a passkey</div><div role="button">Sign in with a passkey</div>`,
    );
    expect(extractPasskeyObservation(document)).toEqual({ ok: false, reason: "no-candidates" });
  });

  it.each([
    `<button>Create a passkey</button>`,
    `<button hidden>Sign in with a passkey</button>`,
    `<button>Sign in with a passkey</button><input type="email" aria-label="Email">`,
    `<button>Sign in with a passkey</button><input type="password" aria-label="Password">`,
  ])("does not qualify registration, hidden buttons or a fill form: %s", (html) => {
    page(html);
    expect(extractPasskeyObservation(document).ok).toBe(false);
  });
});

describe("extractLogoutObservation (ADR 0063)", () => {
  const logout = () => {
    const result = extractLogoutObservation();
    if (!result.ok) throw new Error(`no observation: ${result.reason}`);
    return result.observation;
  };

  it("lists a signed-in page's buttons and links, never a form's or a new window's", () => {
    page(
      `<header>
        <a href="/home">Home</a>
        <button type="button" id="account-menu">Account</button>
        <a href="/logout">Log out</a>
        <a href="/help" target="_blank">Help</a>
        <a href="/export.csv" download>Export</a>
        <button type="button">Inbox 12</button>
        <button disabled>Disabled</button>
        <form role="search"><input type="search" name="q"><button>Search</button></form>
        <form><button>Form without fields</button></form>
      </header>`,
      "Inbox (12) - Synthetic mail",
    );
    const observation = logout();
    expect(observation.complete).toBe(true);
    expect(observation.candidates.map((candidate) => [candidate.role, candidate.label])).toEqual([
      ["link", "Home"],
      ["button", "Account"],
      ["link", "Log out"],
      ["button", "Form without fields"],
    ]);
    expect(observation.candidates[1]?.target).toEqual({ by: "id", value: "account-menu" });
    // A count in the title is no part of a recipe's page.
    expect(JSON.stringify(observation)).not.toContain("12");
  });

  it("reads controls inside open and closed shadow roots as part of the page (ADR 0070)", () => {
    page(`<header><account-menu id="account"></account-menu></header><app-nav id="nav"></app-nav>`);
    shadow("#account", `<button type="button" id="sign-out">Sign out</button>`, "closed");
    shadow("#nav", `<ul role="menu"><li role="menuitem">Log out</li></ul>`);
    const observation = logout();
    expect(
      observation.candidates.map((candidate) => [
        candidate.role,
        candidate.label,
        candidate.target,
      ]),
    ).toEqual([
      ["button", "Sign out", { by: "id", value: "sign-out" }],
      ["button", "Log out", { by: "text", value: "Log out" }],
    ]);
  });

  it("keeps an open dialog's and menu's controls first past the 48-candidate limit", () => {
    const filler = Array.from(
      { length: 60 },
      (_, index) =>
        `<button type="button" id="item-${"abcdefghij"[index % 10]}${index}">Item</button>`,
    ).join("");
    page(
      `<header><button type="button" id="menu-button">Menu</button></header>
      <nav>${filler}</nav>
      <div role="menu"><a href="/logout" role="menuitem">Sign out</a></div>
      <div role="dialog" aria-modal="true"><button type="button" id="confirm">Yes, sign out</button></div>`,
    );
    const observation = logout();
    expect(observation.candidates).toHaveLength(48);
    const labels = observation.candidates.map((candidate) => candidate.label);
    expect(labels).toContain("Yes, sign out");
    expect(labels).toContain("Sign out");
    expect(labels).toContain("Menu");
  });

  it("sends only the controls that may lead to the logout, by their labels, and the title", () => {
    page(
      `<header><button type="button" id="account-menu" aria-describedby="greeting">Account</button>
        <span id="greeting">Signed in as Taro, 3 orders on the way</span></header>
      <h1>Your orders</h1>
      <main>
        <p>Order shipped to 1 Example Street</p>
        <button type="button" id="track">Track order</button>
        <a href="/orders/old">Older orders</a>
        <div class="user-panel"><button type="button" id="prefs">Preferences</button></div>
        <section><button type="button" id="leave">Sign out</button></section>
      </main>`,
      "Orders - Synthetic shop",
    );
    const observation = logout();
    expect(observation.candidates.map((candidate) => [candidate.label, candidate.target])).toEqual([
      ["Account", { by: "id", value: "account-menu" }],
      ["Preferences", { by: "id", value: "prefs" }],
      ["Sign out", { by: "id", value: "leave" }],
    ]);
    expect(observation.title).toBe("Orders - Synthetic shop");
    expect(observation).not.toHaveProperty("headings");
    expect(observation.candidates.some((candidate) => "description" in candidate)).toBe(false);
    const sent = JSON.stringify(observation);
    for (const text of ["Your orders", "Example Street", "Taro", "Track order", "Older orders"])
      expect(sent).not.toContain(text);
  });

  it("refuses a page with no control to press", () => {
    page(`<main><p>Nothing here</p><form><input name="q"><button>Search</button></form></main>`);
    expect(extractLogoutObservation()).toEqual({ ok: false, reason: "no-candidates" });
  });

  it("describes menu items and icon-only controls by their aria-label or title", () => {
    page(
      `<header>
        <button type="button" aria-label="Account menu" aria-haspopup="menu"><svg></svg></button>
        <a href="/help" title="Help"><svg></svg></a>
        <button type="button" aria-label="Inbox 3 unread"><svg></svg></button>
      </header>
      <ul role="menu">
        <li role="menuitem" tabindex="-1">Settings</li>
        <li role="menuitem" tabindex="-1" aria-label="Sign out"><svg></svg></li>
        <li role="menuitem" aria-disabled="true">Billing</li>
      </ul>`,
    );
    const observation = logout();
    expect(
      observation.candidates.map((candidate) => [
        candidate.role,
        candidate.label,
        candidate.target,
      ]),
    ).toEqual([
      ["button", "Account menu", { by: "accessible-name", value: "Account menu" }],
      ["button", "Help", { by: "accessible-name", value: "Help" }],
      ["button", "Settings", { by: "text", value: "Settings" }],
      ["button", "Sign out", { by: "accessible-name", value: "Sign out" }],
    ]);
  });
});

describe("extractLocalLogout (ADR 0063)", () => {
  it("answers the locator of the one control that says it logs out", () => {
    page(
      `<header><a href="/home">Home</a><button type="button" id="bye">Log out</button></header>`,
    );
    expect(extractLocalLogout()).toEqual({ ok: true, target: { by: "id", value: "bye" } });
    page(`<ul role="menu"><li role="menuitem" tabindex="-1">ログアウト</li></ul>`);
    expect(extractLocalLogout()).toEqual({
      ok: true,
      target: { by: "text", value: "ログアウト" },
    });
    page(`<nav><button type="button" aria-label="Sign out"><svg></svg></button></nav>`);
    expect(extractLocalLogout()).toEqual({
      ok: true,
      target: { by: "accessible-name", value: "Sign out" },
    });
  });

  it("reads a logout control's form whose named controls hide its own members", () => {
    // A control named `querySelector` hides the form's own method (`form-native.ts`).
    const named = '<input type="hidden" name="querySelector">';
    page(`<form>${named}<button type="button" id="bye">Log out</button></form>`);
    expect(extractLocalLogout()).toEqual({ ok: true, target: { by: "id", value: "bye" } });
    page(`<form>${named}<input name="q"><button type="button" id="bye">Log out</button></form>`);
    expect(extractLocalLogout()).toEqual({ ok: false, reason: "none" });
  });

  it("answers none, ambiguous or unlocated otherwise", () => {
    page(`<header><button type="button">Sign out of all other sessions</button></header>`);
    expect(extractLocalLogout()).toEqual({ ok: false, reason: "none" });
    page(`<header><button type="button">Log out</button><a href="/out">Log out</a></header>`);
    expect(extractLocalLogout()).toEqual({ ok: false, reason: "ambiguous" });
    // A control named by the account it logs out has no locator a recipe could keep.
    page(`<header><button type="button">Log out alice@example.test</button></header>`);
    expect(extractLocalLogout()).toEqual({ ok: false, reason: "unlocated" });
  });

  it("answers none for a logout link that leaves the site, opens a window or downloads", () => {
    const onSite = (url: URL) => url.hostname === location.hostname;
    for (const link of [
      `<a href="https://elsewhere.example/logout">Log out</a>`,
      `<a href="/logout?next=https%3A%2F%2Felsewhere.example%2F">Log out</a>`,
      `<a href="/logout" target="_blank">Log out</a>`,
      `<a href="/logout" download>Log out</a>`,
    ]) {
      page(`<header><a href="/home">Home</a>${link}</header>`);
      expect(extractLocalLogout(document, onSite)).toEqual({ ok: false, reason: "none" });
    }
    // Without the worker's hosts no link is on the site.
    page(`<header><a href="/logout">Log out</a></header>`);
    expect(extractLocalLogout()).toEqual({ ok: false, reason: "none" });
    expect(extractLocalLogout(document, onSite)).toMatchObject({ ok: true });
    // A link handled on the page, as `href="#"`, stays on it.
    page(`<header><a href="#" id="bye">Sign out</a></header>`);
    expect(extractLocalLogout(document, onSite)).toEqual({
      ok: true,
      target: { by: "id", value: "bye" },
    });
  });
});

describe("fieldsMissDetail", () => {
  it("names the page's inputs and how each shows, as codes only", () => {
    page(`<form><input type="email" value="me@example.com" aria-hidden="true">
      <input type="password" style="opacity: 0"></form>
      <input type="text" hidden><input type="text" name="q">`);
    expect(fieldsMissDetail(document)).toBe(
      "n4.d2.email-hidden-attr.password-transparent.text-hidden-attr-out",
    );
    expect(fieldsMissDetail(document)).not.toContain("example");
  });
});
