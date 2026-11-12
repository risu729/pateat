import { expect, it } from "vitest";
import { findTargets } from "../../src/page/targets";
import { extractLoginObservation } from "../../src/observation/extract";
import type { ObservationTestContext } from "./context";

export function registerLoginCandidates({
  page,
  shadow,
  observe,
  summary,
}: Pick<ObservationTestContext, "page" | "shadow" | "observe" | "summary">) {
  it("keeps buttons outside every form beside the login form, such as a passkey button", () => {
    page(
      `<header><div><div><button id="menu">Menu</button></div></div></header>
      <main><ul>
        <li><button id="pk">Sign in with a passkey</button><button>×</button></li>
        <li><form id="login"><input id="user"><input id="pw" type="password">
          <button id="go">Sign in</button></form></li>
      </ul><div><div><button id="far">Far away</button></div></div></main>`,
    );
    const observation = observe();
    expect(observation.complete).toBe(true);
    expect(
      observation.candidates.map((candidate) => [candidate.target.value, candidate.group]),
    ).toEqual([
      ["pk", undefined],
      // The rule reads structure only, so a nearby close button comes along.
      ["×", undefined],
      ["user", "f1"],
      ["pw", "f1"],
      ["go", "f1"],
    ]);
    // A field outside every form elsewhere on the page does not change that.
    page(
      `<div><input id="q"><select><option>All</option></select></div>
      <main><ul><li><button id="pk">Passkey</button></li>
        <li><form id="login"><input id="pw" type="password"><button id="go">Sign in</button></form></li>
      </ul></main>`,
    );
    expect(observe().candidates.map((candidate) => candidate.target.value)).toEqual([
      "pk",
      "pw",
      "go",
    ]);
    // Only a form with a password field has neighbours, and only a few of them.
    page(
      `<main><div><button id="pk">Passkey</button><form id="search"><input id="q">
        <button id="go">Search</button></form></div></main>`,
    );
    expect(observe().candidates.map((candidate) => candidate.target.value)).toEqual(["q", "go"]);
    page(
      `<main><div>${["a", "b", "c", "d", "e"].map((id) => `<button id="${id}">${id}</button>`).join("")}
        <form id="login"><input id="pw" type="password"><button id="go">Sign in</button></form>
      </div></main>`,
    );
    expect(observe().candidates.map((candidate) => candidate.target.value)).toEqual(["pw", "go"]);
    // A form directly in the body never makes the whole page its neighbourhood.
    page(
      `<div><button id="pk">Passkey</button></div>
      <form id="login"><input id="pw" type="password"><button id="go">Sign in</button></form>`,
    );
    expect(observe().candidates.map((candidate) => candidate.target.value)).toEqual(["pw", "go"]);
  });

  it("leaves out a search box outside every form and the bar it sits in", () => {
    // LeetCode's sign-in page (2026-11-07), reduced: a navigation bar with menu buttons and
    // a search box outside every form, then a card whose form holds the fields while its
    // "Sign In" and "Sign Up" buttons sit outside it.
    const card = `<main><div class="card"><div class="stack">
        <form><input id="id_login" autocomplete="username" placeholder="Username or E-mail">
          <input id="id_password" type="password" autocomplete="current-password"></form>
        <div><button id="signin_btn" type="button">Sign In</button></div>
        <div><a href="#">Forgot Password?</a><button type="button">Sign Up</button></div>
      </div></div></main>`;
    for (const search of [
      `<input placeholder="Search">`,
      `<input type="search">`,
      `<div role="search"><input id="q"></div>`,
    ]) {
      page(
        `<nav><button id="interview" type="button">Interview</button>
          <button id="store" type="button">Store</button>${search}</nav>${card}`,
      );
      const observation = observe();
      expect(observation.complete, search).toBe(true);
      expect(
        observation.candidates.map((candidate) => [candidate.target.value, candidate.group]),
        search,
      ).toEqual([
        ["id_login", "f1"],
        ["id_password", "f1"],
        ["signin_btn", undefined],
        ["Sign Up", undefined],
      ]);
    }
    // Any other field outside every form still brings the controls outside every form.
    page(`<nav><button id="store" type="button">Store</button><input id="q"></nav>${card}`);
    expect(observe().candidates.map((candidate) => candidate.target.value)).toEqual([
      "store",
      "q",
      "id_login",
      "id_password",
      "signin_btn",
      "Sign Up",
    ]);
    // A page whose only field is a search box outside every form is no sign-in page.
    page(`<nav><input placeholder="Search"><button>Go</button></nav>`);
    expect(extractLoginObservation()).toEqual({ ok: false, reason: "no-candidates" });
  });

  it("never gives a role=button control and a link of another form the same text locator", () => {
    // The login form's Help widget is named by its text there; the link of a form that is
    // no login form, such as a newsletter form beside it, is not checked against it.
    page(
      `<form><input id="u"><input id="p" type="password"><button>Sign in</button>
        <div role="button" tabindex="0">Help</div></form>
      <form><input id="news" type="text"><a href="/help">Help</a></form>`,
    );
    const result = extractLoginObservation();
    // Two candidates with one locator fail the observation's check.
    expect(result.ok ? true : result.reason).toBe(true);
    if (!result.ok) return;
    const targets = result.observation.candidates.map(({ target }) => JSON.stringify(target));
    expect(new Set(targets).size).toBe(targets.length);
    // The login form's own control keeps the text.
    expect(targets).toContain(JSON.stringify({ by: "text", value: "Help" }));
    expect(
      findTargets(document, { by: "text", value: "Help" }).map((element) => element.tagName),
    ).toEqual(["DIV"]);
  });

  it("keeps a role=button login control's text when a header link shares it", () => {
    page(
      `<header><a href="/accounts/login/">Log in</a></header>
      <form><input name="email" autocomplete="username"><input name="pass" type="password">
        <div role="button" tabindex="0">Log in</div></form>`,
    );
    const observation = observe();
    expect(observation.complete).toBe(true);
    expect(observation.candidates.map(({ target }) => target)).toContainEqual({
      by: "text",
      value: "Log in",
    });
  });

  it("locates a link without an id by its text, only when no other link or button shares it", () => {
    page(
      `<form><p>my2@example.com</p><input id="pw" type="password">
        <a href="/switch">Use another account</a><a href="/help">Help</a><a href="/faq">Help</a>
        <a href="/s">Sign in</a><a href="/me">Not my2@example.com?</a>
        <button id="go">Sign in</button></form>`,
    );
    expect(observe().candidates.map(({ role, target }) => [role, target])).toEqual([
      ["password", { by: "id", value: "pw" }],
      ["link", { by: "text", value: "Use another account" }],
      ["button", { by: "id", value: "go" }],
    ]);
  });

  it("detects bilingual pages", () => {
    page(
      `<label for="u">User ID / ユーザーID</label><input id="u">
      <label for="p">Password / パスワード</label><input id="p" type="password">
      <button id="go">Login / ログイン</button>`,
    );
    expect(observe().language).toBe("mixed");
  });

  it("refuses a page without candidates", () => {
    page(`<p>No form here</p><a href="/">Home</a>`);
    expect(extractLoginObservation()).toEqual({ ok: false, reason: "no-candidates" });
  });

  it("refuses a login page where nothing can be located", () => {
    // A second shown copy of the form shares the ids and names, and the header shows the
    // button's text too.
    const form = `<form><input id="vp-userid" name="userid">
      <input id="vp-password" name="password" type="password"><button>Log in</button></form>`;
    page(`<header><button>Log in</button></header>${form}<aside>${form}</aside>`);
    expect(extractLoginObservation()).toEqual({ ok: false, reason: "no-locator" });
    // A form with only a field that cannot be filled has nothing to locate.
    page(`<form><input id="pin" type="password" readonly></form>`);
    expect(extractLoginObservation()).toEqual({ ok: false, reason: "no-candidates" });
  });

  it("names each control by data-test before its counter ID (Duolingo, 2026-10-23 and 2026-10-24)", () => {
    // The page behind Duolingo's sign-in overlay keeps its own "ログイン" button.
    page(
      `<header><button data-test="have-account">ログイン</button></header>
      <form><input data-test="email-input" id="web-ui1" type="text">
        <input data-test="password-input" id="web-ui2" type="password">
        <button data-test="register-button" type="submit">ログイン</button></form>`,
    );
    const observation = observe();
    expect(observation.complete).toBe(true);
    // Its IDs count renders: the remembered-account screen gives the password input
    // `web-ui3`, while `data-test` stays.
    expect(observation.candidates.map((candidate) => candidate.target)).toEqual([
      { by: "data-test", value: "email-input" },
      { by: "data-test", value: "password-input" },
      { by: "data-test", value: "register-button" },
    ]);
    expect(findTargets(document, observation.candidates[2]!.target)).toEqual([
      document.querySelector("form button"),
    ]);
  });

  it("names each field by its id before a test attribute every field shares (JetBrains, issue #1413)", () => {
    // JetBrains Account gives every input and button the same test attribute, and swaps
    // its views in place, so the email's `data-test` would find the code input alone later.
    page(
      `<form><input id="email" name="email" autocomplete="username" data-test="input__inner">
        <input id="password" name="password" type="password" data-test="input__inner">
        <button type="submit" data-test="button">Log in</button></form>`,
    );
    expect(observe().candidates.map((candidate) => candidate.target)).toEqual([
      { by: "id", value: "email" },
      { by: "id", value: "password" },
      { by: "data-test", value: "button" },
    ]);
    page(
      `<form><input id="code" name="code" autocomplete="one-time-code" data-test="input__inner">
        <button type="submit" data-test="button">Continue</button></form>`,
    );
    expect(observe().candidates[0]!.target).toEqual({ by: "id", value: "code" });
  });

  it("names a field by its id first, and a button by its test attribute first", () => {
    page(
      `<form><input id="who" type="text" data-testid="who-input">
        <button id="go" data-testid="go-button">Go</button></form>`,
    );
    expect(observe().candidates.map((candidate) => candidate.target)).toEqual([
      { by: "id", value: "who" },
      { by: "test-id", value: "go-button" },
    ]);
  });

  it("produces targets the executor's exact-match lookup resolves to the same element", () => {
    page(
      `<form id="f"><input id="a"><input name="ctl00$Main$b"><input data-testid="c">
        <input name="user[d]"><button id="e">Go</button><button>Log in</button>
        <input type="image" src="data:," alt="Next" width="20" height="20"></form>`,
    );
    const observation = observe();
    expect(observation.complete).toBe(true);
    expect(observation.candidates.map((candidate) => candidate.target.by)).toEqual([
      "id",
      "name",
      "test-id",
      "name",
      "id",
      "text",
      "text",
    ]);
    const elements = [...document.querySelectorAll("#f input, #f button")];
    observation.candidates.forEach((candidate, at) =>
      expect(findTargets(document, candidate.target)).toEqual([elements[at]]),
    );
  });

  it("never takes label text from scripts, styles, markup, hidden text or control contents", () => {
    page(
      `<form id="f">
        <div><span>ユーザーID</span><script>var token = "synthetic-script-secret";</script>
          <style>.a{background:url(/p?token=synthetic-style)}</style>
          <noscript><img src="https://t.example/?uid=synthetic-noscript"></noscript>
          <div style="display:none">synthetic-hidden-div</div>
          <svg width="4" height="4"><title>synthetic-svg-title</title></svg>
          <input id="u"></div>
        <span id="json-ref"></span><script id="json" type="application/json">{"user":"synthetic-json"}</script>
        <div id="hidden-ref" hidden>synthetic-hidden-ref</div>
        <select id="sel"><option>synthetic-option</option></select>
        <input id="a" aria-labelledby="json hidden-ref sel">
        <button id="go">Go <select><option>synthetic-button-option</option></select></button>
      </form>`,
    );
    const result = extractLoginObservation();
    const serialized = JSON.stringify(result);
    for (const leaked of [
      "synthetic-script-secret",
      "synthetic-style",
      "synthetic-noscript",
      "synthetic-hidden-div",
      "synthetic-svg-title",
      "synthetic-json",
      "synthetic-hidden-ref",
      "synthetic-option",
      "synthetic-button-option",
    ])
      expect(serialized).not.toContain(leaked);
    expect(result.ok && result.observation.candidates.map((candidate) => candidate.label)).toEqual([
      "ユーザーID",
      undefined,
      "Go",
    ]);
  });

  it("redacts email addresses, masked text and long numbers", () => {
    page(
      `<h1>t***@gmail.com でログイン</h1>
      <form id="f"><label for="acct">口座番号 ****1234</label><input id="acct">
        <label for="pw">パスワード（４桁）</label><input id="pw" type="password">
        <input id="mail" placeholder="例: someone＠example.jp">
        <button id="go">●●●● taro@example.com 0120１２３４</button></form>`,
      "Taro Yamada taro.yamada@example.com",
    );
    const observation = observe();
    expect(observation.title).toBe("Taro Yamada [email]");
    expect(observation.headings).toEqual(["[email] でログイン"]);
    expect(summary(observation).map(({ label, placeholder }) => label ?? placeholder)).toEqual([
      "口座番号 [masked][number]",
      "パスワード（４桁）",
      "例: [email]",
      "[masked] [email] [number]",
    ]);
  });

  it("sends a path with a matrix parameter as [id], and refuses documents without a location", () => {
    page(`<input id="u">`);
    history.replaceState(null, "", "/login.do;jsessionid=SYNTHETIC123");
    // The whole segment goes, never the session ID (ADR 0039).
    expect(extractLoginObservation()).toMatchObject({ ok: true, observation: { path: "/[id]" } });
    expect(JSON.stringify(extractLoginObservation())).not.toContain("SYNTHETIC123");
    const detached = document.implementation.createHTMLDocument();
    expect(extractLoginObservation(detached)).toEqual({ ok: false, reason: "unsupported-page" });
  });

  it("redacts a whole email address, whatever its local part or domain holds", () => {
    // A local part may hold ' and #, as HTML's valid email address allows, and a domain may
    // be internationalized. Repeated headings are kept once, so each one differs.
    page(
      `<h1>o'brien@example.com</h1><h2>taro#1@example.com さん</h2><h3>taro@例え.jp でログイン</h3>
      <h3>連絡先 taro@例え.日本 まで</h3><h3>ID: taro@例え.日本でログイン中</h3>
      <h3>宛先 taro@mail.例え.日本</h3>
      <form id="f"><input id="u"><input id="pw" type="password"><button id="go">Go</button></form>`,
    );
    // A last label that is not ASCII takes the text glued to it along.
    expect(observe().headings).toEqual([
      "[email]",
      "[email] さん",
      "[email] でログイン",
      "連絡先 [email] まで",
      "ID: [email]",
      "宛先 [email]",
    ]);
  });

  it("keeps the text around an email address, a handle in a URL and a key=value pair", () => {
    page(
      `<h1>taro@example.comでログイン中</h1><h2>youtube.com/@pateat</h2><h3>price=100@shop</h3>
      <form id="f"><input id="u"><input id="pw" type="password"><button id="go">Go</button></form>`,
    );
    expect(observe().headings).toEqual([
      "[email]でログイン中",
      "youtube.com/@pateat",
      "price=[email]",
    ]);
  });

  it("skips hidden inputs and other controls' labels when reading adjacent text", () => {
    page(
      `<form id="f"><table>
        <tr><th>ユーザーID</th><td><input type="hidden" name="csrf"><input id="u"></td></tr>
      </table>
      <input type="checkbox" id="c"><label for="c">保存する</label><input id="v"></form>`,
    );
    expect(summary(observe()).map(({ target, label }) => [target.value, label])).toEqual([
      ["u", "ユーザーID"],
      ["c", "保存する"],
      ["v", undefined],
    ]);
  });

  it("treats selects, radios, text areas and other input types in a login form as unsupported", () => {
    for (const control of [
      `<select id="kind"><option>個人</option></select>`,
      `<input type="radio" id="r" name="kind">`,
      `<textarea id="t"></textarea>`,
      `<input type="url" id="w">`,
      `<input type="search" id="q">`,
      `<input type="date" id="d">`,
    ]) {
      page(`<form id="f"><input id="u"><input id="p" type="password">${control}</form>`);
      expect(observe().complete, control).toBe(false);
    }
    // The same controls elsewhere on the page do not matter.
    page(
      `<form id="lang"><select id="l"><option>日本語</option></select><button>Go</button></form>
      <form id="f"><input id="u"><input id="p" type="password"><button id="go">Log in</button></form>`,
    );
    const observation = observe();
    expect(observation.complete).toBe(true);
    expect(observation.candidates.map((candidate) => candidate.target.value)).toEqual([
      "u",
      "p",
      "go",
    ]);
  });

  it("ignores unlocatable controls outside the login form but not inside it", () => {
    page(
      `<header><button>☰</button><button>☰</button></header>
      <form id="f"><input id="u"><button id="go">Log in</button></form>`,
    );
    expect(observe().complete).toBe(true);
    expect(observe().candidates.map((candidate) => candidate.target.value)).toEqual(["u", "go"]);
    page(
      `<form id="f"><input id="u"><input type="checkbox" required><button id="go">Log in</button></form>`,
    );
    expect(observe().complete).toBe(false);
  });

  it("leaves out a checkbox it cannot locate unless the page requires it (Stripe, 2026-10-23)", () => {
    // Stripe's and 1Password's "Remember me" carry only a per-load React ID and are named
    // by `aria-labelledby`; a checkbox is never checked by a recipe, only context.
    const form = (checkbox: string) =>
      `<form id="f"><input id="u" type="email"><input id="p" type="password">
        <input type="checkbox" id="react-aria1-:r9:" aria-labelledby="remember" ${checkbox}>
        <span id="remember">Remember me</span><button id="go">Log in</button></form>`;
    page(form(""));
    let observation = observe();
    expect(observation.complete).toBe(true);
    expect(observation.candidates.map((candidate) => candidate.target.value)).toEqual([
      "u",
      "p",
      "go",
    ]);
    for (const required of ["required", `aria-required="true"`]) {
      page(form(required));
      observation = observe();
      expect(observation.complete, required).toBe(false);
    }
    // A located checkbox stays as context.
    page(
      `<form id="f"><input id="u"><input type="checkbox" id="keep"><button id="go">Log in</button></form>`,
    );
    expect(observe().candidates.map((candidate) => candidate.target.value)).toEqual([
      "u",
      "keep",
      "go",
    ]);
  });

  it("leaves out a show-password icon button without a locator, such as モッピー's and LinkedIn's", () => {
    const toggle = `<button type="button" aria-label="Show password"><svg width="16" height="16"></svg></button>`;
    page(
      `<form><input name="mail"><input name="pass" type="password">${toggle}
        <button type="submit">Log in</button></form>`,
    );
    let observation = observe();
    expect(observation.complete).toBe(true);
    expect(observation.candidates.map((candidate) => candidate.target.value)).toEqual([
      "mail",
      "pass",
      "Log in",
    ]);
    page(
      `<div><input id="u"><input id="p" type="password">${toggle}<button type="button">Sign in</button></div>`,
    );
    observation = observe();
    expect(observation.complete).toBe(true);
    expect(observation.candidates.map((candidate) => candidate.target.value)).toEqual([
      "u",
      "p",
      "Sign in",
    ]);
    // A script-submitted button with text but no unique locator still does, as on a
    // page with two sign-in forms and two "Login" buttons.
    page(
      `<form><input name="u1"><input name="p1" type="password"><input type="button" value="Login"></form>
      <form><input name="u2"><input name="p2" type="password"><input type="button" value="Login"></form>`,
    );
    expect(observe().complete).toBe(false);
    // A textless button outside every form submits nothing, whatever its type, as a
    // cookie banner's close button beside Bank of America's formless sign-in fields.
    page(
      `<main><section><div><input id="u"><input id="p" type="password">
        <button type="button">Sign in</button></div></section></main>
      <div id="banner"><div><div><button aria-label="Close" style="width:16px;height:16px">
      </button></div></div></div>`,
    );
    observation = observe();
    expect(observation.complete).toBe(true);
    expect(observation.candidates.map((candidate) => candidate.target.value)).toEqual([
      "u",
      "p",
      "Sign in",
    ]);
    // Without another button to submit with, it may be the script-run submit itself,
    // and so it may beside the fields even when a button elsewhere is located.
    const submit = `<button style="width:16px;height:16px"></button>`;
    for (const other of ["", `<header><button id="menu">Menu</button></header>`])
      for (const fields of [
        `<div><input id="u"><input id="p" type="password">${submit}</div>`,
        `<div><div><input id="u"></div><div><input id="p" type="password"></div>
          <div><span><span>${submit}</span></span></div></div>`,
      ]) {
        page(`${other}<main><section>${fields}</section></main>`);
        expect(observe().complete, other + fields).toBe(false);
      }
    // One with an accessible name is named by it (ADR 0048 amendment of 2026-10-23).
    page(
      `<main><section><div><input id="u"><input id="p" type="password">
        <button aria-label="Sign in" style="width:16px;height:16px"></button></div></section></main>`,
    );
    observation = observe();
    expect(observation.complete).toBe(true);
    expect(observation.candidates.at(-1)?.target).toEqual({
      by: "accessible-name",
      value: "Sign in",
    });
    // Inside a form, a textless submit button still counts beside another located one.
    page(
      `<form><input name="mail"><input name="pass" type="password">${toggle}
        <button style="width:16px;height:16px"></button></form>`,
    );
    expect(observe().complete).toBe(false);
    // An icon button may be the form's only, script-run submit, so there it still does.
    page(`<form><input name="mail"><input name="pass" type="password">${toggle}</form>`);
    expect(observe().complete).toBe(false);
    // A submit button without a locator still marks the login form incomplete.
    page(
      `<form><input name="mail"><input name="pass" type="password">
        <button type="submit"><svg width="16" height="16"></svg></button></form>`,
    );
    expect(observe().complete).toBe(false);
  });

  it("judges completeness by the login form and leaves out other flawed forms", () => {
    const login = `<form id="f"><input id="u"><input id="p" type="password"><button id="go">Log in</button></form>`;
    const targets = () => observe().candidates.map((candidate) => candidate.target.value);
    // A search form with a category select and a submit button without a locator.
    page(
      `<form id="s"><select id="cat"><option>All</option></select><input id="q"><input type="submit"></form>${login}`,
    );
    expect(observe().complete).toBe(true);
    expect(targets()).toEqual(["u", "p", "go"]);
    // A form without a flaw stays as context.
    page(`<form id="s"><input id="q"><button id="find">Search</button></form>${login}`);
    expect(observe().complete).toBe(true);
    expect(targets()).toEqual(["q", "find", "u", "p", "go"]);
    // Sign-up forms: two password fields, or a new-password field.
    page(
      `<form id="r"><input id="ru"><input id="rp" type="password"><input id="rc" type="password"><select id="year"><option>2000</option></select></form>${login}`,
    );
    expect(observe().complete).toBe(true);
    expect(targets()).toEqual(["u", "p", "go"]);
    page(
      `<form id="r"><input id="ru"><input id="rp" type="password" autocomplete="new-password"><input type="radio" id="g"></form>${login}`,
    );
    expect(observe().complete).toBe(true);
    // An identifier-first login form counts as much as a one-password form.
    const identifier = (extra: string) =>
      `<form id="f"><input id="u" autocomplete="username">${extra}<button id="next">Next</button></form>`;
    page(
      `${identifier(`<input type="radio" id="kind">`)}<form id="r"><input id="re" type="email"><input id="rp" type="password"><button id="join">Join</button></form>`,
    );
    expect(observe().complete).toBe(false);
    page(
      `${identifier(`<select id="kind"><option>A</option></select>`)}<form id="r"><input id="re"><input id="rp" type="password"><input id="rc" type="password"></form>`,
    );
    expect(observe().complete).toBe(false);
    page(
      `<form id="s"><select id="cat"><option>All</option></select><input id="q"></form>${identifier("")}`,
    );
    expect(observe().complete).toBe(true);
    expect(targets()).toEqual(["u", "next"]);
    // Without a login-like form, a password form counts, then every form.
    page(
      `<form id="r"><input id="ru"><input id="rp" type="password"><input id="rc" type="password"><select id="year"><option>2000</option></select></form>`,
    );
    expect(observe().complete).toBe(false);
    page(
      `<form id="s"><select id="cat"><option>All</option></select><input id="q"></form>
      <form id="f"><input id="u"><button id="next">Next</button></form>`,
    );
    expect(observe().complete).toBe(false);
    // A read-only password field still marks its form as the login form.
    page(
      `<form id="s"><select id="cat"><option>All</option></select><input id="q"></form>
      <form id="f"><input id="u"><input id="p" type="password" readonly><button id="go">Log in</button></form>`,
    );
    expect(observe().complete).toBe(false);
    // A control the executor cannot act on in a component's shadow tree flaws the form that
    // holds the component, which is left out when it is not the login form (ADR 0070).
    page(`<form id="s"><input id="q"><div id="host"></div></form>${login}`);
    shadow("#host", `<select><option>All</option></select>`);
    expect(observe().complete).toBe(true);
    expect(targets()).toEqual(["u", "p", "go"]);
    // Two login forms sharing field names leave both fields without a locator.
    page(
      `<form id="h"><input name="user"><input name="pass" type="password"><button id="hgo">Go</button></form>
      <form id="m"><input name="user"><input name="pass" type="password"><button id="mgo">Log in</button></form>`,
    );
    expect(observe().complete).toBe(false);
  });

  it("names a field by its name in the sign-in form when another form repeats it (Hacker News)", () => {
    // Hacker News's /login (2026-10-23): a create-account form below repeats the names.
    const form = (creating: string, password: string, submit: string) =>
      `<form method="post">${creating}<table>
        <tr><td>username:</td><td><input type="text" name="acct" autocomplete="username"></td></tr>
        <tr><td>password:</td><td><input type="password" name="pw" autocomplete="${password}"></td></tr>
      </table><input type="submit" value="${submit}"></form>`;
    page(
      `<b>Login</b>${form("", "current-password", "login")}
      <b>Create Account</b>${form(`<input type="hidden" name="creating" value="t">`, "new-password", "create account")}`,
    );
    const observation = observe();
    expect(observation.complete).toBe(true);
    expect(observation.candidates.map((candidate) => candidate.target)).toEqual([
      { by: "password-form-name", value: "acct" },
      { by: "autocomplete", value: "current-password" },
      { by: "text", value: "login" },
    ]);
    expect(findTargets(document, observation.candidates[0]!.target)).toEqual([
      document.querySelector("input[name=acct]"),
    ]);
    // Two sign-in forms that repeat the name stay ambiguous.
    page(`${form("", "current-password", "login")}${form("", "current-password", "go")}`);
    expect(observe().complete).toBe(false);
    // Continuing a recipe, the filled field shown read-only again is left out.
    page(
      `${form("", "current-password", "login").replace('name="acct"', 'name="acct" readonly')}
      ${form(`<input type="hidden" name="creating" value="t">`, "new-password", "create account")}`,
    );
    const result = extractLoginObservation(document, [{ by: "password-form-name", value: "acct" }]);
    if (!result.ok) throw new Error(result.reason);
    expect(result.observation.complete).toBe(true);
    expect(result.observation.candidates.map(({ target }) => target)).toEqual([
      { by: "autocomplete", value: "current-password" },
      { by: "text", value: "login" },
    ]);
  });

  it("describes a pointer link without href as the login's button (IIJmio, 2026-10-23)", () => {
    page(
      `<div><input name="j_username"><input name="j_password" type="password">
        <a class="pink_btn" style="cursor:pointer">ログイン</a></div>`,
    );
    const observation = observe();
    expect(observation.complete).toBe(true);
    expect(summary(observation).map(({ role, target }) => [role, target])).toEqual([
      ["text", { by: "name", value: "j_username" }],
      ["password", { by: "name", value: "j_password" }],
      ["button", { by: "text", value: "ログイン" }],
    ]);
  });

  it("describes a pointer tab stop in a login form as its button (2026-11-07)", () => {
    page(
      `<form><input name="email" type="email"><input name="password" type="password">
        <div tabindex="0" style="cursor:pointer"><p>ログイン</p></div>
        <label tabindex="0" style="cursor:pointer" for="rm">ログインしたままにする</label></form>`,
    );
    const observation = observe();
    expect(observation.complete).toBe(true);
    expect(summary(observation).map(({ role, target }) => [role, target])).toEqual([
      ["email", { by: "name", value: "email" }],
      ["password", { by: "name", value: "password" }],
      ["button", { by: "text", value: "ログイン" }],
    ]);
  });

  it("treats every control outside a form as part of a formless login", () => {
    page(`<input id="u"><input id="p" type="password"><button>Sign in</button>`);
    expect(observe().complete).toBe(true);
    page(`<input id="u"><input id="p" type="password"><button>Sign in</button><input name="">`);
    expect(observe().complete).toBe(false);
  });

  it("groups by the form owner, including the form attribute", () => {
    page(`<form id="f"></form><input id="u" form="f"><button id="go" form="f">Go</button>`);
    expect(observe().candidates.map((candidate) => candidate.group)).toEqual(["f1", "f1"]);
  });

  it("keeps the first fields in document order and never lets links displace them", () => {
    page(
      `<form id="f">${Array.from(
        { length: 50 },
        (_, index) => `<a id="l${index}" href="/${index}">Link</a><input id="i${index}">`,
      ).join("")}</form>`,
    );
    const observation = observe();
    expect(observation.complete).toBe(false);
    expect(observation.candidates.map((candidate) => candidate.target.value)).toEqual(
      Array.from({ length: 48 }, (_, index) => `i${index}`),
    );
  });

  it("skips inputs moved before the page start or collapsed, and keeps ones far right", () => {
    page(
      `<form id="f" style="width:${innerWidth + 400}px"><input id="u">
        <input id="trap" style="position:absolute;left:-9999px">
        <input id="above" style="position:absolute;top:-9999px">
        <details><summary>More</summary><input id="inside"></details>
        <input id="p" type="password" style="position:relative;left:${innerWidth}px">
        <button id="go">Go</button></form>`,
    );
    const observation = observe();
    expect(observation.complete).toBe(true);
    expect(observation.candidates.map((candidate) => candidate.target.value)).toEqual([
      "u",
      "p",
      "go",
    ]);
  });

  it("marks fields it cannot fill incomplete instead of dropping them", () => {
    for (const field of [
      `<input id="p" type="password" readonly>`,
      `<input id="p" type="password" disabled>`,
      `<input id="p" type="password" style="opacity:0">`,
      `<input id="p" style="width:1px;height:1px;padding:0;border:0">`,
    ]) {
      page(`<form id="f"><input id="u">${field}<button id="go">ログイン</button></form>`);
      const observation = observe();
      expect(observation.complete, field).toBe(false);
      expect(observation.candidates.map((candidate) => candidate.target.value)).toEqual([
        "u",
        "go",
      ]);
    }
    // A software-keyboard-only form is still recognized as a login form.
    page(`<form id="f"><input id="p" type="password" readonly><button id="go">Go</button></form>`);
    expect(observe().complete).toBe(false);
  });
}
