import { afterEach, describe, expect, it } from "vitest";
import { findTargets } from "./targets";
import { buttonText } from "./text";

// Runs in Chromium (vitest browser mode) so rendering decides which text counts.
const page = (html: string) => {
  document.body.innerHTML = html;
};
const ids = (elements: Element[]) => elements.map((element) => element.id);
afterEach(() => {
  document.body.innerHTML = "";
});

describe("findTargets", () => {
  it("matches links to the page's own origin by their exact path, never script links", () => {
    page(
      `<a id="a" href="/my?tab=1#top">A</a><a id="b" href="/my/">B</a>
      <a id="c" href="https://other.example/my">C</a><a id="d" href="/my" hidden>D</a>
      <a id="e" href="javascript:void(0)">E</a><a id="f" href="#">F</a>`,
    );
    // The caller rejects the two links rather than picking the shown one.
    expect(ids(findTargets(document, { by: "href", value: "/my" }))).toEqual(["a", "d"]);
    expect(ids(findTargets(document, { by: "href", value: "/my/" }))).toEqual(["b"]);
    expect(ids(findTargets(document, { by: "href", value: location.pathname }))).toEqual([]);
  });

  it("compares attribute strings, so selector syntax in a value is inert", () => {
    page(
      `<input id="a" name="ctl00$Main$txtUserId"><input id="b" name="user[login]">
      <input id="c" data-testid="go"><input id="d" name="x'] , [name"><input id="e" name="x">`,
    );
    expect(ids(findTargets(document, { by: "name", value: "ctl00$Main$txtUserId" }))).toEqual([
      "a",
    ]);
    expect(ids(findTargets(document, { by: "name", value: "user[login]" }))).toEqual(["b"]);
    expect(ids(findTargets(document, { by: "test-id", value: "go" }))).toEqual(["c"]);
    expect(ids(findTargets(document, { by: "name", value: "x'] , [name" }))).toEqual(["d"]);
    expect(ids(findTargets(document, { by: "id", value: "a" }))).toEqual(["a"]);
  });

  it("matches inputs by one of their autocomplete tokens, a lone hidden one included", () => {
    page(
      `<input id="a" autocomplete="username webauthn"><input id="b" autocomplete="Current-Password">
      <textarea id="c" autocomplete="email"></textarea><input id="d" autocomplete="email" hidden>
      <input id="e" autocomplete="section-x email"><input id="f" autocomplete="one-time-code" hidden>`,
    );
    expect(ids(findTargets(document, { by: "autocomplete", value: "username" }))).toEqual(["a"]);
    expect(ids(findTargets(document, { by: "autocomplete", value: "current-password" }))).toEqual([
      "b",
    ]);
    expect(ids(findTargets(document, { by: "autocomplete", value: "one-time-code" }))).toEqual([
      "f",
    ]);
    // Of two inputs only the shown one counts, unless a signed-in marker asks for both.
    expect(ids(findTargets(document, { by: "autocomplete", value: "email" }))).toEqual(["e"]);
    expect(
      ids(findTargets(document, { by: "autocomplete", value: "email" }, { hidden: true })),
    ).toEqual(["d", "e"]);
  });

  describe("an attribute several elements carry (ADR 0037 amendment of 2026-10-22, #832)", () => {
    it("counts only the shown ones, as beside a hidden copy of the login form", () => {
      // A card site's login (2026-10-21): an additional-check dialog, closed, copies the
      // form's fields under the same names.
      page(
        `<form><input id="a" name="webId"><input id="b" type="password" name="webPassword">
          <input type="submit" value="ログイン"></form>
        <span style="display:none"><form>
          <dl style="display:none"><input id="c" name="webId"></dl>
          <dl style="display:none"><input id="d" type="password" name="webPassword"></dl>
          <input id="e" name="webPhoneNum" maxlength="4"></form></span>`,
      );
      expect(ids(findTargets(document, { by: "name", value: "webId" }))).toEqual(["a"]);
      expect(ids(findTargets(document, { by: "name", value: "webPassword" }))).toEqual(["b"]);
      expect(ids(findTargets(document, { by: "name", value: "webId" }, { hidden: true }))).toEqual([
        "a",
        "c",
      ]);
      // A step's one element the page has not shown yet is still found.
      expect(ids(findTargets(document, { by: "name", value: "webPhoneNum" }))).toEqual(["e"]);
      // Once the copy shows, the caller rejects the two inputs rather than pick one.
      document.querySelector("span")!.removeAttribute("style");
      document.querySelector<HTMLElement>("dl")!.removeAttribute("style");
      expect(ids(findTargets(document, { by: "name", value: "webId" }))).toEqual(["a", "c"]);
    });

    it("follows whichever of two forms the window's width shows", () => {
      page(
        `<style>.narrow { display: none } @media (max-width: 1px) { .wide { display: none }
          .narrow { display: block } }</style>
        <form class="wide"><input id="a" data-testid="user"><button id="b" name="go">Go</button></form>
        <form class="narrow"><input id="c" data-testid="user"><button id="d" name="go">Go</button></form>`,
      );
      expect(ids(findTargets(document, { by: "test-id", value: "user" }))).toEqual(["a"]);
      expect(ids(findTargets(document, { by: "name", value: "go" }))).toEqual(["b"]);
      document.body.querySelector("style")!.textContent =
        ".wide { display: none } .narrow { display: block }";
      expect(ids(findTargets(document, { by: "test-id", value: "user" }))).toEqual(["c"]);
      expect(ids(findTargets(document, { by: "name", value: "go" }))).toEqual(["d"]);
    });

    it("still counts a copy that is rendered but hidden from assistive technology", () => {
      // Behind an open modal the page's form is aria-hidden, but it still shows.
      page(
        `<main aria-hidden="true"><input id="a" name="user"></main>
        <div role="dialog" aria-modal="true"><input id="b" name="user"></div>`,
      );
      expect(ids(findTargets(document, { by: "name", value: "user" }))).toEqual(["a", "b"]);
    });
  });

  it("matches shown fillable inputs by their visible name (ADR 0037)", () => {
    // A Mantine-built form (2026-10-13): random per-load IDs, a placeholder each.
    page(
      `<form><input id="mantine-v0zmrhrmb" placeholder=" メール\u200bアドレス ">
        <input id="mantine-k2j4h6g8f" type="password" placeholder="パスワード">
        <input id="h" placeholder="パスワード" hidden><input id="i" type="checkbox" aria-label="パスワード">
        <textarea id="j" placeholder="パスワード"></textarea>
        <button id="k" type="submit">ログインする</button></form>`,
    );
    expect(ids(findTargets(document, { by: "label", value: "メールアドレス" }))).toEqual([
      "mantine-v0zmrhrmb",
    ]);
    // Hidden inputs, checkboxes and text areas never match.
    expect(ids(findTargets(document, { by: "label", value: "パスワード" }))).toEqual([
      "mantine-k2j4h6g8f",
    ]);
    expect(findTargets(document, { by: "label", value: "ログインする" })).toEqual([]);
    // The next load's IDs differ; the name still finds the field.
    document.getElementById("mantine-v0zmrhrmb")!.id = "mantine-p9o8i7u6y";
    expect(ids(findTargets(document, { by: "label", value: "メールアドレス" }))).toEqual([
      "mantine-p9o8i7u6y",
    ]);
    // Callers reject two shown inputs with one name.
    document.getElementById("h")!.hidden = false;
    expect(ids(findTargets(document, { by: "label", value: "パスワード" }))).toEqual([
      "mantine-k2j4h6g8f",
      "h",
    ]);
  });

  it("names a field by aria-labelledby, then its labels, aria-label and placeholder", () => {
    page(
      `<span id="n1">Customer</span><span id="n2">number</span><span id="n3" hidden>x</span>
      <input id="a" aria-labelledby="n1 n3 n2" aria-label="Ignored" placeholder="Ignored">
      <label for="b">User <b>ID</b></label><input id="b" aria-label="Ignored" placeholder="Ignored">
      <label>Email <input id="c" placeholder="Ignored"></label>
      <input id="d" aria-label="PIN" placeholder="Ignored"><input id="e" placeholder="Code">
      <label for="f"> </label><input id="f" placeholder="Branch">
      <label for="g">${"x".repeat(121)}</label><input id="g" placeholder="Long">`,
    );
    const named = (value: string) => ids(findTargets(document, { by: "label", value }));
    expect(named("Customer number")).toEqual(["a"]);
    expect(named("User ID")).toEqual(["b"]);
    expect(named("Email")).toEqual(["c"]);
    expect(named("PIN")).toEqual(["d"]);
    expect(named("Code")).toEqual(["e"]);
    // An empty label gives way to the next source; a long one leaves no name at all.
    expect(named("Branch")).toEqual(["f"]);
    expect(named("Long")).toEqual([]);
    expect(named("Ignored")).toEqual([]);
  });

  it("matches links by text only when asked and no button shows the text, for an account switch", () => {
    page(
      `<a id="a" href="/switch"> Use another <b>account</b> </a><a id="b">Use another account</a>
      <a id="c" href="/x" hidden>Use another account</a><button id="d">Use another account</button>`,
    );
    const target = { by: "text", value: "Use another account" } as const;
    expect(ids(findTargets(document, target))).toEqual(["d"]);
    // A button with the text hides the link; without one, the link alone matches.
    expect(ids(findTargets(document, target, { links: true }))).toEqual(["d"]);
    document.getElementById("d")!.remove();
    expect(ids(findTargets(document, target, { links: true }))).toEqual(["a"]);
  });

  it("matches links that run a script by text when no native button shows it", () => {
    page(
      `<a id="a" href="javascript:;" onclick="login()"><span>ログイン</span></a>
      <a id="b" onclick="login()">パスキー</a><a id="c" href="#" onclick="go()">次へ</a>
      <a id="d" href="/help">次へ</a><div id="e" role="button">ログイン</div>
      <a id="f" href="#" onclick="tab()">Login</a><input id="g" type="submit" value="Login">`,
    );
    expect(ids(findTargets(document, { by: "text", value: "ログイン" }))).toEqual(["a"]);
    expect(ids(findTargets(document, { by: "text", value: "パスキー" }))).toEqual(["b"]);
    expect(ids(findTargets(document, { by: "text", value: "次へ" }))).toEqual(["c"]);
    expect(ids(findTargets(document, { by: "text", value: "次へ" }, { links: true }))).toEqual([
      "c",
    ]);
    // A button of either kind hides other links from an account switch.
    page(`<a id="h" href="#" onclick="sw()">Switch</a><a id="i" href="/other">Switch</a>`);
    expect(ids(findTargets(document, { by: "text", value: "Switch" }, { links: true }))).toEqual([
      "h",
    ]);
    // A hidden native button with the text hides script links too, so a click waits for it.
    page(
      `<a id="j" href="#" role="button">次へ</a><button id="k" style="display:none">次へ</button>`,
    );
    expect(ids(findTargets(document, { by: "text", value: "次へ" }))).toEqual([]);
    // A switch link still matches: the hidden button holds back script links only.
    page(`<a id="l" href="/switch">Switch</a><button id="m" type="button" hidden>Switch</button>`);
    expect(ids(findTargets(document, { by: "text", value: "Switch" }, { links: true }))).toEqual([
      "l",
    ]);
    page(
      `<a id="j" href="#" role="button">次へ</a><button id="k" style="display:none">次へ</button>`,
    );
    document.getElementById("k")!.style.display = "";
    expect(ids(findTargets(document, { by: "text", value: "次へ" }))).toEqual(["k"]);
    page(`<a id="f" href="#" onclick="tab()">Login</a><input id="g" type="submit" value="Login">`);
    // A native button with the text hides script links, also from an account switch.
    expect(ids(findTargets(document, { by: "text", value: "Login" }))).toEqual(["g"]);
    expect(ids(findTargets(document, { by: "text", value: "Login" }, { links: true }))).toEqual([
      "g",
    ]);
  });

  it("matches other role=button elements by text only without links, and after buttons and script links", () => {
    page(
      `<div id="a" role="button" aria-disabled="true">Log in</div>
      <div id="b" role="button">次へ</div><a id="c" href="#" onclick="go()">次へ</a>
      <span id="d" role="button">Help</span><a id="e" href="/help">Help</a>
      <div id="f" role="button">Next</div><button id="g" hidden>Next</button>`,
    );
    expect(ids(findTargets(document, { by: "text", value: "Log in" }))).toEqual(["a"]);
    // A script link with the text comes first.
    expect(ids(findTargets(document, { by: "text", value: "次へ" }))).toEqual(["c"]);
    expect(ids(findTargets(document, { by: "text", value: "Help" }))).toEqual(["d"]);
    // A lookup that may name a link compares links and never role=button elements.
    expect(ids(findTargets(document, { by: "text", value: "Help" }, { links: true }))).toEqual([
      "e",
    ]);
    expect(findTargets(document, { by: "text", value: "Log in" }, { links: true })).toEqual([]);
    // A hidden native button with the text holds it back, as it does script links.
    expect(ids(findTargets(document, { by: "text", value: "Next" }))).toEqual([]);
  });

  it("matches buttons by collapsed rendered text, input value or image alt", () => {
    page(
      `<button id="a"> <span>ログ</span><span>​イン</span> </button>
      <input id="b" type="submit" value=" Sign
        in ">
      <input id="c" type="image" src="data:," alt="次へ" width="20" height="20">
      <input id="d" type="button" value="Back">
      <button id="e"><img src="data:," alt="ignored">Help<script>x</script><span hidden>!</span></button>
      <button id="f"><img src="data:," alt="ログイン" width="20" height="20"></button>`,
    );
    expect(ids(findTargets(document, { by: "text", value: "Sign in" }))).toEqual(["b"]);
    expect(ids(findTargets(document, { by: "text", value: "次へ" }))).toEqual(["c"]);
    expect(ids(findTargets(document, { by: "text", value: "Back" }))).toEqual(["d"]);
    expect(ids(findTargets(document, { by: "text", value: "Help" }))).toEqual(["e"]);
    // A text button and an image-only button with the same name are ambiguous.
    expect(ids(findTargets(document, { by: "text", value: "ログイン" }))).toEqual(["a", "f"]);
    document.getElementById("a")!.remove();
    expect(ids(findTargets(document, { by: "text", value: "ログイン" }))).toEqual(["f"]);
  });

  it("matches an image-only link by its images' alt, with links", () => {
    page(
      `<a id="a" href="/my/"><img src="data:," alt="マイページ" width="24" height="24"></a>
      <a id="b" href="/news"><img src="data:," alt="ignored">News</a>
      <a id="c" href="/logout"><img src="data:," alt="ログアウト" hidden></a>`,
    );
    expect(ids(findTargets(document, { by: "text", value: "マイページ" }))).toEqual([]);
    expect(
      ids(findTargets(document, { by: "text", value: "マイページ" }, { links: true })),
    ).toEqual(["a"]);
    // Text wins over images, and a hidden image names nothing.
    expect(ids(findTargets(document, { by: "text", value: "News" }, { links: true }))).toEqual([
      "b",
    ]);
    expect(findTargets(document, { by: "text", value: "ignored" }, { links: true })).toEqual([]);
    expect(findTargets(document, { by: "text", value: "ログアウト" }, { links: true })).toEqual([]);
  });

  it("never matches non-buttons, hidden buttons or partial text, and returns every duplicate", () => {
    page(
      `<a id="a" href="/">Log in</a><label id="b">Log in</label><input id="c" value="Log in">
      <input id="d" type="reset" value="Log in"><button id="e" hidden>Log in</button>
      <button id="f" style="display:none">Log in</button><div aria-hidden="true"><button id="g">Log in</button></div>
      <button id="h">Log in now</button>`,
    );
    expect(findTargets(document, { by: "text", value: "Log in" })).toEqual([]);
    page(`<button id="a">OK</button><input id="b" type="submit" value="OK">`);
    expect(ids(findTargets(document, { by: "text", value: "OK" }))).toEqual(["a", "b"]);
  });

  it("gives no text to buttons whose text is empty or longer than the locator limit", () => {
    page(
      `<button id="a"></button><input id="b" type="submit"><button id="c">${"x".repeat(121)}</button>
      <button id="d">${"x".repeat(120)}</button>
      <button id="e"><span>Sign in</span>${" ".repeat(500)}<span>and delete account</span></button>`,
    );
    expect(["a", "b", "c", "d", "e"].map((id) => buttonText(document.getElementById(id)!))).toEqual(
      [undefined, undefined, undefined, "x".repeat(120), undefined],
    );
  });

  // ADR 0048 amendment of 2026-10-19: two controls that both show "Select".
  it("names a shown control by its accessible name, apart from fields and hidden controls", () => {
    page(
      `<form><input id="field" aria-label="Select Password.">
        <a id="a" href="#" aria-label="Select Password.">Select</a>
        <a id="b" href="#" aria-label="Select Phone">Select</a>
        <button id="c" type="button" aria-label="Select Phone" hidden>Select</button>
        <span id="heading">Use password</span>
        <div id="d" role="button" aria-labelledby="heading" aria-label="Ignored">Go</div>
        <input id="e" type="submit" aria-label="Submit form" value="Go">
        <a id="f" href="/elsewhere" aria-label="Leave">Leave</a>
        <span id="g" aria-label="Not a control">Text</span></form>`,
    );
    const named = (value: string) => ids(findTargets(document, { by: "accessible-name", value }));
    // The field's own name is a `label` locator's, counted apart.
    expect(named("Select Password.")).toEqual(["a"]);
    expect(named("Select Phone")).toEqual(["b"]);
    expect(named("Use password")).toEqual(["d"]);
    expect(named("Ignored")).toEqual([]);
    expect(named("Submit form")).toEqual(["e"]);
    // A link that navigates and an element that is no control never match.
    expect(named("Leave")).toEqual([]);
    expect(named("Not a control")).toEqual([]);
    // Its text locator is unchanged: "Select" names no button, and the links only as links.
    expect(findTargets(document, { by: "text", value: "Select" })).toEqual([]);
    expect(ids(findTargets(document, { by: "text", value: "Select" }, { links: true }))).toEqual([
      "a",
      "b",
    ]);
    // Two shown controls with one name are both returned, for the caller to refuse.
    document.getElementById("c")!.hidden = false;
    expect(named("Select Phone")).toEqual(["b", "c"]);
  });
});
