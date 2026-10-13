import type { LoginObservation } from "@pateat/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findTargets } from "../page/targets";
import {
  extractAccountListObservation,
  extractEntryObservation,
  extractLoginObservation,
  extractSignedInObservation,
} from "./extract";

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
    // The disabled and read-only fields and the radio and file inputs are visible controls
    // the executor cannot fill.
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

  it("keeps personal-data autocomplete tokens, which mark a sign-up form", () => {
    page(
      `<form id="f">
        <input id="last" autocomplete="family-name">
        <input id="phone" type="tel" autocomplete="section-a shipping tel">
        <input id="birth" autocomplete="BDAY">
        <input id="u" autocomplete="username">
        <input id="p" type="password" autocomplete="new-password">
        <input id="other" autocomplete="cc-number">
        <button id="go">Join</button></form>`,
    );
    expect(observe().candidates.map((candidate) => candidate.autocomplete)).toEqual([
      "family-name",
      "tel",
      "bday",
      "username",
      "new-password",
      undefined,
      undefined,
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

  it("takes field descriptions from aria-describedby, never errors or text the label repeats", () => {
    page(
      `<label for="branch">店番</label>
      <input id="branch" aria-describedby="branch-hint gone">
      <p id="branch-hint">半角数字3桁</p>
      <input id="same" aria-labelledby="pin-label" aria-describedby="pin-label">
      <span id="pin-label">暗証番号</span>
      <input id="hidden-hint" aria-label="Code" aria-describedby="secret">
      <p id="secret" hidden>Ignored</p>
      <input id="mail" aria-label="Mail" aria-describedby="mail-hint">
      <p id="mail-hint">Use taro@example.com or 0312345678</p>
      <input id="invalid" aria-label="User" aria-describedby="user-hint" aria-invalid="true">
      <p id="user-hint">User taro_y is not registered</p>
      <input id="errors" aria-label="ID" aria-describedby="id-hint id-error id-alert"
        aria-errormessage="id-error">
      <p id="id-hint">6-12 letters</p><p id="id-error">taro_y is taken</p>
      <div role="alert"><p id="id-alert">taro_y is locked</p></div>
      <input id="nested" aria-label="PIN" aria-describedby="pin-desc">
      <div id="pin-desc"><p>4 digits</p><p aria-live="polite">taro_y is locked</p></div>
      <button id="go" aria-describedby="branch-hint">ログイン</button>`,
    );
    expect(summary(observe())).toEqual([
      {
        role: "text",
        target: { by: "id", value: "branch" },
        label: "店番",
        description: "半角数字3桁",
      },
      { role: "text", target: { by: "id", value: "same" }, label: "暗証番号" },
      { role: "text", target: { by: "id", value: "hidden-hint" }, label: "Code" },
      {
        role: "text",
        target: { by: "id", value: "mail" },
        label: "Mail",
        description: "Use [email] or [number]",
      },
      { role: "text", target: { by: "id", value: "invalid" }, label: "User" },
      {
        role: "text",
        target: { by: "id", value: "errors" },
        label: "ID",
        description: "6-12 letters",
      },
      {
        role: "text",
        target: { by: "id", value: "nested" },
        label: "PIN",
        description: "4 digits",
      },
      { role: "button", target: { by: "id", value: "go" }, label: "ログイン" },
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

  it("locates a password field by its webauthn token when a hidden copy shares the first token", () => {
    // LinkedIn's remembered-account page (2026-10-12): both fields carry only useId IDs.
    page(
      `<form><label for="_r_0_">Password</label>
        <input id="_r_0_" type="password" autocomplete="current-password" hidden>
        <label for="_r_1_">Password</label>
        <input id="_r_1_" type="password" autocomplete="current-password webauthn">
        <button type="button">Show password</button><button type="button">Sign in</button></form>`,
    );
    const observation = observe();
    expect(observation.complete).toBe(true);
    expect(summary(observation).map((candidate) => candidate.target)).toEqual([
      { by: "autocomplete", value: "webauthn" },
      { by: "text", value: "Show password" },
      { by: "text", value: "Sign in" },
    ]);
    expect(findTargets(document, { by: "autocomplete", value: "webauthn" })).toEqual([
      document.getElementById("_r_1_"),
    ]);
    // The hint the model and the slots read still says it is the password field.
    expect(observation.candidates[0]).toMatchObject({ autocomplete: "current-password" });
  });

  it("never locates by an ID React's useId generated, which another page reuses", () => {
    page(
      `<form id="f"><input id="_r_3_" name="session_key"><input id=":r4:" name="password" type="password">
        <input id="«r5»" data-testid="pin"><input id="radix-:R1aH1:" name="code">
        <input id="_R_2H1_" name="otp">
        <input id="user_r_name"><button id="_r_6_">Sign in</button></form>`,
    );
    expect(summary(observe()).map((candidate) => candidate.target)).toEqual([
      { by: "name", value: "session_key" },
      { by: "name", value: "password" },
      { by: "test-id", value: "pin" },
      { by: "name", value: "code" },
      { by: "name", value: "otp" },
      { by: "id", value: "user_r_name" },
      { by: "text", value: "Sign in" },
    ]);
  });

  it("locates an input without id or name by its autocomplete token, as on pixiv's login page", () => {
    page(
      `<form><input type="text" autocomplete="username webauthn" placeholder="メールアドレスまたはpixiv ID">
        <input type="password" autocomplete="current-password webauthn" placeholder="パスワード">
        <button type="submit" disabled>ログイン</button></form>`,
    );
    const observation = observe();
    expect(observation.complete).toBe(true);
    expect(observation.candidates.map(({ target }) => target)).toEqual([
      { by: "autocomplete", value: "username" },
      { by: "autocomplete", value: "current-password" },
      { by: "text", value: "ログイン" },
    ]);
    for (const { target } of observation.candidates)
      expect(findTargets(document, target)).toHaveLength(1);
    // Case and repeats do not matter; a field whose id is shared falls back to its token.
    page(
      `<form><input id="dup" autocomplete="Username username"><input id="dup" type="password">
        <button id="go">Go</button></form>`,
    );
    expect(observe().candidates.map(({ target }) => target)).toEqual([
      { by: "autocomplete", value: "username" },
      { by: "id", value: "go" },
    ]);
    // A button carrying the token makes it ambiguous and is never named by it.
    page(
      `<form><input autocomplete="username"><input type="submit" value="Go" autocomplete="username"></form>`,
    );
    expect(observe().candidates.map(({ target }) => target)).toEqual([{ by: "text", value: "Go" }]);
    // A token two inputs carry, even a hidden one, names neither; nor does new-password.
    page(
      `<form><input autocomplete="username"><input type="password" autocomplete="new-password">
        <button>ログイン</button></form><input autocomplete="username" hidden>`,
    );
    expect(observe().complete).toBe(false);
    expect(observe().candidates.map(({ target }) => target)).toEqual([
      { by: "text", value: "ログイン" },
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
    // A hidden copy of the form shares the ids and names, and the header shows the
    // button's text too.
    const form = `<form><input id="vp-userid" name="userid">
      <input id="vp-password" name="password" type="password"><button>Log in</button></form>`;
    page(`<header><button>Log in</button></header>${form}<div hidden>${form}</div>`);
    expect(extractLoginObservation()).toEqual({ ok: false, reason: "no-locator" });
    // A form with only a field that cannot be filled has nothing to locate.
    page(`<form><input id="pin" type="password" readonly></form>`);
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
      `<header><button>☰</button><button>☰</button></header>
      <form id="f"><input id="u"><button id="go">Log in</button></form>`,
    );
    expect(observe().complete).toBe(true);
    expect(observe().candidates.map((candidate) => candidate.target.value)).toEqual(["u", "go"]);
    page(
      `<form id="f"><input id="u"><input type="checkbox"><button id="go">Log in</button></form>`,
    );
    expect(observe().complete).toBe(false);
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

  it("leaves out a field the continued recipe already fills when it is read-only or disabled", () => {
    // An email address shown again, read-only, beside the password (ADR 0018).
    const email = { by: "id" as const, value: "email" };
    for (const state of ["readonly", "disabled"]) {
      page(
        `<form id="f"><input id="email" type="email" ${state} autocomplete="username"><input id="p" type="password"><button id="go">Log in</button></form>`,
      );
      expect(observe().complete, state).toBe(false);
      const result = extractLoginObservation(document, [email]);
      if (!result.ok) throw new Error(result.reason);
      expect(result.observation.complete, state).toBe(true);
      expect(result.observation.candidates.map((candidate) => candidate.target.value)).toEqual([
        "p",
        "go",
      ]);
    }
    // Another read-only field, a known field under another locator, or a known locator that
    // names two elements still makes the page incomplete.
    for (const html of [
      `<input id="email" readonly><input id="branch" readonly><input id="p" type="password">`,
      `<input name="email" readonly><input id="p" type="password">`,
      `<input id="email" readonly><input id="email" readonly><input id="p" type="password">`,
    ]) {
      page(`<form id="f">${html}<button id="go">Log in</button></form>`);
      const result = extractLoginObservation(document, [email]);
      expect(result.ok && result.observation.complete, html).toBe(false);
    }
    // A known field the page still lets the person edit is described as any field is.
    page(
      `<form id="f"><input id="email" type="email"><input id="p" type="password"><button id="go">Log in</button></form>`,
    );
    const editable = extractLoginObservation(document, [email]);
    if (!editable.ok) throw new Error(editable.reason);
    expect(editable.observation.candidates.map((candidate) => candidate.target.value)).toEqual([
      "email",
      "p",
      "go",
    ]);
  });

  it("matches a known field by its name or test ID locator too, exactly (ADR 0018)", () => {
    const form = (field: string) =>
      page(
        `<form id="f">${field}<input id="p" type="password"><button id="go">Log in</button></form>`,
      );
    const complete = (known: { by: "id" | "name" | "test-id"; value: string }[]) => {
      const result = extractLoginObservation(document, known);
      return result.ok && result.observation.complete;
    };
    form(`<input name="login" readonly>`);
    expect(complete([{ by: "name", value: "login" }])).toBe(true);
    expect(complete([{ by: "id", value: "login" }])).toBe(false);
    form(`<input data-testid="login" disabled>`);
    expect(complete([{ by: "test-id", value: "login" }])).toBe(true);
    expect(complete([{ by: "name", value: "login" }])).toBe(false);
    // Values compare exactly.
    form(`<input id="Email" readonly>`);
    expect(complete([{ by: "id", value: "email" }])).toBe(false);
  });

  it("leaves out every known read-only field, but keeps the page's other forms whole", () => {
    page(
      `<form id="f"><input id="email" readonly><input id="member" disabled><input id="p" type="password"><button id="go">Log in</button></form>`,
    );
    const result = extractLoginObservation(document, [
      { by: "id", value: "email" },
      { by: "id", value: "member" },
    ]);
    if (!result.ok) throw new Error(result.reason);
    expect(result.observation.complete).toBe(true);
    expect(result.observation.candidates.map((candidate) => candidate.target.value)).toEqual([
      "p",
      "go",
    ]);
    // With the known field the only field, the page has nothing to describe.
    page(`<form id="f"><input id="email" readonly><button id="go">Next</button></form>`);
    expect(extractLoginObservation(document, [{ by: "id", value: "email" }])).toEqual({
      ok: false,
      reason: "no-candidates",
    });
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

  it("marks a field in any shadow root incomplete", () => {
    page(
      `<form id="s"><input name="q" aria-label="検索"><button id="sb">検索</button></form>
      <form id="login"><div id="host"></div></form>`,
    );
    document
      .querySelector("#host")!
      .attachShadow({ mode: "open" }).innerHTML = `<input id="u"><input id="p" type="password">`;
    expect(observe().complete).toBe(false);
    // A shadow host outside every form counts too.
    page(`<input id="user"><div id="host"></div>`);
    document
      .querySelector("#host")!
      .attachShadow({ mode: "open" }).innerHTML = `<input id="pw" type="password">`;
    expect(observe().complete).toBe(false);
    page(`<form id="f"><input id="u"><button id="go">Go</button></form><div id="host"></div>`);
    document.querySelector("#host")!.attachShadow({
      mode: "open",
    }).innerHTML = `<label>Analytics <input type="checkbox"></label>`;
    expect(observe().complete).toBe(true);
  });

  it("refuses paths that may carry a session ID or token, and hides them on a signed-in page", () => {
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
      // A signed-in page is described with each such segment replaced (ADR 0029).
      const signedIn = extractSignedInObservation();
      if (!signedIn.ok) throw new Error(refused);
      expect(signedIn.observation.path, refused).toContain("/[id]");
      expect(signedIn.observation.path.split("/").length, refused).toBe(refused.split("/").length);
    }
    history.replaceState(null, "", "/0123456789abcdef0123456789abcdef/home");
    expect(extractSignedInObservation()).toMatchObject({
      ok: true,
      observation: { path: "/[id]/home" },
    });
    history.replaceState(null, "", "/s/0123456789abcdef0123456789abcdef/login");
    expect(extractSignedInObservation()).toMatchObject({
      ok: true,
      observation: { path: "/s/[id]/login" },
    });
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
      expect(extractSignedInObservation(), allowed).toMatchObject({
        ok: true,
        observation: { path: allowed },
      });
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
    page(`<label for="u">User<br>ID</label><input id="u">`);
    expect(observe().candidates[0]!.label).toBe("User ID");
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

  it("hides every number in a signed-in page's text, whatever its length", () => {
    page(
      `<header><a id="points" href="/points">保有ポイント 1,234,567pt</a>
        <a id="miles" href="/miles">850 ポイント ①</a>
        <button id="inbox" type="button" aria-label="Inbox ٣ new">✉</button></header>
      <h1>Balance 12.50</h1><h2>Balance 7.25</h2><h3>Balance 1234.56</h3>
      <form><input id="note" type="text" aria-label="Step 2" placeholder="e.g. 7"
          aria-describedby="note-hint">
        <span id="note-hint">Step 3</span>
        <input id="memo" type="text" aria-label="Memo" aria-describedby="memo-hint">
        <span id="memo-hint">Up to 20 characters</span></form>`,
      "Account 3",
    );
    const observation = signedIn();
    // Headings that differ only in their numbers become one.
    expect(observation).toMatchObject({
      title: "Account [number]",
      headings: ["Balance [number]"],
    });
    expect(
      observation.candidates.map(({ label, placeholder, description }) => [
        label,
        placeholder,
        description,
      ]),
    ).toEqual([
      ["保有ポイント [number]pt", undefined, undefined],
      ["[number] ポイント [number]", undefined, undefined],
      ["Inbox [number] new", undefined, undefined],
      // A description that repeats the label once hidden is left out.
      ["Step [number]", "e.g. [number]", undefined],
      ["Memo", undefined, "Up to [number] characters"],
    ]);
  });

  it("sends the visible header and navigation text, hidden as the rest of the page (ADR 0029)", () => {
    page(
      `<header><span>Welcome back, taro@example.com</span> <span hidden>Secret</span>
        <nav><a href="/points">Points 1,234</a> <a href="/account">My account</a></nav></header>
      <div role="navigation"><a href="/help">Help</a></div>
      <main><p>Body text 99</p><button id="logout" type="button">Sign out</button></main>`,
    );
    expect(signedIn().headerText).toBe("Welcome back, [email] Points [number] My account Help");
    // Every element boundary separates words.
    page(
      `<header><a href="/account">Account</a><span>taro.yamada</span></header>
      <button id="logout" type="button">Sign out</button>`,
    );
    expect(signedIn().headerText).toBe("Account taro.yamada");
    // Cut at 1,000 characters.
    page(
      `<nav>${"<a href='/x'>Menu</a> ".repeat(300)}</nav>
      <button id="logout" type="button">Sign out</button>`,
    );
    const { headerText } = signedIn();
    expect(headerText!.length).toBeLessThanOrEqual(1000);
    expect(headerText!.startsWith("Menu Menu")).toBe(true);
    // A page without a header or navigation sends none, and a login page never does.
    page(`<main><button id="logout" type="button">Sign out</button></main>`);
    expect(signedIn()).not.toHaveProperty("headerText");
    page(
      `<header><a href="/help">Help</a></header>
      <form><input id="user" name="user" autocomplete="username" aria-label="Email">
        <input id="pass" type="password" aria-label="Password"><button>Log in</button></form>`,
    );
    expect(observe()).not.toHaveProperty("headerText");
  });

  describe("behind an open modal dialog (2026-10-13)", () => {
    // A modal library marks everything beside the dialog `aria-hidden` or `inert`.
    const header = (hider: string) =>
      `<div id="app" ${hider}>
        <header><span>Taro Yamada</span><a id="logout" href="/logout">Log out</a></header>
        <main><h1>Recommended</h1><p>For you</p></main></div>`;
    const promo = (attributes: string) =>
      `<div ${attributes}><h2>Premium scout</h2>
        <button id="later" type="button">Later</button>
        <button id="check" type="button">See the message</button></div>`;
    const modal = promo('role="dialog" aria-modal="true"');
    const controls = (observation: LoginObservation) =>
      summary(observation).map(({ role, target }) => [role, target]);

    it("reads the page an `aria-hidden` ancestor hides behind the modal", () => {
      page(header('aria-hidden="true"') + modal, "Recommended | Example");
      const observation = signedIn();
      expect(observation.headerText).toBe("Taro Yamada Log out");
      expect(observation.headings).toEqual(["Recommended", "Premium scout"]);
      expect(controls(observation)).toEqual([
        ["link", { by: "id", value: "logout" }],
        ["button", { by: "id", value: "later" }],
        ["button", { by: "id", value: "check" }],
      ]);
    });

    it("reads the page an `inert` ancestor hides behind the modal, and a native modal", () => {
      page(header("inert") + modal);
      expect(signedIn().headerText).toBe("Taro Yamada Log out");
      expect(controls(signedIn())).toContainEqual(["link", { by: "id", value: "logout" }]);
      // `showModal()` makes the page inert without an attribute; the site's own one counts.
      page(header("inert") + `<dialog id="promo">${promo("")}</dialog>`);
      document.querySelector<HTMLDialogElement>("#promo")!.showModal();
      expect(signedIn().headerText).toBe("Taro Yamada Log out");
      expect(controls(signedIn())).toEqual([
        ["link", { by: "id", value: "logout" }],
        ["button", { by: "id", value: "later" }],
        ["button", { by: "id", value: "check" }],
      ]);
    });

    it("leaves a hidden page out without an open modal, and what hides inside the page", () => {
      for (const hider of ['aria-hidden="true"', "inert"]) {
        // No modal, a modal that is not shown, and a dialog that is not modal.
        for (const rest of [
          "",
          promo('role="dialog" aria-modal="true" hidden'),
          promo('role="dialog"'),
        ]) {
          page(header(hider) + rest + `<button id="other" type="button">Other</button>`);
          const observation = signedIn();
          expect(observation).not.toHaveProperty("headerText");
          expect(controls(observation)).not.toContainEqual(["link", { by: "id", value: "logout" }]);
        }
      }
      // Behind a modal, a menu hidden inside the page stays hidden.
      page(
        `<div id="app" aria-hidden="true"><header><span>Taro Yamada</span>
          <nav aria-hidden="true"><a id="drawer" href="/drawer">Drawer</a></nav></header></div>
        ${modal}`,
      );
      const observation = signedIn();
      expect(observation.headerText).toBe("Taro Yamada");
      expect(controls(observation)).not.toContainEqual(["link", { by: "id", value: "drawer" }]);
    });

    it("keeps the modal's controls on a page with more controls than the limit", () => {
      const many = Array.from(
        { length: 60 },
        (_, at) => `<a id="item-${at}" href="/item/${at}">Item</a>`,
      ).join("");
      page(`<div id="app" aria-hidden="true"><main>${many}</main></div>${modal}`);
      const kept = controls(signedIn());
      expect(kept).toHaveLength(48);
      expect(kept.slice(-2)).toEqual([
        ["button", { by: "id", value: "later" }],
        ["button", { by: "id", value: "check" }],
      ]);
    });
  });

  it("sends up to three texts near the code field, hidden as the rest of the page (ADR 0027)", () => {
    // The sentence that names the code's source sits outside the code form.
    page(
      `<header><a id="logout" href="/logout">Log out</a></header>
      <main><div><h1>Two-factor authentication</h1>
        <div><span>Enter the 6-digit code from your authenticator app.</span></div>
        <form><div><input id="otp" autocomplete="one-time-code" inputmode="numeric"
            maxlength="6" aria-label="Code"></div>
          <button id="verify" type="submit">Verify</button></form>
        <a href="/help">Lost access to your app?</a></div></main>`,
    );
    expect(signedIn().nearCode).toEqual([
      "Enter the [number]-digit code from your authenticator app.",
    ]);
    // Live regions, error messages, labels, links, buttons and headings are left out, and
    // so is text more than three parents above the field.
    page(
      `<div><p>Far away</p><div><div><div>
        <p role="alert">Wrong code 123456</p><p aria-live="polite">Sent again</p>
        <p id="otp-error">Code 654321 is wrong</p>
        <label for="otp">Code</label><h2>Verify</h2><a href="/sms">Use SMS instead</a>
        <span>Open your authenticator app</span>
        <div><input id="otp" autocomplete="one-time-code" aria-errormessage="otp-error">
          <small>Codes change every 30 seconds</small></div>
        <span role="button" tabindex="0">Resend</span>
        <button id="verify" type="submit">Verify</button>
        <p>Trouble? Contact support</p><p>Fourth text</p>
      </div></div></div></div>`,
    );
    // The nearest come first, then page order; they are sent in page order.
    expect(signedIn().nearCode).toEqual([
      "Open your authenticator app",
      "Codes change every [number] seconds",
      "Trouble? Contact support",
    ]);
    // Only kept texts count: one repeating the label, a timer and one typed character in a
    // box of its own leave room for the sentence a parent further up holds, and editable
    // text is never read. Text in the third parent counts and in the fourth does not.
    page(
      `<div><p>Fourth parent</p><div><p>Enter the code from your authenticator app, taro@example.com</p>
        <div><span>Verification code</span><div>
          <input id="otp" autocomplete="one-time-code" aria-label="Verification code">
          <div>A</div><div>B</div><div role="textbox" contenteditable>my words</div></div>
          <span>0:30</span><span>Didn't receive it?</span><span>Didn't receive it?</span>
        </div><button id="verify" type="submit">Verify</button></div></div>`,
    );
    expect(signedIn().nearCode).toEqual([
      "Enter the code from your authenticator app, [email]",
      "Didn't receive it?",
    ]);
    // A field marked invalid gets none, as its description does.
    page(
      `<div><span>Open your authenticator app</span>
        <input id="otp" autocomplete="one-time-code" aria-invalid="true"></div>
      <button id="verify" type="submit">Verify</button>`,
    );
    expect(signedIn()).not.toHaveProperty("nearCode");
    // A page without a code field sends none, and a login page never does.
    page(
      `<div><span>Search the help center</span><input id="q" type="text" aria-label="Search">
        <button id="logout" type="button">Sign out</button></div>`,
    );
    expect(signedIn()).not.toHaveProperty("nearCode");
    page(
      `<form><div><span>Open your authenticator app</span>
        <input id="otp" autocomplete="one-time-code" aria-label="Code"></div>
        <button id="verify">Verify</button></form>`,
    );
    expect(observe()).not.toHaveProperty("nearCode");
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

    // Nor one that may be a token, such as an account ID.
    page(`<button id="acct-a1b2c3d4e5f6a7b8c9d0" type="button">Account</button>`);
    expect(summary(signedIn())).toEqual([
      { role: "button", target: { by: "text", value: "Account" }, label: "Account" },
    ]);

    page(`<form><input id="mail-0123456789" type="email" aria-label="Email"></form>
      <button id="logout" type="button">Sign out</button>`);
    // A field that may be a sign-in field and cannot be located safely makes the
    // description incomplete; another such field is left out.
    expect(signedIn().complete).toBe(false);
    page(`<form><input id="note-0123456789" type="text" aria-label="Note"></form>
      <button id="logout" type="button">Sign out</button>`);
    expect(signedIn().complete).toBe(true);
    expect(summary(signedIn()).map((entry) => entry.target.value)).toEqual(["logout"]);
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
    // A field nothing can locate counts only when it may be a sign-in field.
    for (const field of [
      `<input type="password">`,
      `<input type="email">`,
      `<input autocomplete="username"><input autocomplete="username">`,
      `<input inputmode="numeric" maxlength="6">`,
      `<input class="q"><input class="q" type="password">`,
      // One password field of its form, beside one of another form.
      `<form><input type="password"></form><form><input type="password"></form>`,
    ]) {
      page(`<button id="logout">Sign out</button>${field}`);
      expect(gap(), field).toEqual([false, "unlocated-field"]);
    }
    // Others, such as a search box with no ID, are left out (Grafana Cloud and Wise,
    // 2026-10-12: `unlocated-field`; which field it was is inferred).
    for (const field of [
      `<input placeholder="Search">`,
      `<input type="text" autocomplete="off">`,
      `<input type="tel"><input type="tel">`,
      // A password change form, as S2 reads it (JP BANKカードWEB's optional password
      // change page, 2026-10-12: `unlocated-field`; which field it was is inferred).
      `<input type="password"><input type="password"><input type="password">`,
      `<input type="password" autocomplete="new-password">`,
    ]) {
      page(`<button id="logout">Sign out</button><form>${field}</form>`);
      expect(gap(), field).toEqual([true, undefined]);
      expect(summary(signedIn()).map((entry) => entry.target.value)).toEqual(["logout"]);
    }
    // Outside any form, the fields count as one form.
    page(`<button id="logout">Sign out</button><input type="password"><input type="password">`);
    expect(gap()).toEqual([true, undefined]);
    page(`<button id="logout">Sign out</button><input id="pin" type="password" readonly>`);
    expect(gap()).toEqual([false, "unfillable-field"]);
    // A disabled field that may not be a sign-in field is left out, and the result says so:
    // it may still be a code field waiting for a timer or a sent code, so only `signed-in`
    // completes such a page (owner, 2026-10-12, ADR 0029; Q-move's history page after a
    // sign-in, 2026-10-12: `disabled-field`, never judged; which field it was is inferred).
    for (const field of [
      `<input id="otp" name="otp" disabled>`,
      `<input id="date" type="text" disabled>`,
      `<input id="f" type="tel" maxlength="11" disabled>`,
    ]) {
      page(`<button id="logout">Sign out</button><form>${field}</form>`);
      const result = extractSignedInObservation();
      expect(result, field).toMatchObject({
        ok: true,
        observation: { complete: true },
        disabledLeftOut: true,
      });
      expect(result).not.toHaveProperty("gap");
      expect(summary(signedIn()).map((entry) => entry.target.value)).toEqual(["logout"]);
    }
    // A disabled field that may be a sign-in field still makes the page incomplete.
    for (const field of [
      `<input id="f" autocomplete="one-time-code" disabled>`,
      `<input id="f" autocomplete="current-password" disabled>`,
      `<input id="f" autocomplete="username" disabled>`,
      `<input id="f" type="password" disabled>`,
      `<input id="f" type="email" disabled>`,
      `<input id="f" inputmode="numeric" maxlength="6" disabled>`,
    ]) {
      page(`<button id="logout">Sign out</button><input id="date" disabled>${field}`);
      expect(gap(), field).toEqual([false, "unfillable-field"]);
    }
    // Other fields that cannot be filled are left out without the mark.
    page(`<button id="logout">Sign out</button><input id="date" type="text" readonly>`);
    expect(extractSignedInObservation()).not.toHaveProperty("disabledLeftOut");
    // A read-only field that may be a sign-in field.
    for (const field of [
      `<input id="f" autocomplete="section-a username" readonly>`,
      `<input id="f" autocomplete="email" readonly>`,
      `<input id="f" type="email" readonly>`,
      `<input id="f" autocomplete="current-password" readonly>`,
      `<input id="f" autocomplete="new-password" readonly>`,
      `<input id="f" autocomplete="one-time-code" readonly>`,
      `<input id="f" inputmode="numeric" maxlength="6" readonly>`,
      `<input id="f" type="tel" maxlength="10" readonly>`,
      `<input id="f" type="number" maxlength="1" readonly>`,
      `<input id="f" type="text" autocomplete="username" style="opacity: 0">`,
    ]) {
      page(`<button id="logout">Sign out</button>${field}`);
      expect(gap(), field).toEqual([false, "unfillable-field"]);
    }
    // Any other field that cannot be filled is left out: read-only, transparent or tiny.
    // The read-only date picker of a hotel search is the inferred case (アパホテル,
    // 2026-10-12; the log showed only `unfillable-field`).
    for (const field of [
      `<input id="date" type="text" readonly>`,
      `<input id="f" type="tel" maxlength="11" readonly>`,
      `<input id="f" inputmode="numeric" readonly>`,
      `<input id="f" type="text" style="opacity: 0">`,
      `<input id="f" type="text" autocomplete="on" style="opacity: 0">`,
      `<input id="f" type="text" autocomplete="off" style="width: 1px; height: 1px; padding: 0; border: 0">`,
    ]) {
      page(`<button id="logout">Sign out</button><form>${field}</form>`);
      expect(gap(), field).toEqual([true, undefined]);
      expect(summary(signedIn()).map((entry) => entry.target.value)).toEqual(["logout"]);
    }
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
    expect(JSON.stringify(result.observation)).not.toMatch(/[@＠]|ｅｘａｍｐｌｅ|example/u);
  });

  it("takes a contact address in the page's text beside a button, for the AI to judge", () => {
    page(`<main><button>Sign in</button><p>Contact help@example.com</p></main>`);
    const result = extractAccountListObservation();
    if (!result.ok) throw new Error(result.reason);
    expect(result.observation.accounts).toEqual(["Contact [email]"]);
  });

  it("lists an entry inside a beside text once", () => {
    page(`<p>Signed in: <span tabindex="0">a@example.com</span></p><button>Continue</button>`);
    const result = extractAccountListObservation();
    if (!result.ok) throw new Error(result.reason);
    expect(result.observation.accounts).toEqual(["[email]"]);
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
    expect(summary(result.observation).map((candidate) => candidate.label)).toEqual([
      "Log back in",
      "Use another account",
    ]);
    expect(JSON.stringify(result.observation)).not.toContain("example.com");
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

  it("refuses a path that may carry a token", () => {
    page(`<a href="https://accounts.synthetic.example/login">Login</a>`);
    history.replaceState(null, "", "/s/0123456789abcdef0123456789abcdef/");
    expect(extractEntryObservation(document, onSite)).toEqual({
      ok: false,
      reason: "unsupported-page",
    });
  });
});
