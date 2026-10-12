import type { LoginObservation } from "@pateat/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findTargets } from "../page/targets";
import { extractLoginObservation, extractSignedInObservation } from "./extract";

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
  it("reads a Japanese bank table layout with adjacent-cell labels", () => {
    page(
      `<h1>インターネットバンキング</h1>
      <form id="login"><table>
        <tr><th>支店番号</th><td><input id="branch" type="tel" maxlength="3" inputmode="numeric"></td></tr>
        <tr><th>口座番号</th><td><input name="acct" type="tel" maxlength="7"></td></tr>
        <tr><th>ログインパスワード</th><td><input id="pw" type="password"></td></tr>
      </table>
      <button id="go" type="submit">ログイン</button>
      <a id="first" href="/first">初めてご利用の方</a></form>`,
      "ログイン | Example銀行",
    );
    const observation = observe();
    expect(observation).toMatchObject({
      version: 1,
      origin: location.origin,
      path: location.pathname,
      language: "ja",
      title: "ログイン | Example銀行",
      headings: ["インターネットバンキング"],
      complete: true,
    });
    expect(observation.candidates.map((candidate) => candidate.id)).toEqual([
      "c1",
      "c2",
      "c3",
      "c4",
      "c5",
    ]);
    expect(summary(observation)).toEqual([
      {
        role: "tel",
        target: { by: "id", value: "branch" },
        label: "支店番号",
        group: "f1",
        maxLength: 3,
        inputMode: "numeric",
      },
      {
        role: "tel",
        target: { by: "name", value: "acct" },
        label: "口座番号",
        group: "f1",
        maxLength: 7,
      },
      {
        role: "password",
        target: { by: "id", value: "pw" },
        label: "ログインパスワード",
        group: "f1",
      },
      { role: "button", target: { by: "id", value: "go" }, label: "ログイン", group: "f1" },
      {
        role: "link",
        target: { by: "id", value: "first" },
        label: "初めてご利用の方",
        group: "f1",
      },
    ]);
  });

  it("never reads values, hidden inputs, query strings or body text", () => {
    history.replaceState(null, "", `${location.pathname}?session=synthetic-query-token`);
    page(
      `<p>山田 synthetic-body-name 様の前回ログイン</p>
      <form id="f"><input type="hidden" name="csrf" value="synthetic-hidden-token">
        <label for="user">User ID</label><input id="user" value="synthetic-user-value">
        <label for="pass">Password</label><input id="pass" type="password" value="synthetic-secret">
        <input id="go" type="submit" value="Sign in"></form>`,
    );
    const user = document.querySelector<HTMLInputElement>("#user")!;
    user.value = "synthetic-typed-value";
    const result = extractLoginObservation();
    const serialized = JSON.stringify(result);
    for (const secret of [
      "synthetic-query-token",
      "synthetic-body-name",
      "synthetic-hidden-token",
      "synthetic-user-value",
      "synthetic-typed-value",
      "synthetic-secret",
      "csrf",
    ])
      expect(serialized).not.toContain(secret);
    expect(result.ok && summary(result.observation)).toEqual([
      { role: "text", target: { by: "id", value: "user" }, label: "User ID", group: "f1" },
      { role: "password", target: { by: "id", value: "pass" }, label: "Password", group: "f1" },
      { role: "button", target: { by: "id", value: "go" }, label: "Sign in", group: "f1" },
    ]);
    expect(result.ok && result.observation.language).toBe("en");
  });

  it("skips hidden, off-page, disabled and read-only fields but keeps disabled buttons", () => {
    page(
      `<form id="f">
        <input id="user" autocomplete="section-a username webauthn">
        <input id="trap" style="position:absolute;left:-9999px">
        <input id="gone" style="display:none">
        <div aria-hidden="true"><input id="aria"></div>
        <input id="invisible" style="visibility:hidden">
        <input id="off" disabled>
        <input id="ro" type="password" readonly>
        <input id="pw" type="password" autocomplete="current-password">
        <input id="file" type="file"><input id="radio" type="radio" name="kind">
        <button id="reset" type="reset">Clear</button>
        <button id="go" disabled>Log in</button></form>`,
    );
    // The radio and file inputs are visible controls the executor cannot fill.
    expect(observe().complete).toBe(false);
    expect(summary(observe()).map((candidate) => [candidate.target.value, candidate])).toEqual([
      [
        "user",
        {
          role: "text",
          target: { by: "id", value: "user" },
          autocomplete: "username",
          group: "f1",
        },
      ],
      [
        "pw",
        {
          role: "password",
          target: { by: "id", value: "pw" },
          autocomplete: "current-password",
          group: "f1",
        },
      ],
      ["go", { role: "button", target: { by: "id", value: "go" }, label: "Log in", group: "f1" }],
    ]);
  });

  it("takes labels from ARIA, label elements, definition lists and title", () => {
    page(
      `<span id="lead">会員</span><span id="tail">番号</span>
      <input id="a" aria-labelledby="lead tail" aria-label="ignored">
      <input id="b" aria-label="メールアドレス">
      <label>パスワード <input id="c" type="password"></label>
      <dl><dt>暗証番号</dt><dd><input id="d" type="password" inputmode="numeric" maxlength="4"></dd></dl>
      <input id="e" title="合言葉" placeholder="例: さくら">
      <button id="f"><img src="data:," alt="ログイン"></button>
      <input id="g" type="checkbox"><label for="g">ログイン状態を保持</label>`,
    );
    expect(summary(observe())).toEqual([
      { role: "text", target: { by: "id", value: "a" }, label: "会員 番号" },
      { role: "text", target: { by: "id", value: "b" }, label: "メールアドレス" },
      { role: "password", target: { by: "id", value: "c" }, label: "パスワード" },
      {
        role: "password",
        target: { by: "id", value: "d" },
        label: "暗証番号",
        maxLength: 4,
        inputMode: "numeric",
      },
      {
        role: "text",
        target: { by: "id", value: "e" },
        label: "合言葉",
        placeholder: "例: さくら",
      },
      { role: "button", target: { by: "id", value: "f" }, label: "ログイン" },
      { role: "checkbox", target: { by: "id", value: "g" }, label: "ログイン状態を保持" },
    ]);
  });

  it("does not borrow a label across another field's area", () => {
    page(`<div><span>Customer number</span><input id="one"><input id="two"></div>`);
    expect(summary(observe())).toEqual([
      { role: "text", target: { by: "id", value: "one" }, label: "Customer number" },
      { role: "text", target: { by: "id", value: "two" } },
    ]);
  });

  it("drops odd input constraints instead of the observation", () => {
    page(
      `<input id="big" maxlength="524288">
      <input id="swap" maxlength="3" minlength="5">
      <input id="num" type="number" maxlength="4" inputmode="numeric">
      <input id="mode" inputmode="kana">`,
    );
    expect(summary(observe())).toEqual([
      { role: "text", target: { by: "id", value: "big" } },
      { role: "text", target: { by: "id", value: "swap" } },
      { role: "number", target: { by: "id", value: "num" }, inputMode: "numeric" },
      { role: "text", target: { by: "id", value: "mode" } },
    ]);
  });

  it("bounds text and strips control and format characters", () => {
    page(`<input id="x" aria-label="a​b‮c ${"長".repeat(200)}">`, "Sign in");
    const observation = observe();
    expect(observation.title).toBe("Sign in");
    const label = observation.candidates[0]!.label!;
    // Format characters vanish; they could otherwise split a redacted digit run.
    expect(label.startsWith("abc 長")).toBe(true);
    expect(label.length).toBe(120);
  });

  it("does not split a surrogate pair when truncating", () => {
    page(`<input id="x" aria-label="${"a".repeat(119)}𠮷">`);
    expect(observe().candidates[0]!.label).toBe("a".repeat(119));
  });

  it("locates by name or test ID when the ID is missing, duplicated or unusable", () => {
    page(
      `<form id="f"><input id="dup" name="user"><input id="dup" name="other" data-testid="t-other">
        <input id="has space" name="pin">
        <button id="go">Go</button></form>`,
    );
    expect(summary(observe()).map((candidate) => candidate.target)).toEqual([
      { by: "name", value: "user" },
      { by: "name", value: "other" },
      { by: "name", value: "pin" },
      { by: "id", value: "go" },
    ]);
  });

  it("marks the observation incomplete when a field or button cannot be targeted", () => {
    page(`<form><input id="user"><input type="password"><button id="go">ログイン</button></form>`);
    expect(observe().complete).toBe(false);
    expect(observe().candidates.map((candidate) => candidate.target.value)).toEqual(["user", "go"]);
    page(`<form><input id="user"><button>ログイン</button><button>ログイン</button></form>`);
    expect(observe().complete).toBe(false);
  });

  it("locates a button without attributes by its exact, unredacted text", () => {
    page(
      `<form><input id="user"><button class="btn"> <span>ログ</span><span>イン</span>
        <svg><text>icon</text></svg></button>
        <input type="submit" value="Sign  in"><input type="image" src="data:," alt="送信" width="40" height="20">
        <button>Call 0120123456</button><input type="button" value="${"x".repeat(121)}"></form>
      <button>ヘルプ</button><button>ヘルプ</button>`,
    );
    const observation = observe();
    expect(observation.complete).toBe(false);
    expect(summary(observation).map(({ role, target, label }) => [role, target, label])).toEqual([
      ["text", { by: "id", value: "user" }, undefined],
      ["button", { by: "text", value: "ログイン" }, "ログイン"],
      ["button", { by: "text", value: "Sign in" }, "Sign in"],
      ["button", { by: "text", value: "送信" }, "送信"],
    ]);
  });

  it("observes script buttons, and never lets one take a native button's text", () => {
    page(
      `<div role="button">ログイン</div>
      <form name="loginForm"><input id="userId"><input id="password" type="password">
        <a id="loginButtonAD" onclick="document.loginForm.submit()">ログイン</a>
        <span role="button" aria-label="Show password"></span><a class="plain">ヘルプ</a>
        <button>ログイン</button></form>`,
    );
    const observation = observe();
    // A script button without a locator is left out without making the page incomplete,
    // and a native button keeps its text locator: text names native buttons first.
    expect(observation.complete).toBe(true);
    expect(summary(observation).map(({ role, target, label }) => [role, target, label])).toEqual([
      ["text", { by: "id", value: "userId" }, undefined],
      ["password", { by: "id", value: "password" }, undefined],
      ["button", { by: "id", value: "loginButtonAD" }, "ログイン"],
      ["button", { by: "text", value: "ログイン" }, "ログイン"],
    ]);
  });

  it("observes links that run a script as buttons, such as MyJCB's and SMBC Direct's", () => {
    page(
      `<form name="loginForm"><input id="userId"><input id="password" type="password">
        <a id="loginButtonAD" name="loginButtonAD" href="#" onclick="document.loginForm.submit();return false;">ID・パスワードでログイン</a>
        <a href="javascript:;" class="js-login-submit" onclick="login()"><span>ログイン</span></a>
        <a href="/forgot">パスワードをお忘れの方</a><a href="#top">ページトップへ</a></form>`,
    );
    const observation = observe();
    expect(observation.complete).toBe(true);
    expect(summary(observation).map(({ role, target }) => [role, target])).toEqual([
      ["text", { by: "id", value: "userId" }],
      ["password", { by: "id", value: "password" }],
      ["button", { by: "id", value: "loginButtonAD" }],
      ["button", { by: "text", value: "ログイン" }],
      ["link", { by: "text", value: "パスワードをお忘れの方" }],
      ["link", { by: "text", value: "ページトップへ" }],
    ]);
    // The executor resolves the text locator to the script link alone.
    expect(findTargets(document, { by: "text", value: "ログイン" })).toEqual([
      document.querySelector(".js-login-submit"),
    ]);
  });

  it("names a script link by text only when no native button shows it", () => {
    page(
      `<a id="tab" href="#" onclick="activateLoginTab()">Login</a>
      <form><input name="email"><input name="password" type="password">
        <a href="javascript:;" onclick="help()">Help</a><a href="#" onclick="help()">Help</a>
        <a href="javascript:;" onclick="login()">Login</a><input type="submit" value="Login"></form>`,
    );
    const observation = observe();
    expect(observation.complete).toBe(true);
    expect(summary(observation).map(({ role, target }) => [role, target])).toEqual([
      ["text", { by: "name", value: "email" }],
      ["password", { by: "name", value: "password" }],
      ["button", { by: "text", value: "Login" }],
    ]);
    expect(findTargets(document, { by: "text", value: "Login" })).toEqual([
      document.querySelector("input[type=submit]"),
    ]);
  });

  it("gives a script link no text locator while a hidden native button carries its text", () => {
    page(
      `<form><input id="user"><input id="pass" type="password">
        <a href="javascript:;" onclick="login()">ログイン</a><button hidden>ログイン</button></form>`,
    );
    const observation = observe();
    expect(summary(observation).map(({ role }) => role)).toEqual(["text", "password"]);
  });

  it("gives a script link no text locator when a shown native button renders its text", () => {
    page(
      `<form><input id="user"><input id="pass" type="password">
        <a href="javascript:;" onclick="login()">Sign in</a><button id="go"><div>Sign</div><div>in</div></button></form>`,
    );
    const observation = observe();
    expect(summary(observation).map(({ role, target }) => [role, target])).toEqual([
      ["text", { by: "id", value: "user" }],
      ["password", { by: "id", value: "pass" }],
      ["button", { by: "id", value: "go" }],
    ]);
  });

  it("names an image-only button by its image's alt, as the executor resolves it", () => {
    page(
      `<form><input id="user"><button><img src="data:," alt="ログイン" width="40" height="20"></button></form>`,
    );
    const observation = observe();
    expect(observation.complete).toBe(true);
    expect(observation.candidates[1]!.target).toEqual({ by: "text", value: "ログイン" });
    expect(findTargets(document, observation.candidates[1]!.target)).toEqual([
      document.querySelector("button"),
    ]);
  });

  it("observes image buttons as buttons named by their alt text", () => {
    page(
      `<form><input id="user"><input id="go" type="image" src="data:," alt="ログイン" width="40" height="20"></form>`,
    );
    const observation = observe();
    expect(observation.complete).toBe(true);
    expect(observation.candidates[1]).toMatchObject({
      role: "button",
      target: { by: "id", value: "go" },
      label: "ログイン",
    });
  });

  it("keeps only links inside a form with fields, without affecting completeness", () => {
    page(
      `<nav><a id="home" href="/">Home</a></nav>
      <form id="search"><button id="s">Search</button><a id="adv" href="/adv">Advanced</a></form>
      <form id="login"><input id="user"><a href="/help">Help</a><a id="reset" href="/reset">Forgot?</a>
        <button id="go">Sign in</button></form>`,
    );
    const observation = observe();
    expect(observation.complete).toBe(true);
    expect(
      observation.candidates.map((candidate) => [candidate.target.value, candidate.group]),
    ).toEqual([
      ["user", "f1"],
      ["Help", "f1"],
      ["reset", "f1"],
      ["go", "f1"],
    ]);
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

  it("caps candidates at the contract limit and marks the rest missing", () => {
    page(
      `<form id="f">${Array.from({ length: 50 }, (_, index) => `<input id="i${index}">`).join("")}</form>`,
    );
    const observation = observe();
    expect(observation.complete).toBe(false);
    expect(observation.candidates).toHaveLength(48);
  });

  it("marks inputs inside a shadow root as unreachable", () => {
    page(`<input id="user"><div id="host"></div>`);
    const shadow = document.querySelector("#host")!.attachShadow({ mode: "open" });
    shadow.innerHTML = `<input id="pw" type="password">`;
    expect(observe().complete).toBe(false);
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

  it("refuses paths with matrix parameters and documents without a location", () => {
    page(`<input id="u">`);
    history.replaceState(null, "", "/login.do;jsessionid=SYNTHETIC123");
    expect(extractLoginObservation()).toEqual({ ok: false, reason: "unsupported-page" });
    const detached = document.implementation.createHTMLDocument();
    expect(extractLoginObservation(detached)).toEqual({ ok: false, reason: "unsupported-page" });
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
      `<header><button>☰</button><input type="image" src="data:," alt="検索" width="20" height="20"></header>
      <form id="f"><input id="u"><button id="go">Log in</button></form>`,
    );
    expect(observe().complete).toBe(true);
    page(
      `<form id="f"><input id="u"><input type="checkbox"><button id="go">Log in</button></form>`,
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
    // A shadow-root control leaves out a form other than the login form.
    page(`<form id="s"><input id="q"><div id="host"></div></form>${login}`);
    document
      .querySelector("#host")!
      .attachShadow({ mode: "open" }).innerHTML = `<button>Voice</button>`;
    expect(observe().complete).toBe(true);
    expect(targets()).toEqual(["u", "p", "go"]);
    // Two login forms sharing field names leave both fields without a locator.
    page(
      `<form id="h"><input name="user"><input name="pass" type="password"><button id="hgo">Go</button></form>
      <form id="m"><input name="user"><input name="pass" type="password"><button id="mgo">Log in</button></form>`,
    );
    expect(observe().complete).toBe(false);
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

  it("keeps a disabled submit input as a button", () => {
    page(
      `<form id="f"><input id="u"><input id="go" type="submit" value="ログイン" disabled></form>`,
    );
    expect(summary(observe())).toContainEqual({
      role: "button",
      target: { by: "id", value: "go" },
      label: "ログイン",
      group: "f1",
    });
  });

  it("ignores shadow-root controls outside the login form", () => {
    page(`<form id="f"><input id="u"><button id="go">Go</button></form><div id="host"></div>`);
    document
      .querySelector("#host")!
      .attachShadow({ mode: "open" }).innerHTML = `<button>Chat</button>`;
    expect(observe().complete).toBe(true);
  });

  it("marks a field in any shadow root incomplete", () => {
    page(
      `<form id="s"><input name="q" aria-label="検索"><button id="sb">検索</button></form>
      <form id="login"><div id="host"></div></form>`,
    );
    document
      .querySelector("#host")!
      .attachShadow({ mode: "open" }).innerHTML = `<input id="u"><input id="p" type="password">`;
    expect(observe().complete).toBe(false);
    page(`<form id="f"><input id="u"><button id="go">Go</button></form><div id="host"></div>`);
    document.querySelector("#host")!.attachShadow({
      mode: "open",
    }).innerHTML = `<label>Analytics <input type="checkbox"></label>`;
    expect(observe().complete).toBe(true);
  });

  it("separates text at line breaks", () => {
    page(`<label for="u">User<br>ID</label><input id="u">`);
    expect(observe().candidates[0]!.label).toBe("User ID");
  });

  it("refuses paths that may carry a session ID or token, on both extractors", () => {
    page(`<input id="u"><input id="p" type="password"><button id="go">Log in</button>`);
    const magento = btoa("https://shop.example/en/?SID=synthetic0session1&___SID=U")
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replaceAll("=", ",");
    for (const refused of [
      "/(S(lit3py55t21z5))/default.aspx",
      `/customer/account/login/referer/${magento}/`,
      // An `=`, such as base64 padding.
      "/login/referer/Lw==/",
      "/login/next/%2Faccount%3Fsid%3Dabc/",
      "/login/next/%252Faccount%253Fsid%253Dabc/",
      "/reset-password/V1StGXR8_Z5jdHi6B-myT",
      "/login/%3Bjsessionid%3Dabc",
      "/session/123e4567-e89b-12d3-a456-426614174000/login",
      "/s/0123456789abcdef0123456789abcdef/login",
      "/login/sid1234567890123456",
    ]) {
      history.replaceState(null, "", refused);
      expect(extractLoginObservation(), refused).toEqual({ ok: false, reason: "unsupported-page" });
      expect(extractSignedInObservation(), refused).toEqual({
        ok: false,
        reason: "unsupported-page",
      });
    }
    for (const allowed of [
      "/customer/account/login/",
      "/ib/login-2fa-step2",
      "/en-us/internationalization/signin",
      "/user/12345/login",
      "/login/%E3%83%AD%E3%82%B0%E3%82%A4%E3%83%B3",
      "/login/%E3%83",
      "/campaign-2024-summer-login",
      "/tenant.onmicrosoft.com/B2C_1_signupsignin1/oauth2",
    ]) {
      history.replaceState(null, "", allowed);
      expect(extractLoginObservation().ok, allowed).toBe(true);
      expect(extractSignedInObservation().ok, allowed).toBe(true);
    }
  });

  it("detects language without counting redaction placeholders", () => {
    page(
      `<form id="f"><label for="a">口座番号 ****1234</label><input id="a">
        <label for="m">メール t***@gmail.com</label><input id="m">
        <label for="p">暗証 1234 5678</label><input id="p" type="password">
        <button id="go">ログイン</button></form>`,
      "ログイン",
    );
    expect(observe().language).toBe("ja");
  });

  it("redacts digit runs split by zero-width characters", () => {
    page(`<input id="u" aria-label="口座 1​2​3​4​5​6​7">`);
    expect(observe().candidates[0]!.label).toBe("口座 [number]");
  });

  it("separates block text and bounds large label sources", () => {
    page(
      `<table><tr><th><div>Customer</div><div>Number</div></th><td><input id="u"></td></tr></table>`,
    );
    expect(observe().candidates[0]!.label).toBe("Customer Number");
    page(`<label for="u">${"<span>ラベル</span>".repeat(20000)}</label><input id="u">`);
    expect(observe().candidates[0]!.label!.length).toBeLessThanOrEqual(120);
  });
});

describe("extractSignedInObservation", () => {
  const signedIn = (): LoginObservation => {
    const result = extractSignedInObservation();
    if (!result.ok) throw new Error(`no observation: ${result.reason}`);
    return result.observation;
  };

  it("describes a page without a form by its buttons and links", () => {
    page(
      `<header><nav><a id="home" href="/home">Home</a>
        <a id="account" href="/account">Account 1234-5678</a></nav>
        <button id="logout" type="button">Sign out</button></header>
      <h1>Welcome back</h1>
      <select id="lang"><option>English</option></select>
      <p>Balance</p>`,
      "Accounts",
    );
    const observation = signedIn();
    expect(observation).toMatchObject({
      complete: true,
      title: "Accounts",
      headings: ["Welcome back"],
    });
    expect(summary(observation)).toEqual([
      { role: "link", target: { by: "id", value: "home" }, label: "Home" },
      { role: "link", target: { by: "id", value: "account" }, label: "Account [number]-[number]" },
      { role: "button", target: { by: "id", value: "logout" }, label: "Sign out" },
    ]);
  });

  it("never locates by an id or name that carries an email address or a long number", () => {
    page(
      `<a id="acct-0123456789" href="/a">Account</a>
      <a id="card-0123456789" href="/c">Card 0123456789</a>
      <button name="alice@example.com" type="button">Profile</button>
      <button id="logout" name="user-123456" type="button">Sign out</button>`,
    );
    // The first link falls back to its text; the second has no other locator, so it is
    // left out; the buttons fall back to their text and id.
    expect(summary(signedIn())).toEqual([
      { role: "link", target: { by: "text", value: "Account" }, label: "Account" },
      { role: "button", target: { by: "text", value: "Profile" }, label: "Profile" },
      { role: "button", target: { by: "id", value: "logout" }, label: "Sign out" },
    ]);

    page(`<form><input id="note-0123456789" type="text" aria-label="Note"></form>
      <button id="logout" type="button">Sign out</button>`);
    // A field that cannot be located safely makes the description incomplete.
    expect(signedIn().complete).toBe(false);
  });

  it("keeps every field ahead of markers and drops markers past the limit", () => {
    const links = Array.from(
      { length: 60 },
      (_, index) => `<a id="link${index}" href="/p${index}">Page ${index}</a>`,
    ).join("");
    page(`${links}<form><input id="q" type="text" aria-label="Search"></form>`);
    const observation = signedIn();
    expect(observation.complete).toBe(true);
    expect(observation.candidates).toHaveLength(48);
    // The field comes last in the page, yet it is kept; the last links are dropped.
    expect(observation.candidates.at(-1)).toMatchObject({ role: "text", target: { value: "q" } });
    expect(observation.candidates.at(-2)).toMatchObject({ target: { value: "link46" } });
  });

  // Shaped like a points site's top page after sign-in (ポイントインカム, 2026-10-12):
  // carousels, ads and news tabs, with the account links in the header carrying no id.
  const pointsSite = (header: string) => {
    const slides = Array.from(
      { length: 16 },
      (_, index) => `<a id="splide04-slide${index + 1}" href="/ad/${index}">${index + 1} of 16</a>`,
    ).join("");
    const ads = Array.from(
      { length: 40 },
      (_, index) => `<a href="/ad/detail.php?id=${index}">広告${"ア".repeat(index + 1)}で還元</a>`,
    ).join("");
    const tabs = ["総合", "芸能", "社会", "スポーツ", "経済", "国際", "IT", "ライフ"]
      .map((tab) => `<button type="button">${tab}</button>`)
      .join("");
    return `<a id="recommen_fab" href="/ad/fab">本日のイチオシ広告</a>
      <div><button id="splide02-slide01" type="button">Go to slide 1</button>${slides}</div>
      <h2>新着広告</h2>${ads}${tabs}${header}
      <div id="cbox"><button id="cboxClose" type="button">close</button></div>`;
  };
  const icon = (alt: string) => `<img src="data:," alt="${alt}" width="24" height="24">`;

  it("keeps the account links of a busy page ahead of its carousels, ads and tabs", () => {
    page(
      pointsSite(
        `<header><form><input id="search" type="text" placeholder="広告名で探す"></form>
          <a href="/my/point.php">2,358pt</a><a href="/notice/">お知らせ 7</a>
          <a href="/my/">マイページ</a><a href="/my/bankbook.php">${icon("通帳")}</a>
          <a href="/logout.php">${icon("")}</a></header>`,
      ),
      "ポイ活するなら【ポイントサイト】",
    );
    const observation = signedIn();
    expect(observation.candidates).toHaveLength(48);
    const kept = summary(observation);
    // The header comes last in the page, after more than 48 controls, yet its field and
    // its links, located by their text or image, are kept in document order; the ads past
    // the limit, the news tabs and the pop-up's close button are left out. The sign-out
    // icon has neither text nor `alt`, so nothing can locate it, and text with a digit,
    // such as the balance and the unread count, never names a marker.
    expect(kept.slice(-3)).toEqual([
      {
        role: "text",
        target: { by: "id", value: "search" },
        placeholder: "広告名で探す",
        group: "f1",
      },
      { role: "link", target: { by: "text", value: "マイページ" }, label: "マイページ" },
      { role: "link", target: { by: "text", value: "通帳" }, label: "通帳" },
    ]);
    expect(kept[0]).toMatchObject({ target: { by: "id", value: "recommen_fab" } });
    // The executor finds each kept link by the same locator.
    for (const entry of kept)
      expect(findTargets(document, entry.target, { links: true }), entry.target.value).toHaveLength(
        1,
      );
  });

  it("keeps navigation links after a busy page and drops other links past the limit", () => {
    page(
      pointsSite(`<nav><a href="/member/settings">設定</a></nav>
        <a href="/auth/logout">ログアウト</a>`),
    );
    const kept = summary(signedIn());
    expect(kept).toEqual(
      expect.arrayContaining([
        { role: "link", target: { by: "text", value: "設定" }, label: "設定" },
      ]),
    );
    // Its words do not count: a link outside the header or navigation waits its turn.
    expect(kept.some((entry) => entry.label === "ログアウト")).toBe(false);
  });

  it("marks a page incomplete when a field cannot be described, and says why", () => {
    const gap = () => {
      const result = extractSignedInObservation();
      return result.ok ? [result.observation.complete, result.gap] : result.reason;
    };
    page(`<button id="logout">Sign out</button><input type="password">`);
    expect(gap()).toEqual([false, "unlocated-field"]);
    page(`<button id="logout">Sign out</button><input id="pin" type="password" readonly>`);
    expect(gap()).toEqual([false, "unfillable-field"]);
    page(`<button id="logout">Sign out</button><input id="date" type="text" disabled>`);
    expect(gap()).toEqual([false, "unfillable-field"]);
    page(
      `<button id="logout">Sign out</button>${Array.from({ length: 49 }, (_, index) => `<input id="f${index}">`).join("")}`,
    );
    expect(gap()).toEqual([false, "too-many-fields"]);
    page(`<button id="logout">Sign out</button><div id="host"></div>`);
    document.getElementById("host")!.attachShadow({ mode: "open" }).innerHTML = "<input>";
    expect(gap()).toEqual([false, "shadow-field"]);
    page(`<button id="logout">Sign out</button><input id="q">`);
    expect(gap()).toEqual([true, undefined]);
  });

  it("reports a still-visible sign-in field so the service can refuse the page", () => {
    page(`<form><input id="pw" type="password"><button id="go">Sign in</button></form>`);
    expect(summary(signedIn())).toEqual([
      { role: "password", target: { by: "id", value: "pw" }, group: "f1" },
      { role: "button", target: { by: "id", value: "go" }, label: "Sign in", group: "f1" },
    ]);
  });

  it("refuses a page with nothing to describe", () => {
    page(`<p>Loading</p>`);
    expect(extractSignedInObservation()).toEqual({ ok: false, reason: "no-candidates" });
  });
});
