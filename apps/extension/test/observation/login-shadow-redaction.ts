import { expect, it } from "vitest";
import { findTargets } from "../../src/page/targets";
import { extractLoginObservation, extractSignedInObservation } from "../../src/observation/extract";
import type { ObservationTestContext } from "./context";

export function registerLoginShadowRedaction({
  page,
  shadow,
  observe,
  summary,
}: Pick<ObservationTestContext, "page" | "shadow" | "observe" | "summary">) {
  it("describes the fields of open and closed shadow roots as the page's own (ADR 0070)", () => {
    // As Reddit's sign-in (2026-10-23): each input in its own component's shadow root,
    // outside any form, every root reusing one inner ID and labelling by it.
    const field = (name: string, type: string, tokens: string, label: string) =>
      `<span id="label">${label}</span>
      <input id="input" name="${name}" type="${type}" autocomplete="${tokens}" aria-labelledby="label">`;
    page(
      `<div><h1>Log In</h1><text-field id="user"></text-field><text-field id="pass"></text-field>
      <button id="login">Log In</button></div>`,
    );
    shadow("#user", field("username", "text", "username webauthn", "Email or username"));
    const closed = shadow(
      "#pass",
      field("password", "password", "current-password", "Password"),
      "closed",
    );
    const observation = observe();
    expect(observation.complete).toBe(true);
    expect(summary(observation)).toEqual([
      {
        role: "text",
        target: { by: "name", value: "username" },
        label: "Email or username",
        autocomplete: "username",
      },
      {
        role: "password",
        target: { by: "name", value: "password" },
        label: "Password",
        autocomplete: "current-password",
      },
      { role: "button", target: { by: "id", value: "login" }, label: "Log In" },
    ]);
    // The executor's lookup finds what the description names, and counts every root's ID.
    expect(findTargets(document, { by: "name", value: "password" })).toEqual([
      closed.querySelector("input"),
    ]);
    expect(findTargets(document, { by: "id", value: "input" })).toHaveLength(2);

    // A component's fields belong to the form that holds it, in the page's order: its
    // shadow tree right where the component sits.
    page(`<form id="f"><x-login id="host"></x-login><button id="go">Sign in</button></form>`);
    shadow(
      "#host",
      `<label>User ID <input id="uid"></label><label>Password <input id="pw" type="password"></label>`,
    );
    expect(summary(observe())).toEqual([
      { role: "text", target: { by: "id", value: "uid" }, label: "User ID", group: "f1" },
      { role: "password", target: { by: "id", value: "pw" }, label: "Password", group: "f1" },
      { role: "button", target: { by: "id", value: "go" }, label: "Sign in", group: "f1" },
    ]);

    // A button's text rendered by a component inside it names the button.
    page(
      `<input id="u"><input id="p" type="password"><button><x-label id="next"></x-label></button>`,
    );
    shadow("#next", `<span>Next</span>`);
    expect(summary(observe()).map(({ target }) => target)).toEqual([
      { by: "id", value: "u" },
      { by: "id", value: "p" },
      { by: "text", value: "Next" },
    ]);

    // A consent banner's check box in a shadow root outside every form changes nothing.
    page(`<form id="f"><input id="u"><button id="go">Go</button></form><div id="host"></div>`);
    shadow("#host", `<label>Analytics <input type="checkbox"></label>`);
    expect(observe().complete).toBe(true);
    // Without a form, the sign-in fields' area reaches up through their components' hosts:
    // a language picker far from it is not the sign-in's, one beside the fields is.
    const nested = (depth: number, html: string) =>
      "<div>".repeat(depth) + html + "</div>".repeat(depth);
    for (const [beside, complete] of [
      ["", true],
      [`<select id="near"><option>EN</option></select>`, false],
    ] as const) {
      page(
        nested(
          5,
          `<section><x-field id="host"></x-field><button id="go">Log In</button>${beside}</section>`,
        ) + nested(6, `<select id="lang"><option>EN</option></select>`),
      );
      shadow("#host", `<input name="username"><input name="password" type="password">`);
      expect(observe().complete, beside).toBe(complete);
    }
  });

  it("names a field inside its host by a name before a counter-shaped ID, as in the page (issue #1413)", () => {
    // Each component numbers its inner input; the hosts carry a counter ID and a name.
    page(
      `<div><text-field id="field-1" name="user"></text-field>
      <text-field id="field-2" name="pass"></text-field><button id="login">Log In</button></div>`,
    );
    shadow("#field-1", `<input id="input-1" data-test="input">`);
    shadow("#field-2", `<input id="input-1" data-test="input" type="password">`);
    expect(summary(observe()).map(({ target }) => target)).toEqual([
      { by: "data-test", value: "input", within: [{ by: "name", value: "user" }] },
      { by: "data-test", value: "input", within: [{ by: "name", value: "pass" }] },
      { by: "id", value: "login" },
    ]);
  });

  it("names a shadow tree's field inside its host when nothing names it in the whole page (ADR 0070)", () => {
    // Each component reuses its inner ID and has no name, token or label of its own.
    page(
      `<div><text-field id="user"></text-field><text-field id="pass"></text-field>
      <button id="login">Log In</button></div>`,
    );
    shadow("#user", `<input id="input">`);
    shadow("#pass", `<x-box><input id="input" type="password"></x-box>`, "closed");
    const observation = observe();
    expect(observation.complete).toBe(true);
    expect(summary(observation).map(({ target }) => target)).toEqual([
      { by: "id", value: "input", within: [{ by: "id", value: "user" }] },
      { by: "id", value: "input", within: [{ by: "id", value: "pass" }] },
      { by: "id", value: "login" },
    ]);
    // The executor finds each one alone.
    for (const { target } of observation.candidates)
      expect(findTargets(document, target), JSON.stringify(target)).toHaveLength(1);

    // A nested component without an ID of its own is looked inside through the nearest
    // host that has one, the hosts nearest the field first.
    page(
      `<login-box id="box"></login-box><login-box id="other"></login-box><button id="go">Go</button>`,
    );
    for (const id of ["box", "other"])
      shadow(`#${id}`, `<text-field></text-field>`)
        .querySelector("text-field")!
        .attachShadow({ mode: "open" }).innerHTML =
        id === "box" ? `<input id="input" type="password">` : `<input id="input">`;
    expect(summary(observe()).map(({ target }) => target)).toEqual([
      { by: "id", value: "input", within: [{ by: "id", value: "box" }] },
      { by: "id", value: "input", within: [{ by: "id", value: "other" }] },
      { by: "id", value: "go" },
    ]);

    // Hosts that share their ID name no field.
    page(
      `<text-field id="f"></text-field><text-field id="f"></text-field><button id="go">Go</button>`,
    );
    for (const host of document.querySelectorAll("text-field"))
      host.attachShadow({ mode: "open" }).innerHTML = `<input id="input" type="password">`;
    expect(extractLoginObservation()).toMatchObject({
      ok: true,
      observation: { complete: false },
      gap: "unlocated-field",
    });
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
}
