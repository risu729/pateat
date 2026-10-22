import type { LoginObservation } from "@pateat/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listControls, otherAccountMiss } from "../page/account-list";
import { findTargets } from "../page/targets";
import {
  extractAccountListObservation,
  extractEntryObservation,
  extractLoginObservation,
  extractPasskeyObservation,
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

  it("locates a field by a name a hidden copy of its form shares (ADR 0037 amendment of 2026-10-22)", () => {
    // A card site's login (2026-10-21, #832): a closed additional-check dialog copies the
    // form's fields under the same names, and the visible names hold numbers.
    page(
      `<form id="f"><dl><dt>ID</dt><dd><input type="text" name="webId" autocomplete="off"
          placeholder="ID（4～30桁）"></dd></dl>
        <dl><dt>パスワード</dt><dd><input type="password" name="webPassword" autocomplete="off"
          placeholder="パスワード（4～30桁）"></dd></dl>
        <input id="submit1" type="submit" value="ログイン"></form>
      <span style="display:none"><h2>追加確認項目の入力</h2><form>
        <dl style="display:none"><input id="webId2" name="webId"></dl>
        <dl style="display:none"><input id="webPassword2" type="password" name="webPassword"></dl>
        <input name="webPhoneNum" maxlength="4"><input id="submit" type="submit" value="ログイン">
      </form></span>`,
    );
    const observation = observe();
    expect(observation.complete).toBe(true);
    expect(summary(observation).map((candidate) => candidate.target)).toEqual([
      { by: "name", value: "webId" },
      { by: "name", value: "webPassword" },
      { by: "id", value: "submit1" },
    ]);
    const elements = [...document.querySelectorAll("#f input")];
    observation.candidates.forEach((candidate, at) =>
      expect(findTargets(document, candidate.target)).toEqual([elements[at]]),
    );
  });

  it("locates a password field by its first token when a hidden copy shares it", () => {
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
      { by: "autocomplete", value: "current-password" },
      { by: "text", value: "Show password" },
      { by: "text", value: "Sign in" },
    ]);
    expect(findTargets(document, { by: "autocomplete", value: "current-password" })).toEqual([
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

  it("locates by an ID Mantine's useId made only when nothing else is unique", () => {
    // A Mantine-built site (2026-10-13): `mantine-ypxwydcwg` has no digit, so only the
    // library's prefix tells it apart; `mantine-r5` is React 18's `:r5:` without
    // colons.
    page(
      `<form><input id="mantine-ypxwydcwg" name="email">
        <input id="mantine-r5" name="password" type="password">
        <button id="mantine-ypxwydcwg-tab-login">Sign in</button></form>`,
    );
    expect(observe().candidates.map(({ target }) => target)).toEqual([
      { by: "name", value: "email" },
      { by: "name", value: "password" },
      { by: "text", value: "Sign in" },
    ]);
    // With no other locator the ID is still used, so the form stays complete.
    page(
      `<form><input id="mantine-ypxwydcwg"><input id="mantine-r5" type="password">
        <button id="mantine-qwhxkbtfz" aria-label="Sign in"></button></form>`,
    );
    const observation = observe();
    expect(observation.complete).toBe(true);
    expect(observation.candidates.map(({ target }) => target)).toEqual(
      ["mantine-ypxwydcwg", "mantine-r5", "mantine-qwhxkbtfz"].map((value) => ({
        by: "id",
        value,
      })),
    );
  });

  it("locates by an ID holding a random-looking run only when nothing else is unique", () => {
    // A Mantine-built site (2026-10-13): `useId` appends Math.random().toString(36).
    page(
      `<form><input id="mantine-4p5f7ku4o" name="email">
        <input id="mantine-7pri31duh" type="password" autocomplete="current-password">
        <button id="mantine-a1b2c3d4e">Sign in</button></form>`,
    );
    expect(observe().candidates.map(({ target }) => target)).toEqual([
      { by: "name", value: "email" },
      { by: "autocomplete", value: "current-password" },
      { by: "text", value: "Sign in" },
    ]);
    // With no other locator the ID is still used, so the form stays complete.
    page(
      `<form><input id="mantine-4p5f7ku4o"><input id="mantine-7pri31duh" type="password">
        <button id="mantine-a1b2c3d4e" aria-label="Sign in"></button></form>`,
    );
    const observation = observe();
    expect(observation.complete).toBe(true);
    expect(observation.candidates.map(({ target }) => target)).toEqual(
      ["mantine-4p5f7ku4o", "mantine-7pri31duh", "mantine-a1b2c3d4e"].map((value) => ({
        by: "id",
        value,
      })),
    );
    // Only a run of eight or more lower-case letters and digits that no other letter or
    // digit touches looks random: not a shorter one, nor one beside an upper-case letter.
    page(
      `<form><input id="x-a1b2c3d" name="a"><input id="field-4P5f7ku4o" name="b">
        <input id="field4p5f7ku4o" name="c"></form>`,
    );
    expect(observe().candidates.map(({ target }) => target)).toEqual([
      { by: "id", value: "x-a1b2c3d" },
      { by: "id", value: "field-4P5f7ku4o" },
      { by: "name", value: "c" },
    ]);
    // Stable IDs, random-looking (`input2fa`) or not, are used when nothing else is unique.
    const stable = [
      "login-form",
      "username",
      "user_email",
      "input2fa",
      "password-field-1",
      "loginForm1",
      "email-address-2024",
      "j_username",
      "oauth2login",
      "web3wallet",
      "email2fa",
    ];
    page(
      `<form>${stable.map((id) => `<input id="${id}">`).join("")}
        <button id="signin-btn">Sign in</button></form>`,
    );
    expect(observe().candidates.map(({ target }) => target)).toEqual(
      [...stable, "signin-btn"].map((value) => ({ by: "id", value })),
    );
  });

  it("locates a field that only a per-load ID names by its visible name (ADR 0037)", () => {
    // 外資就活ドットコム (Mantine, 2026-10-13): random IDs, no name, autocomplete or label.
    page(
      `<form><input id="mantine-v0zmrhrmb" placeholder="メールアドレス">
        <input id="mantine-k2j4h6g8f" type="password" placeholder="パスワード">
        <input placeholder="メールアドレス" hidden>
        <button id="mantine-q1w2e3r4t" type="submit">ログインする</button></form>`,
    );
    const observation = observe();
    expect(observation.complete).toBe(true);
    expect(summary(observation)).toMatchObject([
      { role: "text", target: { by: "label", value: "メールアドレス" } },
      { role: "password", target: { by: "label", value: "パスワード" } },
      { role: "button", target: { by: "text", value: "ログインする" } },
    ]);
    for (const { target } of observation.candidates)
      expect(findTargets(document, target)).toHaveLength(1);
    // The next load gives the fields other IDs; the recipe's locators still find them.
    document.getElementById("mantine-v0zmrhrmb")!.id = "mantine-p9o8i7u6y";
    document.getElementById("mantine-k2j4h6g8f")!.id = "mantine-z5x4c3v2b";
    for (const { target } of observation.candidates)
      expect(findTargets(document, target)).toHaveLength(1);
  });

  it("uses a visible name only when no other locator names the field and it is unique", () => {
    // `name` and `autocomplete` come first.
    page(
      `<form><input id="mantine-v0zmrhrmb" name="email" placeholder="メールアドレス">
        <input id="mantine-k2j4h6g8f" type="password" autocomplete="current-password"
          placeholder="パスワード">
        <button type="submit">ログインする</button></form>`,
    );
    expect(observe().candidates.map(({ target }) => target)).toEqual([
      { by: "name", value: "email" },
      { by: "autocomplete", value: "current-password" },
      { by: "text", value: "ログインする" },
    ]);
    // Two shown fields with one name: the per-load ID is all that is left.
    page(
      `<form><input id="mantine-v0zmrhrmb" placeholder="番号">
        <input id="mantine-k2j4h6g8f" placeholder="番号">
        <button type="submit">ログインする</button></form>`,
    );
    expect(observe().candidates.map(({ target }) => target)).toEqual([
      { by: "id", value: "mantine-v0zmrhrmb" },
      { by: "id", value: "mantine-k2j4h6g8f" },
      { by: "text", value: "ログインする" },
    ]);
    // A name redaction would change, as an example address, is never used.
    page(
      `<form><input id="mantine-v0zmrhrmb" type="email" placeholder="taro@example.com">
        <input id="mantine-k2j4h6g8f" placeholder="会員番号 12345678">
        <button type="submit">ログインする</button></form>`,
    );
    expect(observe().candidates.map(({ target }) => target)).toEqual([
      { by: "id", value: "mantine-v0zmrhrmb" },
      { by: "id", value: "mantine-k2j4h6g8f" },
      { by: "text", value: "ログインする" },
    ]);
    // Nor one holding a number, as a counter that changes while the person types.
    page(
      `<form><label for="mantine-v0zmrhrmb">ID <span>0/20</span></label>
        <input id="mantine-v0zmrhrmb">
        <button type="submit">ログインする</button></form>`,
    );
    expect(observe().candidates[0]!.target).toEqual({ by: "id", value: "mantine-v0zmrhrmb" });
    // A label element's text comes before the placeholder.
    page(
      `<form><label for="mantine-v0zmrhrmb">ログインID</label>
        <input id="mantine-v0zmrhrmb" placeholder="taro@example.com">
        <button type="submit">ログインする</button></form>`,
    );
    expect(observe().candidates[0]!.target).toEqual({ by: "label", value: "ログインID" });
  });

  it("leaves out a known field shown read-only by its visible name, continuing a recipe", () => {
    page(
      `<form><input id="mantine-v0zmrhrmb" placeholder="メールアドレス" readonly>
        <input id="mantine-k2j4h6g8f" type="password" placeholder="パスワード">
        <button type="submit">ログインする</button></form>`,
    );
    expect(extractLoginObservation(document)).toMatchObject({ ok: true, gap: "unfillable-field" });
    const result = extractLoginObservation(document, [{ by: "label", value: "メールアドレス" }]);
    if (!result.ok) throw new Error(result.reason);
    expect(result.observation.complete).toBe(true);
    expect(result.observation.candidates.map(({ target }) => target)).toEqual([
      { by: "label", value: "パスワード" },
      { by: "text", value: "ログインする" },
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
    // A token two shown inputs carry names neither; nor does new-password.
    page(
      `<form><input autocomplete="username"><input autocomplete="username">
        <input type="password" autocomplete="new-password"><button>ログイン</button></form>`,
    );
    expect(observe().complete).toBe(false);
    expect(observe().candidates.map(({ target }) => target)).toEqual([
      { by: "text", value: "ログイン" },
    ]);
    // A hidden input's copy of the token does not count (ADR 0037 amendment of 2026-10-22).
    page(
      `<form><input autocomplete="username"><button>ログイン</button></form>
      <input autocomplete="username" hidden>`,
    );
    expect(observe().candidates.map(({ target }) => target)).toEqual([
      { by: "autocomplete", value: "username" },
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

  it("names a role=button control in a login form by its text, but not one outside", () => {
    // Instagram's login form on 2026-10-13, reduced: its Log in control is a div with
    // role=button and no id, disabled until the fields are filled, beside an empty 0×0
    // submit input.
    page(
      `<div role="button">Menu</div>
      <form><input name="email" autocomplete="username"><input name="pass" type="password">
        <div role="button" aria-label="Log In" aria-disabled="true" tabindex="-1">Log in</div>
        <input type="submit" style="width: 0; height: 0; padding: 0; border: 0">
        <div role="button" tabindex="0">Help</div><button type="button">Help</button>
        <a href="/accounts/password/reset/">Forgot password?</a></form>`,
    );
    const observation = observe();
    expect(observation.complete).toBe(true);
    const texts = summary(observation).flatMap(({ target }) =>
      target.by === "text" ? [target.value] : [],
    );
    // The native button keeps its text, so the Help widget gets none; Menu is outside.
    expect(texts.toSorted()).toEqual(["Forgot password?", "Help", "Log in"]);
    expect(findTargets(document, { by: "text", value: "Log in" })).toHaveLength(1);
    // Fields outside any form leave the page's role=button widgets without a text locator.
    page(
      `<input name="email"><input name="pass" type="password">
      <div role="button" tabindex="0">Log in</div><button id="go">Go</button>`,
    );
    expect(
      summary(observe()).some(({ target }) => target.by === "text" && target.value === "Log in"),
    ).toBe(false);
    // A form that is no login form, such as a search form beside one, names none either.
    page(
      `<form role="search"><input name="q"><div role="button" tabindex="0">Search</div></form>
      <form><input name="email" autocomplete="username"><input name="pass" type="password">
        <button>Log in</button></form>`,
    );
    expect(
      summary(observe()).some(({ target }) => target.by === "text" && target.value === "Search"),
    ).toBe(false);
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

  describe("a form fading in from opacity 0 (Microsoft Entra, 2026-10-17)", () => {
    const keyframes = `<style>
      @keyframes in { from { opacity: 0 } }
      @keyframes out { to { opacity: 0 } }
      @keyframes hold { from, to { opacity: 0 } }
      @keyframes show { from { opacity: 0 } to { opacity: 1 } }
      @keyframes outhold { 0% { opacity: 1 } 5%, 100% { opacity: 0 } }
      @keyframes slide { 0%, 30% { opacity: 1 } 33%, 100% { opacity: 0 } }
    </style>`;
    const fields = `<input id="u" type="email"><input id="p" type="password">
      <button id="go">Next</button>`;
    const ids = (observation: LoginObservation) =>
      observation.candidates.map((candidate) => candidate.target.value);
    const container = () => document.querySelector<HTMLElement>("#fade")!;
    /** A container whose opacity transitions from 0 to 1 over 5 seconds. */
    const transition = () => {
      page(`<div id="fade" style="opacity:0"><form id="f">${fields}</form></div>`);
      const fade = container();
      // Read the style so the change below starts a transition.
      expect(getComputedStyle(fade).opacity).toBe("0");
      fade.style.transition = "opacity 5s";
      fade.style.opacity = "1";
      return fade;
    };

    it("is complete while a CSS animation or transition is still at opacity 0", () => {
      for (const animation of [
        "in 5s",
        // Held at its start, as an animation stays while the tab is not rendered.
        "in 5s 1000s both",
        "in 5s paused",
      ]) {
        page(
          `${keyframes}<div id="fade" style="animation:${animation}"><form id="f">${fields}</form></div>`,
        );
        expect(getComputedStyle(container()).opacity, animation).toBe("0");
        const observation = observe();
        expect(observation.complete, animation).toBe(true);
        expect(ids(observation), animation).toEqual(["u", "p", "go"]);
        expect(observation.candidates.at(-1), animation).toMatchObject({ label: "Next" });
      }
      transition();
      expect(getComputedStyle(container()).opacity).toBe("0");
      expect(observe().complete).toBe(true);
      // Transparent by its own style until a delayed animation without a fill starts.
      page(`${keyframes}<div id="fade" style="opacity:0;animation:show 5s 1000s">
        <form id="f">${fields}</form></div>`);
      expect(getComputedStyle(container()).opacity).toBe("0");
      expect(observe().complete).toBe(true);
      // Paused at its start by a script.
      const fade = transition();
      const [running] = fade.getAnimations();
      running!.pause();
      running!.currentTime = 0;
      expect(running!.playState).toBe("paused");
      expect(getComputedStyle(fade).opacity).toBe("0");
      expect(ids(observe())).toEqual(["u", "p", "go"]);
    });

    it("counts an animation on an ancestor further up and in a script's animate()", () => {
      page(`<main id="fade"><div><form id="f">${fields}</form></div></main>`);
      container()
        .animate([{ opacity: 0 }, { opacity: 1 }], { duration: 5000 })
        .pause();
      expect(getComputedStyle(container()).opacity).toBe("0");
      expect(observe().complete).toBe(true);
    });

    it("keeps transparent inputs that are not fading in unfillable", () => {
      const outcome = (html: string) => {
        page(`${keyframes}${html}`);
        for (const animation of container().getAnimations())
          if (animation.effect?.getTiming().fill === "forwards") animation.finish();
        const result = extractLoginObservation();
        return result.ok ? [result.observation.complete, result.gap] : result.reason;
      };
      // A trap at opacity 0 of its own inside a form that fades in.
      expect(
        outcome(`<div id="fade" style="animation:in 5s paused"><form id="f">${fields}
          <input id="trap" style="opacity:0"></form></div>`),
      ).toEqual([false, "unfillable-field"]);
      // A form at opacity 0 is refused alike with no animation, with one that holds the
      // opacity at 0, after a fade-out finished, halfway through a fade-out that then
      // holds for 100 seconds, and as a carousel's slide hidden until its next cycle.
      const still = outcome(`<div id="fade" style="opacity:0"><form id="f">${fields}</form></div>`);
      expect(still).toBe("no-candidates");
      for (const animation of [
        "hold 5s infinite",
        "out 5s forwards",
        "outhold 100s -50s",
        "slide 10s -5s infinite",
      ]) {
        const html = `<div id="fade" style="animation:${animation}"><form id="f">${fields}</form></div>`;
        expect(outcome(html), animation).toEqual(still);
        expect(getComputedStyle(container()).opacity, animation).toBe("0");
      }
    });
  });

  it("names the first cause of an incomplete observation, without page text (ADR 0019)", () => {
    const gap = (html: string, shadow?: string) => {
      page(html);
      if (shadow !== undefined)
        document.querySelector("#host")!.attachShadow({ mode: "open" }).innerHTML = shadow;
      const result = extractLoginObservation();
      if (!result.ok) throw new Error(`no observation: ${result.reason}`);
      return [result.observation.complete, result.gap];
    };
    const form = (extra: string, button = `<button id="go">Log in</button>`) =>
      `<form id="f"><input id="u"><input id="p" type="password">${extra}${button}</form>`;
    expect(gap(form(""))).toEqual([true, undefined]);
    for (const [html, shadow, expected] of [
      // A fillable field in any shadow root.
      [`${form("")}<div id="host"></div>`, `<input type="password">`, "shadow-field"],
      // Another control in a shadow root inside the login form.
      [form(`<div id="host"></div>`), `<button>Voice</button>`, "shadow-control"],
      [form(`<input id="pin" type="password" readonly>`), undefined, "unfillable-field"],
      [form(`<input id="pin" type="password" disabled>`), undefined, "unfillable-field"],
      [form(`<input id="pin" style="opacity:0">`), undefined, "unfillable-field"],
      [form(`<select id="kind"><option>A</option></select>`), undefined, "unsupported-control"],
      [form(`<input type="radio" id="kind">`), undefined, "unsupported-control"],
      [form(`<input>`), undefined, "unlocated-field"],
      [form(`<input type="checkbox">`), undefined, "unlocated-checkbox"],
      [form("", `<button>Log in</button><button>Log in</button>`), undefined, "unlocated-button"],
      // An icon button may be the form's only, script-run submit.
      [
        form(
          "",
          `<button type="button" aria-label="Show"><svg width="16" height="16"></svg></button>`,
        ),
        undefined,
        "unlocated-button",
      ],
      [
        `<form id="f">${Array.from({ length: 50 }, (_, at) => `<input id="i${at}">`).join("")}</form>`,
        undefined,
        "too-many-candidates",
      ],
      // The first cause in a fixed order, whatever the document order.
      [
        form(`<input>${"<select id='k'><option>A</option></select>"}`),
        undefined,
        "unsupported-control",
      ],
      [form(`<input type="checkbox"><input id="r" readonly>`), undefined, "unfillable-field"],
      [`${form("<select id='k'></select>")}<div id="host"></div>`, `<input>`, "shadow-field"],
    ] as const)
      expect(gap(html, shadow), html).toEqual([false, expected]);
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

  it("sends each path segment that may carry a session ID or token as [id] on every page (ADR 0039)", () => {
    page(`<input id="u"><input id="p" type="password"><button id="go">Log in</button>`);
    const magento = btoa("https://shop.example/en/?SID=synthetic0session1&___SID=U")
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replaceAll("=", ",");
    for (const redacted of [
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
      history.replaceState(null, "", redacted);
      // A login page and a signed-in page carry the same path, each such segment replaced
      // as a whole, so the token never leaves the device.
      const login = extractLoginObservation();
      const signedIn = extractSignedInObservation();
      if (!login.ok || !signedIn.ok) throw new Error(redacted);
      expect(login.observation.path, redacted).toContain("/[id]");
      expect(login.observation.path.split("/").length, redacted).toBe(redacted.split("/").length);
      expect(signedIn.observation.path, redacted).toBe(login.observation.path);
    }
    for (const [raw, sent] of [
      // A tenant's UUID, as on a Microsoft Entra sign-in page.
      ["/123e4567-e89b-12d3-a456-426614174000/oauth2/authorize", "/[id]/oauth2/authorize"],
      ["/89abcdef-0123-4567-89ab-cdef01234567/oauth2/authorize", "/[id]/oauth2/authorize"],
      // An authorization server's ID, as on an Okta sign-in page.
      ["/oauth2/aus1a2b3c4d5e6f7g8h9/v1/authorize", "/oauth2/[id]/v1/authorize"],
      // A matrix parameter replaces its whole segment.
      ["/app/login;jsessionid=Synthetic0Session1", "/app/[id]"],
      ["/app/register;jsessionid=Synthetic0Session2", "/app/[id]"],
      ["/0123456789abcdef0123456789abcdef/home", "/[id]/home"],
      ["/s/0123456789abcdef0123456789abcdef/login", "/s/[id]/login"],
    ] as const) {
      history.replaceState(null, "", raw);
      expect(extractLoginObservation(), raw).toMatchObject({
        ok: true,
        observation: { path: sent },
      });
      expect(extractSignedInObservation(), raw).toMatchObject({
        ok: true,
        observation: { path: sent },
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
      expect(extractLoginObservation(), allowed).toMatchObject({
        ok: true,
        observation: { path: allowed },
      });
      expect(extractSignedInObservation(), allowed).toMatchObject({
        ok: true,
        observation: { path: allowed },
      });
    }
  });

  it("locates nothing by an ID or name that may be a token on a page whose path had one replaced (ADR 0039)", () => {
    // Stable-looking, so only the token rule keeps it out (`changingId` would not).
    const token = "SYNTHETIC0TOKEN1234";
    page(
      `<form><label>Email <input id="email-${token}" name="loginfmt" type="email"></label>
      <input id="pw-${token}" name="pw-${token}" type="password" autocomplete="current-password">
      <button id="go-${token}" type="submit">Next</button></form>`,
    );
    history.replaceState(null, "", "/123e4567-e89b-12d3-a456-426614174000/oauth2/authorize");
    const observation = observe();
    expect(observation.path).toBe("/[id]/oauth2/authorize");
    expect(observation.complete).toBe(true);
    expect(summary(observation).map((candidate) => candidate.target)).toEqual([
      { by: "name", value: "loginfmt" },
      { by: "autocomplete", value: "current-password" },
      { by: "text", value: "Next" },
    ]);
    expect(JSON.stringify(observation)).not.toContain(token);
    // A page whose path carries no token keeps its IDs, as before.
    history.replaceState(null, "", "/oauth2/authorize");
    expect(summary(observe()).map((candidate) => candidate.target)).toEqual([
      { by: "id", value: `email-${token}` },
      { by: "id", value: `pw-${token}` },
      { by: "id", value: `go-${token}` },
    ]);
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

  it("never names a marker by an ID that another load may change", () => {
    // A Mantine-built site (2026-10-13): Tabs give each tab `${useId}-tab-${value}`.
    page(
      `<header><nav><a id="mantine-ypxwydcwg-tab-mypage" href="/mypage">マイページ</a>
        <a id="account-menu" href="/account">Account</a>
        <a id="nav-k3j9x2m1q" href="/a">More</a>
        <a id="nav-p8d2w5z7c" href="/b">More</a></nav></header>
      <input id="mantine-v0zmrhrmb" aria-label="Search">`,
    );
    const observation = signedIn();
    expect(observation.complete).toBe(true);
    // Links are named by their paths instead (ADR 0029).
    expect(summary(observation)).toEqual([
      { role: "link", target: { by: "href", value: "/mypage" }, label: "マイページ" },
      { role: "link", target: { by: "id", value: "account-menu" }, label: "Account" },
      { role: "link", target: { by: "href", value: "/a" }, label: "More" },
      { role: "link", target: { by: "href", value: "/b" }, label: "More" },
    ]);
    // A field that may be a sign-in field keeps such an ID rather than leave the page
    // incomplete, as on a login page.
    page(
      `<a id="mantine-ypxwydcwg-tab-mypage" href="/mypage">マイページ</a>
      <input id="mantine-v0zmrhrmb" type="password">`,
    );
    const withField = signedIn();
    expect(withField.complete).toBe(true);
    expect(withField.candidates.map(({ target }) => target)).toEqual([
      { by: "href", value: "/mypage" },
      { by: "id", value: "mantine-v0zmrhrmb" },
    ]);
  });

  it("names a marker only by a value no hidden copy shares (ADR 0037 amendment of 2026-10-22)", () => {
    page(
      `<header><a name="account" href="/account">My page</a>
        <a name="account" href="/settings" hidden>Settings</a></header>`,
    );
    // A marker counts every copy, so the shared name never names it.
    expect(summary(signedIn())).toEqual([
      { role: "link", target: { by: "href", value: "/account" }, label: "My page" },
    ]);
  });

  it("names a field that may be a sign-in field by its visible name, never a marker", () => {
    page(
      `<a id="mantine-ypxwydcwg-tab-mypage" href="/mypage">マイページ</a>
      <input id="mantine-v0zmrhrmb" type="password" placeholder="パスワード">
      <input id="mantine-qwhxkbtfz" inputmode="numeric" maxlength="6" placeholder="6桁のコード">
      <input id="mantine-p9o8i7u6y" aria-label="Search">`,
    );
    const observation = signedIn();
    expect(observation.complete).toBe(true);
    // A name with a number, which this page's text never shows, is not used.
    expect(observation.candidates.map(({ target }) => target)).toEqual([
      { by: "href", value: "/mypage" },
      { by: "label", value: "パスワード" },
      { by: "id", value: "mantine-qwhxkbtfz" },
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
    // A <wbr> or a zero-width space does not split an address out of its redaction.
    page(
      `<header><span>taro.yamada@<wbr>example.com</span><span>me@&#8203;example.com</span></header>
      <button id="logout" type="button">Sign out</button>`,
    );
    expect(signedIn().headerText).toBe("[email] [email]");
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
    // once three texts are found nothing further up is read.
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
    // box of its own leave room for the sentence a parent further up holds, and the text of
    // a text box is never read, even a read-only one that lets the climb go on.
    page(
      `<div><div><p>Enter the code from your authenticator app, taro@example.com</p>
        <div><span>Verification code</span><div>
          <input id="otp" autocomplete="one-time-code" aria-label="Verification code">
          <div>A</div><div>B</div><div role="textbox" aria-readonly="true">my words</div></div>
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

  it("reads text up to six parents above the code field, below any other field to type in (ADR 0027)", () => {
    // A code input wrapped in several elements, with the sentence that names the code's
    // source outside its form, e.g. a site whose sentence sits outside the form: text in
    // the fourth and sixth parents counts.
    const wrapped = (extra: number) =>
      page(
        `<main><div><p>Enter the code from your authenticator app.</p>
          ${"<div>".repeat(extra)}<div><form><p>Codes change every 30 seconds</p>
            <div><div><div><input id="otp" autocomplete="one-time-code" inputmode="numeric"
              maxlength="6" aria-label="Code"></div></div></div>
            <button id="verify" type="submit">Verify</button></form></div>${"</div>".repeat(extra)}
        </div></main>`,
      );
    wrapped(0);
    expect(signedIn().nearCode).toEqual([
      "Enter the code from your authenticator app.",
      "Codes change every [number] seconds",
    ]);
    // Text in the seventh parent does not.
    wrapped(1);
    expect(signedIn().nearCode).toEqual(["Codes change every [number] seconds"]);
    // A parent that holds another shown field to type in, such as a search box, stops the
    // climb: neither its text nor any further up is read.
    page(
      `<div><p>Far text</p>
        <div><span>Search the help center</span><input id="q" type="search" aria-label="Search">
          <div><p>Enter the code from your authenticator app.</p>
            <form><div><input id="otp" autocomplete="one-time-code" aria-label="Code"></div>
              <button id="verify" type="submit">Verify</button></form></div></div></div>`,
    );
    expect(signedIn().nearCode).toEqual(["Enter the code from your authenticator app."]);
    // So does an email field in the code's own form.
    page(
      `<div><p>Enter the code from your authenticator app.</p>
        <form><input id="email" type="email" aria-label="Email">
          <div><span>Codes change every 30 seconds</span>
            <input id="otp" autocomplete="one-time-code" aria-label="Code"></div>
          <button id="verify" type="submit">Verify</button></form></div>`,
    );
    expect(signedIn().nearCode).toEqual(["Codes change every [number] seconds"]);
    // A hidden input, a field not shown and a "Remember this device" checkbox do not.
    page(
      `<div><p>Enter the code from your authenticator app.</p>
        <form><input type="hidden" name="token" value="abc">
          <input id="backup" type="text" hidden aria-label="Backup code">
          <div><input id="otp" autocomplete="one-time-code" aria-label="Code"></div>
          <input id="remember" type="checkbox"><label for="remember">Remember this device</label>
          <button id="verify" type="submit">Verify</button></form></div>`,
    );
    expect(signedIn().nearCode).toEqual(["Enter the code from your authenticator app."]);
    // Nor does a field kept out of reach, as a form's trap for bots is.
    for (const trap of [
      '<input id="trap" type="text" aria-disabled="true" aria-label="Website">',
      '<input id="trap" type="text" tabindex="-1" aria-label="Website">',
      '<div aria-hidden="true"><input id="trap" type="text" aria-label="Website"></div>',
      '<div aria-hidden="TRUE"><input id="trap" type="text" aria-label="Website"></div>',
    ]) {
      page(
        `<div><p>Enter the code from your authenticator app.</p>
          <form>${trap}
            <div><input id="otp" autocomplete="one-time-code" aria-label="Code"></div>
            <button id="verify" type="submit">Verify</button></form></div>`,
      );
      expect(signedIn().nearCode, trap).toEqual(["Enter the code from your authenticator app."]);
    }
    // Nor does a field that cannot be typed in, e.g. the account shown read-only above the
    // code: a read-only, `aria-readonly` or disabled input.
    for (const attribute of ["readonly", 'aria-readonly="true"', "disabled"]) {
      page(
        `<div><p>Enter the code from your authenticator app.</p>
          <form><input id="account" type="email" value="taro@example.com" ${attribute}
              aria-label="Account">
            <div><input id="otp" autocomplete="one-time-code" aria-label="Code"></div>
            <button id="verify" type="submit">Verify</button></form></div>`,
      );
      expect(signedIn().nearCode, attribute).toEqual([
        "Enter the code from your authenticator app.",
      ]);
    }
    // Nor does a select, such as a choice of where the code comes from.
    page(
      `<div><p>Enter the code from your authenticator app.</p>
        <form><select id="method" aria-label="Method"><option>Authenticator app</option>
            <option>Text message</option></select>
          <div><input id="otp" autocomplete="one-time-code" aria-label="Code"></div>
          <button id="verify" type="submit">Verify</button></form></div>`,
    );
    expect(signedIn().nearCode).toEqual(["Enter the code from your authenticator app."]);
    // Shown editable text stops it, as an input does; text marked not editable does not.
    const editable = (box: string) =>
      page(
        `<div><p>Enter the code from your authenticator app.</p>
          <form>${box}
            <div><span>Codes change every 30 seconds</span>
              <input id="otp" autocomplete="one-time-code" aria-label="Code"></div>
            <button id="verify" type="submit">Verify</button></form></div>`,
      );
    for (const box of [
      "<div contenteditable>Notes</div>",
      '<div role="textbox" tabindex="0">Notes</div>',
      '<div role="searchbox" tabindex="0">Search</div>',
    ]) {
      editable(box);
      expect(signedIn().nearCode, box).toEqual(["Codes change every [number] seconds"]);
    }
    editable('<div contenteditable="false">Notes</div>');
    expect(signedIn().nearCode).toEqual([
      "Enter the code from your authenticator app.",
      "Notes",
      "Codes change every [number] seconds",
    ]);
    // An element inside the code field itself is not another field, even one that counts
    // as shown (a child with `display: contents` of a shown input).
    page(
      `<div><p>Enter the code from your authenticator app.</p>
        <form><div><input id="otp" autocomplete="one-time-code" aria-label="Code"></div>
          <button id="verify" type="submit">Verify</button></form></div>`,
    );
    const inside = document.createElement("span");
    inside.contentEditable = "true";
    inside.style.display = "contents";
    document.getElementById("otp")!.append(inside);
    expect(signedIn().nearCode).toEqual(["Enter the code from your authenticator app."]);
    // A code split into one input per digit reaches a sentence a few parents up: the other
    // one-character inputs do not stop the climb.
    const digits = Array.from(
      { length: 6 },
      (_, index) =>
        `<div><input id="d${index}" type="text" inputmode="numeric" maxlength="1"
          aria-label="Digit ${index + 1}"></div>`,
    ).join("");
    page(
      `<main><div><p>Enter the code from your authenticator app.</p>
        <form><div>${digits}</div><button id="verify" type="submit">Verify</button></form>
      </div></main>`,
    );
    expect(signedIn().nearCode).toEqual(["Enter the code from your authenticator app."]);
    // A form card that also names the device being trusted (as one page did, 2026-10-13):
    // the device name's notes stay out, and the text in the code's own group is sent.
    page(
      `<main><div><h1>Two-step verification</h1>
        <form>
          <div><p>Enter the 6-digit code from your authenticator app.</p>
            <div>${digits}</div></div>
          <div><input id="trust" type="checkbox"><label for="trust">Trust this device</label></div>
          <div><label for="device">Device name</label>
            <input id="device" type="text" value="Chrome on Windows">
            <p>※ You can rename this device</p><p>※ This cannot be changed later</p></div>
          <button id="verify" type="submit">Verify</button></form></div></main>`,
    );
    expect(signedIn().nearCode).toEqual([
      "Enter the [number]-digit code from your authenticator app.",
    ]);
  });

  it("never sends code-like text near the code field (ADR 0027)", () => {
    const near = (text: string) =>
      page(
        `<div><div>${text}</div>
          <input id="otp" autocomplete="one-time-code" aria-label="Code"></div>
        <button id="verify" type="submit">Verify</button>`,
      );
    // Text in `code`, `pre`, `kbd` or `samp`, which may show a setup key or recovery code,
    // is left out, and so is everything inside one.
    for (const tag of ["code", "pre", "kbd", "samp"]) {
      near(
        `<p>Enter the code from your authenticator app.</p>
        <${tag}>Setup words <span>for this app</span></${tag}><${tag}>Plain words</${tag}>`,
      );
      expect(signedIn().nearCode, tag).toEqual(["Enter the code from your authenticator app."]);
    }
    // A text that looks like a key or recovery code is never sent: an unspaced key, a key
    // in groups of capitals and digits, hyphenated groups and lowercase groups with digits.
    for (const text of [
      "Enter this key: JBSWY3DPEHPK3PXP",
      "JBSW Y3DP EHPK 3PXP",
      "ABCD EFGH IJKL",
      "abcd-efgh-ijkl",
      "a1b2 c3d4 e5f6",
      // A key with four or more digits in a row is read before redaction hides them.
      "Key: ABCDEFGH2345IJKL",
      "ABCD 2345 EFGH IJ2K",
      "Your key ABCD-EFGH-2345-IJKL",
      // An invisible character inside a key does not split it.
      "Key: JBSWY3DP\u200bEHPK3PXP",
      "Key: JBSWY3DP\u00adEHPK3PXP",
    ]) {
      near(`<span>${text}</span>`);
      expect(signedIn(), text).not.toHaveProperty("nearCode");
    }
    // Two hyphenated groups holding a letter and a digit, two words side by side of four to
    // eight letters and digits that each mix them, and four or more groups of four of which
    // two mix them are keys too. Two model names side by side look the same and are left
    // out as well, an accepted false positive.
    for (const text of [
      "a1b2c-3d4e5",
      "JBSW-Y3DP",
      "XK7Q 9PLM",
      "JBSWY3DP EHPK3PXP",
      "jbsw y3dp ehpk 3pxp",
      "Use iPhone15 iPad10",
    ]) {
      near(`<span>${text}</span>`);
      expect(signedIn(), text).not.toHaveProperty("nearCode");
    }
    // A key printed one group per element, inline or in blocks, and recovery codes one per
    // list item show as a key only in a parent's text; none of their parts is sent.
    for (const key of [
      "<p><span>JBSW</span><span>Y3DP</span><span>EHPK</span><span>3PXP</span></p>",
      "<div><div>JBSW</div><div>Y3DP</div><div>EHPK</div><div>3PXP</div></div>",
      "<ul><li>7FJ2K9PL</li><li>AB3D9XYZ</li><li>Q8RT4MNB</li><li>Z2XC7VBN</li></ul>",
    ]) {
      near(key);
      expect(signedIn(), key).not.toHaveProperty("nearCode");
    }
    // A parent that shows a key leaves out every text read in it, also those in another
    // branch than the key's; texts found nearer the field, before it was reached, stay.
    page(
      `<div><div><span>JBSW</span><span>Y3DP</span><span>EHPK</span><span>3PXP</span></div>
        <div><p>Enter the code from your authenticator app.</p>
          <div><span>Codes change every 30 seconds</span>
            <input id="otp" autocomplete="one-time-code" aria-label="Code"></div></div>
        <p>Trouble? Contact support</p></div>
      <button id="verify" type="submit">Verify</button>`,
    );
    expect(signedIn().nearCode).toEqual([
      "Enter the code from your authenticator app.",
      "Codes change every [number] seconds",
    ]);
    // Ordinary sentences are, in any language.
    near(
      `<p>Enter the 6-digit code from your authenticator app.</p><p>your code from this app</p>
      <p>認証アプリに表示されている6桁のコードを入力してください</p>`,
    );
    expect(signedIn().nearCode).toEqual([
      "Enter the [number]-digit code from your authenticator app.",
      "your code from this app",
      "認証アプリに表示されている[number]桁のコードを入力してください",
    ]);
    // So are sentences with an email address, a phone number, a device or key model or a
    // number in groups, hidden as the rest of the page.
    for (const [text, sent] of [
      ["We sent a code to user42@example.com", "We sent a code to [email]"],
      ["Code sent to yamada2024@example.com", "Code sent to [email]"],
      ["Code sent to your iPhone15", "Code sent to your iPhone[number]"],
      [
        "Enter the code we sent to +1 0123-4567-8901",
        "Enter the code we sent to +[number] [number]-[number]-[number]",
      ],
      ["Open your FIDO2 key", "Open your FIDO[number] key"],
      ["SMS to 090-1234-5678", "SMS to [number]-[number]-[number]"],
      ["Call 0123 4567 8901 for help", "Call [number] [number] [number] for help"],
      ["Dial 0800 1234 5678 for help", "Dial [number] [number] [number] for help"],
      ["CALL 0123 4567 8901", "CALL [number] [number] [number]"],
      ["Use your iPhone15 to sign in", "Use your iPhone[number] to sign in"],
      // Mixed words apart from each other are not a key.
      ["Use your iPhone15 with your iPad2", "Use your iPhone[number] with your iPad[number]"],
      ["Open Authy2 then your FIDO2 key", "Open Authy[number] then your FIDO[number] key"],
      // Nor are fewer than four groups of four, or groups of four with one mixed word.
      ["Use Pix7 with Mac2", "Use Pix[number] with Mac[number]"],
      ["Sign into your Pix7 with this code", "Sign into your Pix[number] with this code"],
      ["ABCD-EFGH", "ABCD-EFGH"],
    ]) {
      near(`<span>${text}</span>`);
      expect(signedIn().nearCode, text).toEqual([sent]);
    }
  });

  describe("texts near the buttons of a page without a code field (ADR 0027)", () => {
    // Oracle Cloud's FIDO step (2026-10-13), reduced: a help widget beside the step, a
    // tenant and account in the outer section, and in the main landmark a heading below
    // h3, the sentence that says what "Verify" starts, the button three parents below it
    // and a link.
    const sentence =
      "To verify your credentials using FIDO Authenticator Security Key or Windows Hello, click Verify.";
    const help =
      "An identity domain is a container for managing users and roles, federating and provisioning of users.";
    const step = (main: string) =>
      `<oj-idaas-module-adapter ${main}><oj-module><div class="oj-flex">
        <h4>FIDO Authenticator Verification</h4>
        <span>${sentence}</span>
        <div><oj-button><button id="verify" type="button"><span>Verify</span></button></oj-button></div>
        <a href="#">Show alternative login methods</a>
      </div></oj-module></oj-idaas-module-adapter>`;
    const widget = `<div><div>Default</div>
      <div class="oj-idaas-signin-domain-info">
        <a role="button" tabindex="0" id="oj-idaas-signin-section-domain-help-link"><span>What is an identity domain?</span></a>
        <span>${help}</span></div></div>`;
    // `wrap` more parents between the section and the step put the widget out of reach
    // of the step's button.
    const oracle = (main: string, wrap = 0) =>
      page(
        `<div id="app"><section><h1>Example Tenant</h1><h2>taro@example.com</h2>
          ${widget}${"<div>".repeat(wrap)}${step(main)}${"</div>".repeat(wrap)}</section></div>`,
        "Sign In | Example Cloud",
      );
    const outside = [help, "Default", "What is an identity domain?"];

    it("sends the texts near the buttons inside the main landmark, not a widget beside it", () => {
      for (const main of ['role="main"', 'role="MAIN"', 'role="region main"']) {
        oracle(main, 2);
        const observation = signedIn();
        expect(observation.nearButtons, main).toEqual([
          "FIDO Authenticator Verification",
          sentence,
        ]);
        expect(observation, main).not.toHaveProperty("nearCode");
      }
      // A `main` element counts as the landmark too.
      page(
        `<div id="app"><section>${widget}<div><div>${step("")
          .replace("<oj-idaas-module-adapter >", "<main>")
          .replace("</oj-idaas-module-adapter>", "</main>")}</div></div></section></div>`,
      );
      expect(signedIn().nearButtons).toEqual(["FIDO Authenticator Verification", sentence]);
    });

    it("never sends a widget's text beside the main landmark, even within six parents", () => {
      // The widget beside the landmark is within six parents of the step's button, but the
      // climb from the button stops at the landmark.
      oracle('role="main"');
      const observation = signedIn();
      for (const text of [...outside, "Verify", "Show alternative login methods"])
        expect(observation.nearButtons, text).not.toContain(text);
      expect(observation.nearButtons).toEqual(["FIDO Authenticator Verification", sentence]);
    });

    it("reads around every button by depth without a main landmark", () => {
      // The help button comes first in the page, so its nearer texts are taken first, one
      // parent at a time around both buttons, and the step's sentence is left out.
      oracle("");
      expect(signedIn().nearButtons).toEqual(["Default", help, "FIDO Authenticator Verification"]);
      // With the widget out of the step button's reach, its texts still come first.
      oracle("", 2);
      expect(signedIn().nearButtons).toEqual(["Default", help, "FIDO Authenticator Verification"]);
    });

    it("reads the first shown main landmark, not a hidden one before it", () => {
      for (const hidden of [
        "<main hidden>",
        '<main style="display: none">',
        '<div role="main" hidden>',
      ]) {
        const close = hidden.startsWith("<main") ? "</main>" : "</div>";
        page(
          `${hidden}<p>Your dashboard overview</p><button id="refresh" type="button">Refresh</button>${close}
          <main><p>Touch your security key to continue.</p>
            <button id="verify" type="button">Verify</button></main>`,
        );
        expect(signedIn().nearButtons, hidden).toEqual(["Touch your security key to continue."]);
      }
    });

    it("reads only the open modal dialog that holds a button", () => {
      const behind = `<main aria-hidden="true"><div><p>Your dashboard overview</p>
        <button id="refresh" type="button">Refresh</button></div></main>`;
      const inside = `<div><p>Touch your security key to continue.</p>
        <button id="verify" type="button">Verify</button></div>`;
      page(`${behind}<div role="dialog" aria-modal="true">${inside}</div>`);
      let observation = signedIn();
      // The page behind the modal is read, as the existing modal tests show, but its texts
      // are not sent near the buttons.
      expect(observation.candidates).toContainEqual(
        expect.objectContaining({ role: "button", label: "Refresh" }),
      );
      expect(observation.nearButtons).toEqual(["Touch your security key to continue."]);
      // A native modal opened with `showModal()` bounds them the same way.
      page(`${behind.replace(' aria-hidden="true"', "")}<dialog id="key">${inside}</dialog>`);
      document.querySelector<HTMLDialogElement>("#key")!.showModal();
      observation = signedIn();
      expect(observation.nearButtons).toEqual(["Touch your security key to continue."]);
      // A dialog that is not modal does not bound them: the main landmark does.
      page(
        `<main><div><p>Your dashboard overview</p>
          <button id="refresh" type="button">Refresh</button></div></main>
        <div role="dialog">${inside}</div>`,
      );
      expect(signedIn().nearButtons).toEqual(["Your dashboard overview"]);
    });

    it("never reads around the header's buttons or sends the header's texts", () => {
      for (const [open, close] of [
        ["<header>", "</header>"],
        ["<nav>", "</nav>"],
        ['<div role="banner">', "</div>"],
        ['<div role="navigation">', "</div>"],
      ] as const) {
        page(
          `<div id="app">${open}<div><span>Signed in to Example Tenant</span>
              <button id="menu" type="button">Menu</button></div>${close}
            <section><div><div><p>Touch your security key to continue.</p>
              <div><button id="verify" type="button">Verify</button></div></div></div></section>
          </div>`,
        );
        const observation = signedIn();
        expect(observation.nearButtons, open).toEqual(["Touch your security key to continue."]);
        // The header text carries it instead.
        if (open === "<header>" || open.includes("banner"))
          expect(observation.headerText, open).toContain("Signed in to Example Tenant");
      }
      // A page whose only button is in the header sends none.
      page(
        `<div id="app"><header><div><span>Signed in to Example Tenant</span>
            <button id="menu" type="button">Menu</button></div></header>
          <section><p>Touch your security key to continue.</p>
            <a id="other" href="/other">Use another method</a></section></div>`,
      );
      expect(signedIn()).not.toHaveProperty("nearButtons");
    });

    it("sends texts near a code field instead when the page has one", () => {
      page(
        `<main><div><p>Touch your security key to continue.</p>
          <div><span>Enter the code from your authenticator app.</span>
            <input id="otp" autocomplete="one-time-code" aria-label="Code"></div>
          <div><span>Or use your security key</span>
            <button id="key" type="button">Use security key</button></div>
          <button id="verify" type="submit">Verify</button></div></main>`,
      );
      const observation = signedIn();
      expect(observation.nearCode).toEqual([
        "Touch your security key to continue.",
        "Enter the code from your authenticator app.",
        "Or use your security key",
      ]);
      expect(observation).not.toHaveProperty("nearButtons");
      // A split code's first input counts as a code field as well.
      const digits = Array.from(
        { length: 6 },
        (_, index) =>
          `<input id="d${index}" type="text" inputmode="numeric" maxlength="1"
            aria-label="Digit ${index + 1}">`,
      ).join("");
      page(
        `<main><div><p>Enter the code from your authenticator app.</p><div>${digits}</div>
          <button id="verify" type="submit">Verify</button></div></main>`,
      );
      expect(signedIn().nearCode).toEqual(["Enter the code from your authenticator app."]);
      expect(signedIn()).not.toHaveProperty("nearButtons");
    });

    it("sends none without a button, or without one inside the main landmark", () => {
      // Links only.
      page(
        `<main><div><p>Touch your security key to continue.</p>
          <a id="other" href="/other">Use another method</a></div></main>`,
      );
      expect(signedIn()).not.toHaveProperty("nearButtons");
      // The only button sits outside the landmark, next to a text.
      page(
        `<div><div><p>Need help with your account?</p>
          <button id="help" type="button">Help</button></div>
        <main><div><p>Touch your security key to continue.</p>
          <a id="other" href="/other">Use another method</a></div></main></div>`,
      );
      expect(signedIn()).not.toHaveProperty("nearButtons");
    });

    // A step with one button, and `text` beside its sentence.
    const near = (text: string) =>
      page(
        `<main><div><p>Touch your security key to continue.</p>${text}
          <div><button id="verify" type="button">Verify</button></div></div></main>`,
        "Security check",
      );

    it("leaves out live regions, controls, labels, links, headings and repeated texts", () => {
      near("");
      expect(signedIn().nearButtons).toEqual(["Touch your security key to continue."]);
      for (const text of [
        '<p role="alert">Security key not detected</p>',
        '<p role="status">Waiting for your security key</p>',
        '<p aria-live="polite">Waiting for your security key</p>',
        '<a href="/help">Trouble with your security key?</a>',
        '<span role="link" tabindex="0">Trouble with your security key?</span>',
        '<span role="button" tabindex="0">Try again later</span>',
        '<label for="remember">Remember this device</label><input id="remember" type="checkbox">',
        "<h1>Use your security key</h1>",
        "<h2>Use your security key</h2>",
        "<h3>Use your security key</h3>",
        '<div role="heading" aria-level="4">Use your security key</div>',
        "<code>Use your security key</code>",
        // A text that repeats the title, a heading or a button's label.
        "<span>Security check</span>",
        "<h1>Use your security key</h1><span>Use your security key</span>",
        "<span>Verify</span>",
        // Fewer than two letters beside the placeholders.
        "<span>9:59</span>",
        "<span>A</span>",
        "<span>5 s</span>",
        "<span>taro@example.com 5</span>",
      ]) {
        near(text);
        expect(signedIn().nearButtons, text).toEqual(["Touch your security key to continue."]);
      }
      // A key or recovery code leaves out every text read in the parent that shows it.
      for (const text of [
        "<span>Your key ABCD-EFGH-1234-5678</span>",
        "<span>ABCD-EFGH-1234-5678</span>",
        "<p><span>JBSW</span><span>Y3DP</span><span>EHPK</span><span>3PXP</span></p>",
      ]) {
        near(text);
        expect(signedIn(), text).not.toHaveProperty("nearButtons");
      }
      // A parent that holds another shown field to type in stops the climb.
      page(
        `<div><p>Far away text</p>
          <div><input id="q" type="search" aria-label="Search">
            <div><p>Touch your security key to continue.</p>
              <div><button id="verify" type="button">Verify</button></div></div></div></div>`,
      );
      expect(signedIn().nearButtons).toEqual(["Touch your security key to continue."]);
    });

    it("hides and cuts the texts as the rest of the page", () => {
      near("<span>We sent a request to taro@example.com, valid for 5 minutes</span>");
      expect(signedIn().nearButtons).toEqual([
        "Touch your security key to continue.",
        "We sent a request to [email], valid for [number] minutes",
      ]);
      near("<span>Call +1 0123-4567-8901 if you lost your key</span>");
      expect(signedIn().nearButtons).toEqual([
        "Touch your security key to continue.",
        "Call +[number] [number]-[number]-[number] if you lost your key",
      ]);
      // A long text is cut at 120 characters.
      const long = `To verify your credentials ${"using your security key ".repeat(8)}click Verify.`;
      near(`<span>${long}</span>`);
      const [, cut] = signedIn().nearButtons!;
      expect(cut!.length).toBeLessThanOrEqual(120);
      expect(long.startsWith(cut!)).toBe(true);
      expect(cut!.length).toBeGreaterThan(110);
    });

    // Oracle Cloud's FIDO step as the page showed it (2026-10-13): three nested main
    // landmarks, the first an `oj-module`, and the step, with its sentence and the Verify
    // button, in an `aria-live` region.
    const liveStep = (extra = "") =>
      `<div id="app"><section><h1>Example Tenant</h1><h2>taro@example.com</h2>${widget}
        <oj-module role="main" style="display: block"><oj-idaas-module-adapter role="main">
          <oj-module><oj-idaas-module-adapter id="idcs-mfa-mfa-auth-factors-section-content" role="main">
            <oj-module><div aria-live="polite" class="oj-flex oj-sm-12">
              <h4>FIDO Authenticator Verification</h4>
              <span id="idcs-mfa-mfa-auth-fido-text">${sentence}</span>${extra}
              <div class="oj-flex-item"><oj-button id="idcs-mfa-mfa-auth-fido-submit-button">
                <button type="button"><span>Verify</span></button></oj-button></div>
              <a href="#">Show alternative login methods</a>
            </div></oj-module>
          </oj-idaas-module-adapter></oj-module>
        </oj-idaas-module-adapter></oj-module></section></div>`;

    it("reads a polite live region that holds one of the buttons, as Oracle Cloud's step", () => {
      page(liveStep(), "Sign In | Example Cloud");
      const observation = signedIn();
      // The h4 is read as any text: only headings up to h3, which the observation carries,
      // are left out.
      expect(observation.nearButtons).toEqual(["FIDO Authenticator Verification", sentence]);
      expect(observation).not.toHaveProperty("nearCode");
      // A region marked `aria-live="off"` is no live region and is read as before.
      page(
        `<main><div aria-live="off"><p>Touch your security key to continue.</p>
          <div><button id="verify" type="button">Verify</button></div></div></main>`,
      );
      expect(signedIn().nearButtons).toEqual(["Touch your security key to continue."]);
      // Every polite region around the button inside the main landmark is read, not only
      // the nearest, and so is the landmark itself when it is one.
      page(
        `<main aria-live="POLITE"><div aria-live="polite"><p>Touch your security key to continue.</p>
          <div aria-live="polite"><p>Waiting for your security key</p>
            <div><button id="verify" type="button">Verify</button></div></div></div></main>`,
      );
      expect(signedIn().nearButtons).toEqual([
        "Touch your security key to continue.",
        "Waiting for your security key",
      ]);
      // Inside an open modal dialog that bounds the texts, as well.
      page(
        `<main aria-hidden="true"><p>Your dashboard overview</p></main>
        <div role="dialog" aria-modal="true"><div aria-live="polite">
          <p>Touch your security key to continue.</p>
          <div><button id="verify" type="button">Verify</button></div></div></div>`,
      );
      expect(signedIn().nearButtons).toEqual(["Touch your security key to continue."]);
    });

    it("leaves out an alert, status, log, marquee, timer or assertive region that holds a button", () => {
      for (const live of [
        'role="status"',
        'role="alert"',
        'role="log"',
        'role="marquee"',
        'role="timer"',
        'aria-live="assertive"',
        // A role of its own makes a polite region no step.
        'role="status" aria-live="polite"',
        'role="log" aria-live="polite"',
      ]) {
        page(
          `<main><div ${live}><p>Touch your security key to continue.</p>
            <div><button id="verify" type="button">Verify</button></div></div></main>`,
        );
        expect(signedIn(), live).not.toHaveProperty("nearButtons");
      }
      // An alert with a dismiss button beside the step: its text, which may name the
      // account's key, is not sent, the step's is.
      page(
        `<main><div><p>Touch your security key to continue.</p>
            <div><button id="verify" type="button">Verify</button></div></div>
          <div role="alert"><p>Your last attempt with key Bravo failed</p>
            <button id="dismiss" type="button" aria-label="Dismiss">x</button></div></main>`,
      );
      let observation = signedIn();
      expect(observation.nearButtons).toEqual(["Touch your security key to continue."]);
      expect(JSON.stringify(observation)).not.toContain("Bravo");
      // A chat log whose messages each have a button sends none of them.
      page(
        `<main><div role="log"><div><p>Hanako: see you at the station</p>
          <button id="react" type="button">React</button></div></div></main>`,
      );
      observation = signedIn();
      expect(observation).not.toHaveProperty("nearButtons");
      expect(JSON.stringify(observation)).not.toContain("Hanako");
      // A polite step inside a status region is left out with it.
      page(
        `<main><div role="status"><p>Touch your security key to continue.</p>
          <div aria-live="polite"><p>Waiting for your security key</p>
            <div><button id="verify" type="button">Verify</button></div></div></div></main>`,
      );
      expect(signedIn()).not.toHaveProperty("nearButtons");
    });

    it("never reads a live region around the main landmark or without a bound", () => {
      // A page wrapped whole in a polite region: the region is above the main landmark.
      page(
        `<div id="app" aria-live="polite"><header><span>Example Cloud</span>
            <button id="menu" type="button">Menu</button></header>
          <main><div><p>Welcome back, your plan renews on Monday.</p>
            <p>Review your recent sign-ins below.</p>
            <div><button id="continue" type="button">Continue</button></div></div></main></div>`,
      );
      let observation = signedIn();
      expect(observation).not.toHaveProperty("nearButtons");
      expect(JSON.stringify(observation)).not.toContain("recent sign-ins");
      // Without a main landmark or an open modal, no polite region is read.
      page(
        `<div><div><p>Need help? Contact support.</p>
          <div aria-live="polite"><p>Touch your security key to continue.</p>
            <div><button id="verify" type="button">Verify</button></div></div></div></div>`,
      );
      observation = signedIn();
      expect(observation.nearButtons).toEqual(["Need help? Contact support."]);
      expect(JSON.stringify(observation)).not.toContain("Touch your security key");
    });

    it("never reads a live region around a button that is itself left out, as a heading", () => {
      for (const [open, close] of [
        ['<h2 aria-live="polite">', "</h2>"],
        ['<label aria-live="polite">', "</label>"],
        ['<div role="heading" aria-level="4" aria-live="polite">', "</div>"],
      ] as const) {
        page(
          `<main><div><p>Touch your security key to continue.</p>
            ${open}<span>Use your security key</span>
              <span><button id="verify" type="button">Verify</button></span>${close}</div></main>`,
        );
        expect(signedIn().nearButtons, open).toEqual(["Touch your security key to continue."]);
      }
    });

    it("leaves out a live region inside the step's live region that holds no button", () => {
      for (const extra of [
        '<p role="alert">Security key not detected</p>',
        '<p aria-live="assertive">Security key not detected</p>',
        '<div role="status"><span>Waiting for your security key</span></div>',
        '<div role="log"><div><span>Security key not detected</span></div></div>',
      ]) {
        page(liveStep(extra));
        expect(signedIn().nearButtons, extra).toEqual([
          "FIDO Authenticator Verification",
          sentence,
        ]);
      }
      // Nor does the step's region make the other elements it leaves out readable.
      for (const extra of [
        '<label for="remember">Remember this device</label><input id="remember" type="checkbox">',
        "<h3>Use your security key</h3>",
        "<code>Use your security key</code>",
        '<span role="link" tabindex="0">Trouble with your security key?</span>',
      ]) {
        page(liveStep(extra));
        expect(signedIn().nearButtons, extra).toEqual([
          "FIDO Authenticator Verification",
          sentence,
        ]);
      }
    });

    it("leaves out a live region beside the buttons that holds none of them", () => {
      for (const live of ['role="alert"', 'role="status"', 'aria-live="polite"']) {
        // Beside the step's own live region.
        page(
          `<main><div><div aria-live="polite"><p>Touch your security key to continue.</p>
              <div><button id="verify" type="button">Verify</button></div></div>
            <div ${live}><p>Security key not detected</p></div></div></main>`,
        );
        expect(signedIn().nearButtons, live).toEqual(["Touch your security key to continue."]);
        // And beside a step that is no live region.
        page(
          `<main><div><div><p>Touch your security key to continue.</p>
              <div><button id="verify" type="button">Verify</button></div></div>
            <div ${live}><p>Security key not detected</p></div></div></main>`,
        );
        expect(signedIn().nearButtons, live).toEqual(["Touch your security key to continue."]);
      }
    });

    it("never makes a live region readable for a button that does not count", () => {
      // A polite region inside the main landmark that holds only a navigation or header
      // button, which never counts, keeps its text out even though the step's button
      // reaches it.
      for (const [open, close] of [
        ["<nav>", "</nav>"],
        ["<header>", "</header>"],
        ['<div role="navigation">', "</div>"],
      ] as const) {
        page(
          `<main><div><p>Touch your security key to continue.</p>
              <div><button id="verify" type="button">Verify</button></div></div>
            <div aria-live="polite"><span>Signed in as Example Tenant</span>
              ${open}<button id="menu" type="button">Menu</button>${close}</div></main>`,
        );
        expect(signedIn().nearButtons, open).toEqual(["Touch your security key to continue."]);
      }
      // Nor does a hidden button, which is no candidate.
      page(
        `<main><div><p>Touch your security key to continue.</p>
            <div><button id="verify" type="button">Verify</button></div></div>
          <div aria-live="polite"><span>Retrying with your security key</span>
            <button id="retry" type="button" hidden>Retry</button></div></main>`,
      );
      expect(signedIn().nearButtons).toEqual(["Touch your security key to continue."]);
    });

    it("still sends no text near a code field inside a live region", () => {
      for (const live of ['aria-live="polite"', 'role="status"']) {
        page(
          `<main><div ${live}><p>Enter the code from your authenticator app.</p>
            <div><input id="otp" autocomplete="one-time-code" aria-label="Code"></div>
            <button id="verify" type="submit">Verify</button></div></main>`,
        );
        const observation = signedIn();
        expect(observation, live).not.toHaveProperty("nearCode");
        expect(observation, live).not.toHaveProperty("nearButtons");
      }
    });

    it("never sends texts near the buttons of a login page", () => {
      page(
        `<main><form><div><p>Touch your security key to continue.</p>
          <input id="user" type="email" aria-label="Email">
          <input id="pw" type="password" aria-label="Password">
          <div><button id="go" type="submit">Sign in</button></div>
          <div><span>Or use a passkey from your phone</span>
            <button id="passkey" type="button">Use a passkey</button></div></div></form></main>`,
      );
      expect(observe()).not.toHaveProperty("nearButtons");
      // Nor does a first step without a form that asks only for the account.
      page(
        `<main><div><p>Sign in with a passkey or your email address.</p>
          <input id="user" type="email" aria-label="Email">
          <div><button id="next" type="button">Next</button></div></div></main>`,
      );
      expect(observe()).not.toHaveProperty("nearButtons");
    });
  });

  it("never locates by an id or name that carries an email address or a long number", () => {
    page(
      `<a id="acct-0123456789" href="/a">Account</a>
      <a id="card-0123456789" href="/c">Card 0123456789</a>
      <button name="alice@example.com" type="button">Profile</button>
      <button id="logout" name="user-123456" type="button">Sign out</button>`,
    );
    // The links fall back to their paths (ADR 0029); the buttons to their text and id.
    expect(summary(signedIn())).toEqual([
      { role: "link", target: { by: "href", value: "/a" }, label: "Account" },
      { role: "link", target: { by: "href", value: "/c" }, label: "Card [number]" },
      { role: "button", target: { by: "text", value: "Profile" }, label: "Profile" },
      { role: "button", target: { by: "id", value: "logout" }, label: "Sign out" },
    ]);

    // Nor one that may be a token, such as an account ID.
    page(`<button id="acct-a1b2c3d4e5f6a7b8c9d0" type="button">Account</button>`);
    expect(summary(signedIn())).toEqual([
      { role: "button", target: { by: "text", value: "Account" }, label: "Account" },
    ]);

    page(`<form><input id="mail-0123456789" type="email"></form>
      <button id="logout" type="button">Sign out</button>`);
    // A field that may be a sign-in field and cannot be located safely makes the
    // description incomplete, unless its visible name locates it (ADR 0037); another
    // such field is left out.
    expect(signedIn().complete).toBe(false);
    document.querySelector("input")!.setAttribute("aria-label", "Email");
    expect(signedIn().candidates[0]!.target).toEqual({ by: "label", value: "Email" });
    page(`<form><input id="note-0123456789" type="text" aria-label="Note"></form>
      <button id="logout" type="button">Sign out</button>`);
    expect(signedIn().complete).toBe(true);
    expect(summary(signedIn()).map((entry) => entry.target.value)).toEqual(["logout"]);
  });

  it("locates a link by its path when that names nobody, else by its text (ADR 0029)", () => {
    // Shaped like ニコニコ's top bar after sign-in (2026-10-13): plain divs, and the
    // account link's only text is the person's nickname.
    page(
      `<div><a href="/my">Nick</a><a href="https://other.example/my">Elsewhere</a>
        <a href="/user/12345">Uploader</a><a href="/video_top?ref=bar#top">動画</a>
        <a href="/same">One</a><a href="/same">Two</a></div>`,
    );
    const kept = summary(signedIn());
    expect(kept).toEqual([
      { role: "link", target: { by: "href", value: "/my" }, label: "Nick" },
      { role: "link", target: { by: "text", value: "Elsewhere" }, label: "Elsewhere" },
      { role: "link", target: { by: "text", value: "Uploader" }, label: "Uploader" },
      { role: "link", target: { by: "href", value: "/video_top" }, label: "動画" },
      { role: "link", target: { by: "text", value: "One" }, label: "One" },
      { role: "link", target: { by: "text", value: "Two" }, label: "Two" },
    ]);
    // The executor finds each by the same locator, whatever the link's query or fragment.
    for (const entry of kept)
      expect(findTargets(document, entry.target, { links: true }), entry.target.value).toHaveLength(
        1,
      );
    // A login page's description never names a link by its path.
    page(`<form><input id="user" type="text"><button id="go">Go</button></form>
      <a href="/my">Nick</a>`);
    const login = extractLoginObservation();
    expect(
      login.ok && login.observation.candidates.some((entry) => entry.target.by === "href"),
    ).toBe(false);
  });

  it("never locates a link by a path that repeats its text or a header word (ADR 0029)", () => {
    page(
      `<header><span>@taro_y</span><a href="/taro_y/likes">Likes</a>
        <span>Hana · Sato @k.ito</span><a href="/hana-sato">Hana</a><a href="/k.ito/">Ito</a>
      </header>
      <main><a href="/u/Taro-Y">Taro Y</a><a href="/alice/settings">Settings</a>
        <a href="/mypage/">Account</a></main>`,
    );
    expect(summary(signedIn())).toEqual([
      { role: "link", target: { by: "text", value: "Likes" }, label: "Likes" },
      { role: "link", target: { by: "text", value: "Hana" }, label: "Hana" },
      { role: "link", target: { by: "text", value: "Ito" }, label: "Ito" },
      { role: "link", target: { by: "text", value: "Taro Y" }, label: "Taro Y" },
      { role: "link", target: { by: "text", value: "Settings" }, label: "Settings" },
      { role: "link", target: { by: "href", value: "/mypage/" }, label: "Account" },
    ]);
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
    // its links, located by their paths (ADR 0029), are kept in document order; the ads
    // past the limit, the news tabs and the pop-up's close button are left out. The
    // sign-out icon has neither text nor `alt`, but its path locates it.
    expect(kept.slice(-6)).toEqual([
      {
        role: "text",
        target: { by: "id", value: "search" },
        placeholder: "広告名で探す",
        group: "f1",
      },
      { role: "link", target: { by: "href", value: "/my/point.php" }, label: "[number]pt" },
      { role: "link", target: { by: "href", value: "/notice/" }, label: "お知らせ [number]" },
      { role: "link", target: { by: "href", value: "/my/" }, label: "マイページ" },
      { role: "link", target: { by: "href", value: "/my/bankbook.php" }, label: "通帳" },
      { role: "link", target: { by: "href", value: "/logout.php" } },
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
        { role: "link", target: { by: "href", value: "/member/settings" }, label: "設定" },
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

  // A page that asks how to confirm the sign-in, as read in the owner's Chrome on
  // 2026-10-18 (values not kept): row headings, and in each row a link to `#` that shows
  // "Select", which only its accessible name tells apart and whose click a page script
  // handles (ADR 0048 amendment of 2026-10-19).
  describe("controls that show the same text and differ by their accessible names", () => {
    const style = `<style>.factor{display:inline-block;width:63px;height:40px}</style>`;
    const select = (name: string, extra = "") =>
      `<a href="#" class="factor" data-se="button" aria-label="${name}"${extra}>Select</a>`;
    const choice = (
      password = select("Select Password."),
      phone = select("Select Phone - +61 4•• ••• 123"),
    ) =>
      page(
        `${style}<main><h1>Let's confirm it's you</h1><form>
          <div><h3>Password</h3>${password}</div>
          <div><h3>Mobile</h3>${phone}</div>
        </form><a href="/signout">Cancel</a></main>
        <footer><a href="/contact">Contact us</a> <a href="/terms">Terms</a></footer>`,
        "Sign in",
      );
    const named = { by: "accessible-name", value: "Select Password." } as const;
    const byName = (observation: LoginObservation) =>
      observation.candidates.filter((candidate) => candidate.target.by === "accessible-name");

    it("offers the password one as a button located by its name, never the phone one", () => {
      choice();
      const observation = signedIn();
      expect(observation.complete).toBe(true);
      expect(summary(observation)).toEqual([
        { role: "button", target: named, label: "Select Password.", group: "f1" },
        { role: "link", target: { by: "href", value: "/signout" }, label: "Cancel" },
        { role: "link", target: { by: "text", value: "Contact us" }, label: "Contact us" },
        { role: "link", target: { by: "text", value: "Terms" }, label: "Terms" },
      ]);
      // The executor finds the same control by it.
      expect(findTargets(document, named)).toEqual([document.querySelector("a.factor")]);
    });

    it("never locates a name that holds a number", () => {
      choice(select("Select Password 2"), select("Select Phone"));
      expect(byName(signedIn())).toEqual([]);
      choice(select("Select Password."), select("Select Password 2"));
      expect(byName(signedIn()).map(({ target }) => target)).toEqual([named]);
    });

    it("offers nothing when two shown controls share the name", () => {
      choice(select("Select Password."), select("Select Password."));
      expect(byName(signedIn())).toEqual([]);
      // Nor when the other one is a button that shows text of its own.
      choice(
        select("Select Password."),
        `<button type="button" aria-label="Select Password.">Continue</button>`,
      );
      expect(byName(signedIn())).toEqual([]);
    });

    it("never counts a hidden control with the name", () => {
      for (const hidden of [
        select("Select Password.", " hidden"),
        select("Select Password.", ' style="display:none"'),
        `<button type="button" aria-label="Select Password." hidden>Select</button>`,
      ]) {
        choice(select("Select Password."), hidden);
        expect(
          byName(signedIn()).map(({ target }) => target),
          hidden,
        ).toEqual([named]);
      }
    });

    it("needs a name that names the password and a text with no other way", () => {
      for (const password of [
        select("Select Phone"),
        `<button type="button" aria-label="Select Password.">Send code</button>`,
        `<a href="#" aria-label="Select Password.">Use mobile</a>`,
      ]) {
        choice(password, select("Select Phone"));
        expect(byName(signedIn()), password).toEqual([]);
      }
      // Text hidden from assistive technology, or too long to read in full, still counts.
      for (const password of [
        `<a href="#" aria-label="Select Password."><span aria-hidden="true">Send code</span></a>`,
        `<a href="#" aria-label="Select Password.">Send a code to your phone${" now".repeat(40)}</a>`,
        `<a href="#" aria-label="Select Password.">${"Select ".repeat(80)}</a>`,
        `<a href="#" aria-label="Select Password.">Sign out</a>`,
      ]) {
        choice(password, select("Select Phone"));
        expect(byName(signedIn()), password).toEqual([]);
      }
      // A name that redaction would change, as one that holds an email address.
      for (const name of ["Use password for taro@example.com", "Use password ••••"]) {
        choice(select(name), select("Select Phone"));
        expect(byName(signedIn()), name).toEqual([]);
      }
      choice(select("Use password for Taro"), select("Select Phone"));
      expect(byName(signedIn()).map(({ target }) => target)).toEqual([
        { by: "accessible-name", value: "Use password for Taro" },
      ]);
      // A link to a route of the page's router is no control here.
      choice(
        `<a href="#/account/delete" aria-label="Select Password.">Select</a>`,
        select("Select Phone"),
      );
      expect(byName(signedIn())).toEqual([]);
      // A name from `aria-labelledby` comes before `aria-label`.
      choice(
        `<span id="row">Password</span><button type="button" aria-labelledby="row" aria-label="Select Phone">Select</button>`,
        `<button type="button" aria-label="Select Phone">Select</button>`,
      );
      expect(byName(signedIn()).map(({ target }) => target)).toEqual([
        { by: "accessible-name", value: "Password" },
      ]);
    });

    it("keeps a button's unique text and attribute locators first", () => {
      choice(
        `<button type="button" aria-label="Select Password.">Use password</button>`,
        `<button type="button" data-testid="phone" aria-label="Select Phone">Select</button>`,
      );
      expect(summary(signedIn()).slice(0, 2)).toEqual([
        {
          role: "button",
          target: { by: "text", value: "Use password" },
          label: "Select Password.",
          group: "f1",
        },
        {
          role: "button",
          target: { by: "test-id", value: "phone" },
          label: "Select Phone",
          group: "f1",
        },
      ]);
    });

    it("counts a link as such a button only when it stays on its document in the same tab", () => {
      // Fragment links with their own `onclick` are script buttons already.
      const onclick = ' onclick="void 0"';
      choice(select("Select Password.", onclick), select("Select Phone", onclick));
      expect(summary(signedIn())[0]).toEqual({
        role: "button",
        target: named,
        label: "Select Password.",
        group: "f1",
      });
      for (const extra of [' target="_blank"', " download", ' target="other"']) {
        choice(select("Select Password.", extra), select("Select Phone"));
        expect(byName(signedIn()), extra).toEqual([]);
      }
      // An empty `href` reloads the page.
      choice(`<a href="" aria-label="Select Password.">Select</a>`, select("Select Phone"));
      expect(byName(signedIn())).toEqual([]);
      const base = document.createElement("base");
      document.head.append(base);
      try {
        // A `<base target>` opens it elsewhere, and a `<base href>` naming another document
        // makes `#` navigate there.
        base.target = "_blank";
        choice();
        expect(byName(signedIn())).toEqual([]);
        base.removeAttribute("target");
        base.href = "https://elsewhere.example/";
        choice();
        expect(byName(signedIn())).toEqual([]);
        // One that names this document keeps it here.
        base.href = location.href;
        choice();
        expect(byName(signedIn()).map(({ target }) => target)).toEqual([named]);
      } finally {
        base.remove();
      }
    });

    it("is never offered on a login page", () => {
      page(
        `${style}<form><input id="pw" type="password">
          ${select("Select Password.")}${select("Select Phone")}
          <button id="go" type="submit">Sign in</button></form>`,
      );
      expect(byName(observe())).toEqual([]);
    });
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
      listControls(document, { by: "text", value: "Continue" }).length === 1,
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
    const gap = (html: string, shadow?: string) => {
      page(html);
      if (shadow !== undefined)
        document.querySelector("#host")!.attachShadow({ mode: "open" }).innerHTML = shadow;
      const result = extractAccountListObservation();
      if (!result.ok) throw new Error(`no observation: ${result.reason}`);
      return [result.observation.complete, result.gap];
    };
    const continueButton = `<button>Continue</button>`;
    expect(gap(`<button>a@example.com</button>${continueButton}`)).toEqual([true, undefined]);
    for (const [html, shadow, expected] of [
      [
        `<button>a@example.com</button>${continueButton}<div id="host"></div>`,
        `<input type="password">`,
        "shadow-field",
      ],
      [
        `${Array.from({ length: 9 }, (_, at) => `<button>a${at}@example.com</button>`).join("")}${continueButton}`,
        undefined,
        "too-many-accounts",
      ],
      // An address that survives redaction is never sent, so its account is left out.
      [`<button>a@example.com @home</button>${continueButton}`, undefined, "unlisted-accounts"],
      [
        `<button>a@example.com</button>${continueButton}<div>${"<i></i>".repeat(4001)}</div>`,
        undefined,
        "too-many-elements",
      ],
    ] as const)
      expect(gap(html, shadow), html).toEqual([false, expected]);
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
