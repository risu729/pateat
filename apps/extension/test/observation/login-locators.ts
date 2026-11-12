import { expect, it } from "vitest";
import { findTargets } from "../../src/page/targets";
import { extractLoginObservation } from "../../src/observation/extract";
import type { ObservationTestContext } from "./context";

export function registerLoginLocators({
  page,
  observe,
  summary,
}: Pick<ObservationTestContext, "page" | "observe" | "summary">) {
  it("locates a field by name when the ID is missing, duplicated or unusable, then by test ID", () => {
    page(
      `<form id="f"><input id="dup" name="user"><input id="dup" name="other" data-testid="t-other">
        <input id="has space" name="pin"><input id="has space" data-testid="t-code">
        <input data-testid="t-note">
        <button id="go">Go</button></form>`,
    );
    expect(summary(observe()).map((candidate) => candidate.target)).toEqual([
      { by: "name", value: "user" },
      { by: "name", value: "other" },
      { by: "name", value: "pin" },
      { by: "test-id", value: "t-code" },
      { by: "test-id", value: "t-note" },
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
    // With no other locator the ID is still used, so the form stays complete; a button
    // named by its accessible name takes that name first (ADR 0048 amendment of
    // 2026-10-23).
    page(
      `<form><input id="mantine-ypxwydcwg"><input id="mantine-r5" type="password">
        <button id="mantine-qwhxkbtfz" aria-label="Sign in"></button></form>`,
    );
    const observation = observe();
    expect(observation.complete).toBe(true);
    expect(observation.candidates.map(({ target }) => target)).toEqual([
      ...["mantine-ypxwydcwg", "mantine-r5"].map((value) => ({ by: "id", value })),
      { by: "accessible-name", value: "Sign in" },
    ]);
    page(
      `<form><input id="mantine-ypxwydcwg"><input id="mantine-r5" type="password">
        <button id="mantine-qwhxkbtfz"></button></form>`,
    );
    expect(observe().candidates.at(-1)?.target).toEqual({ by: "id", value: "mantine-qwhxkbtfz" });
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
    // With no other locator the ID is still used, so the form stays complete; a button
    // named by its accessible name takes that name first (ADR 0048 amendment of
    // 2026-10-23).
    page(
      `<form><input id="mantine-4p5f7ku4o"><input id="mantine-7pri31duh" type="password">
        <button id="mantine-a1b2c3d4e" aria-label="Sign in"></button></form>`,
    );
    const observation = observe();
    expect(observation.complete).toBe(true);
    expect(observation.candidates.map(({ target }) => target)).toEqual([
      ...["mantine-4p5f7ku4o", "mantine-7pri31duh"].map((value) => ({ by: "id", value })),
      { by: "accessible-name", value: "Sign in" },
    ]);
    page(
      `<form><input id="mantine-4p5f7ku4o"><input id="mantine-7pri31duh" type="password">
        <button id="mantine-a1b2c3d4e"></button></form>`,
    );
    expect(observe().candidates.at(-1)?.target).toEqual({ by: "id", value: "mantine-a1b2c3d4e" });
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

  it("locates a field by its name or autocomplete token before a counter-shaped ID (#1161)", () => {
    // Discord (2026-11-02): `uid_7` and `uid_9` on its invite login page read `uid_13`
    // and `uid_15` on `/login`, for the same inputs.
    page(
      `<form><input id="uid_7" name="email" autocomplete="username webauthn">
        <input id="uid_9" name="password" type="password" autocomplete="current-password">
        <button type="submit">Log In</button></form>`,
    );
    expect(observe().candidates.map(({ target }) => target)).toEqual([
      { by: "name", value: "email" },
      { by: "name", value: "password" },
      { by: "text", value: "Log In" },
    ]);
    // Without a name, a login autocomplete token names the field before the ID.
    page(
      `<form><input id="uid_7" autocomplete="username"><input id="web-ui3" type="password">
        <button id="field-12">Log In</button></form>`,
    );
    expect(observe().candidates.map(({ target }) => target)).toEqual([
      { by: "autocomplete", value: "username" },
      { by: "id", value: "web-ui3" },
      { by: "id", value: "field-12" },
    ]);
    // A library's per-load ID of the same shape still gives way to the visible name.
    page(
      `<form><input id="mantine-r5" type="password" aria-label="Password">
        <button type="submit">Log In</button></form>`,
    );
    expect(observe().candidates[0]?.target).toEqual({ by: "label", value: "Password" });
    // An ID without a separator before its digits is no counter.
    page(`<form><input id="address1" name="line"><input id="address2" name="line2"></form>`);
    expect(observe().candidates.map(({ target }) => target)).toEqual([
      { by: "id", value: "address1" },
      { by: "id", value: "address2" },
    ]);
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
}
