import { expect, it } from "vitest";
import { extractLoginObservation, extractSignedInObservation } from "../../src/observation/extract";
import type { ObservationTestContext } from "./context";

export function registerLoginReaders({
  page,
  observe,
  summary,
}: Pick<ObservationTestContext, "page" | "observe" | "summary">) {
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

  it("leaves out a field both faint and disabled, which takes no input", () => {
    // SBI新生銀行's login form (2026-10-23): a disabled text and password pair at opacity
    // 0, 12 pixels square, before the real fields.
    const decoys = (style: string) =>
      `<input name="dummy_text" disabled style="${style}">` +
      `<input name="dummy_password" type="password" disabled style="${style}">`;
    const form = (extra: string) =>
      `<form id="f">${extra}<input id="u"><input id="p" type="password"><button id="go">Log in</button></form>`;
    for (const style of [
      "position:absolute;width:12px;height:12px;opacity:0",
      "width:1px;height:1px;padding:0;border:0",
    ]) {
      page(form(decoys(style)));
      expect(observe().complete, style).toBe(true);
      expect(
        summary(observe()).map((entry) => entry.target.value),
        style,
      ).toEqual(["u", "p", "go"]);
      // The page after a sign-in still reads such a field, which may be a code field
      // waiting for a timer: the disabled password pair still makes it incomplete.
      page(`<button id="logout">Sign out</button>${form(decoys(style))}`);
      const signedIn = extractSignedInObservation();
      expect(signedIn.ok && [signedIn.observation.complete, signedIn.gap], style).toEqual([
        false,
        "unfillable-field",
      ]);
    }
    // Faint alone, disabled alone, or faint and read-only, still cannot be filled.
    for (const extra of [
      `<input id="pin" style="opacity:0">`,
      `<input id="pin" type="password" disabled>`,
      `<input id="pin" style="opacity:0" readonly>`,
    ]) {
      page(form(extra));
      const result = extractLoginObservation();
      expect(result.ok && [result.observation.complete, result.gap], extra).toEqual([
        false,
        "unfillable-field",
      ]);
    }
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

  it("keeps a submit control the page holds inert until its fields are filled (#853)", () => {
    // An airline's login modal (2026-10-22): its script lifts `inert` once both fields
    // hold valid values.
    page(
      `<form id="f"><input id="member_no" autocomplete="username">
        <input id="member_password" type="password" autocomplete="current-password">
        <a href="javascript: void(0)" id="login" inert>ログイン</a></form>`,
    );
    const observation = observe();
    expect(observation.complete).toBe(true);
    expect(summary(observation).map((candidate) => [candidate.role, candidate.target])).toEqual([
      ["text", { by: "id", value: "member_no" }],
      ["password", { by: "id", value: "member_password" }],
      ["button", { by: "id", value: "login" }],
    ]);
    // An inert or hidden ancestor, or a control also hidden otherwise, still hides it.
    for (const html of [
      `<div inert><button id="go">Log in</button></div>`,
      `<div aria-hidden="true"><button id="go">Log in</button></div>`,
      `<button id="go" inert hidden>Log in</button>`,
      `<button id="go" inert aria-hidden="true">Log in</button>`,
      `<button id="go" inert style="display:none">Log in</button>`,
    ]) {
      page(`<form id="f"><input id="user" autocomplete="username">${html}</form>`);
      expect(
        summary(observe()).map((candidate) => candidate.target.value),
        html,
      ).toEqual(["user"]);
    }
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
      { role: "text", target: { by: "id", value: "swap" }, maxLength: 3 },
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
}
