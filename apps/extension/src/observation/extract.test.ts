import type { LoginObservation } from "@pateat/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { extractLoginObservation } from "./extract";

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
    expect(label.startsWith("a b c 長")).toBe(true);
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
    page(`<form><input id="user"><input id="pw" type="password"><button>ログイン</button></form>`);
    const observation = observe();
    expect(observation.complete).toBe(false);
    expect(observation.candidates.map((candidate) => candidate.target.value)).toEqual([
      "user",
      "pw",
    ]);
  });

  it("marks image buttons incomplete until the executor can click them", () => {
    page(
      `<form><input id="user"><input id="go" type="image" src="data:," alt="ログイン" width="40" height="20"></form>`,
    );
    expect(observe().complete).toBe(false);
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
      ["s", "f1"],
      ["user", "f2"],
      ["reset", "f2"],
      ["go", "f2"],
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
      `<form id="f"><input id="a"><input name="b"><input data-testid="c"><button id="d">Go</button></form>`,
    );
    for (const candidate of observe().candidates) {
      const attribute = candidate.target.by === "test-id" ? "data-testid" : candidate.target.by;
      const found = [...document.querySelectorAll(`[${attribute}]`)].filter(
        (element) => element.getAttribute(attribute) === candidate.target.value,
      );
      expect(found).toHaveLength(1);
    }
  });
});
