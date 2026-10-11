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

  it("keeps only located links inside a form with fields, without affecting completeness", () => {
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
      ["reset", "f1"],
      ["go", "f1"],
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

  it("refuses ASP.NET cookieless session paths", () => {
    page(`<input id="u">`);
    history.replaceState(null, "", "/(S(lit3py55t21z5))/default.aspx");
    expect(extractLoginObservation()).toEqual({ ok: false, reason: "unsupported-page" });
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
      <button name="alice@example.com" type="button">Profile</button>
      <button id="logout" name="user-123456" type="button">Sign out</button>`,
    );
    // The link has no other locator, so it is left out; the buttons fall back to their
    // text and id.
    expect(summary(signedIn())).toEqual([
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

  it("marks a page incomplete when a field cannot be described", () => {
    page(`<button id="logout">Sign out</button><input type="password">`);
    expect(signedIn().complete).toBe(false);
    page(`<button id="logout">Sign out</button><input id="pin" type="password" readonly>`);
    expect(signedIn().complete).toBe(false);
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
