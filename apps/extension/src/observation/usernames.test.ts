import type { LoginObservation } from "@pateat/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { extractLoginObservation, extractSignedInObservation } from "./extract";
import { withoutUsernames } from "./usernames";

// Synthetic usernames only.
const observation = (change: Partial<LoginObservation> = {}): LoginObservation => ({
  version: 1,
  origin: "https://login.example",
  path: "/signin",
  language: "en",
  complete: true,
  candidates: [
    { id: "c1", role: "password", target: { by: "id", value: "password" }, label: "Password" },
    { id: "c2", role: "button", target: { by: "text", value: "Log in" }, label: "Log in" },
  ],
  ...change,
});
const hidden = (value: LoginObservation, usernames: readonly string[]) => {
  const result = withoutUsernames(value, usernames);
  if (!result.ok) throw new Error(`refused: ${result.reason}`);
  return result.observation;
};
const headings = (texts: string[], usernames: readonly string[]) =>
  hidden(observation({ headings: texts }), usernames).headings;

describe("withoutUsernames", () => {
  afterEach(() => {
    document.title = "";
    document.body.innerHTML = "";
  });

  it("hides a username as a whole text or inside a longer one, ignoring case and width", () => {
    expect(
      headings(
        [
          "taro.yamada",
          "Welcome back, TARO.YAMADA",
          "Signed in as @Taro.Yamada.",
          "ようこそ ｔａｒｏ．ｙａｍａｄａ さん",
          "ようこそtaro.yamadaさん",
        ],
        ["Taro.Yamada"],
      ),
    ).toEqual([
      "[account]",
      "Welcome back, [account]",
      "Signed in as [account].",
      "ようこそ [account] さん",
      "ようこそ[account]さん",
    ]);
  });

  it("covers the title, headings, account texts and every candidate text", () => {
    const result = hidden(
      observation({
        title: "taro - Example",
        headings: ["Hello taro"],
        headerText: "Home Signed in as taro Settings",
        accounts: ["taro Last used"],
        candidates: [
          {
            id: "c1",
            role: "password",
            target: { by: "id", value: "password" },
            label: "Password for taro",
            placeholder: "taro's password",
            description: "Enter the password of taro",
          },
          {
            id: "c2",
            role: "button",
            target: { by: "id", value: "login" },
            label: "Log in as taro",
          },
        ],
      }),
      ["taro"],
    );
    expect(result).toEqual(
      observation({
        title: "[account] - Example",
        headings: ["Hello [account]"],
        headerText: "Home Signed in as [account] Settings",
        accounts: ["[account] Last used"],
        candidates: [
          {
            id: "c1",
            role: "password",
            target: { by: "id", value: "password" },
            label: "Password for [account]",
            placeholder: "[account]'s password",
            description: "Enter the password of [account]",
          },
          {
            id: "c2",
            role: "button",
            target: { by: "id", value: "login" },
            label: "Log in as [account]",
          },
        ],
      }),
    );
    expect(JSON.stringify(result).toLowerCase()).not.toContain("taro");
  });

  it("never finds a name inside a longer Latin word", () => {
    expect(
      headings(["Use another account", "Annual report", "Sign in with ann", "ANN"], ["ann"]),
    ).toEqual(["Use another account", "Annual report", "Sign in with [account]", "[account]"]);
    expect(headings(["taro1", "xtaro", "taro_x", "taro-x"], ["taro"])).toEqual([
      "taro1",
      "xtaro",
      "[account]_x",
      "[account]-x",
    ]);
  });

  it("looks for no username shorter than three characters", () => {
    expect(headings(["Sign in with an app", "an", "太郎さん"], ["an", "太郎", " ab "])).toEqual([
      "Sign in with an app",
      "an",
      "太郎さん",
    ]);
    const short = observation({
      path: "/an",
      candidates: [
        ...observation().candidates,
        { id: "c3", role: "button", target: { by: "text", value: "an" }, label: "an" },
      ],
    });
    expect(withoutUsernames(short, ["an"])).toEqual({ ok: true, observation: short });
    // The minimum counts after a leading `@`.
    expect(headings(["Hi ab", "Hi abc"], ["@ab"])).toEqual(["Hi ab", "Hi abc"]);
    expect(headings(["Hi ab", "Hi abc"], ["@abc"])).toEqual(["Hi ab", "Hi [account]"]);
  });

  it("hides the longest of overlapping usernames whole", () => {
    expect(headings(["taro.yamada and taro"], ["taro", "taro.yamada"])).toEqual([
      "[account] and [account]",
    ]);
  });

  it("finds a username in the form the page's own redaction left it in", () => {
    // A run of four or more digits is already `[number]` on a login page.
    expect(headings(["Welcome taro[number]"], ["taro1234"])).toEqual(["Welcome [account]"]);
    // A signed-in page shows every number as `[number]`.
    expect(headings(["Welcome taro[number]"], ["taro12"])).toEqual(["Welcome [account]"]);
    // An email username is already `[email]` and placeholders alone are not looked for, so
    // other addresses and numbers keep their own placeholders.
    expect(
      headings(["Signed in as [email]", "[number] points"], ["taro@example.com", "12345678"]),
    ).toEqual(["Signed in as [email]", "[number] points"]);
  });

  it("hides the start of a name at the end of a text cut at its length limit", () => {
    const cut = `${"x ".repeat(55)}Hi taro.ya`;
    expect(cut).toHaveLength(120);
    const [text] = headings([cut], ["taro.yamada"])!;
    expect(text!.startsWith(`${"x ".repeat(55)}Hi [acc`)).toBe(true);
    expect(text!.length).toBeLessThanOrEqual(120);
    expect(text).not.toContain("ta");
    // A shorter text was not cut, so its end is left as it is.
    expect(headings(["Hi taro.ya"], ["taro.yamada"])).toEqual(["Hi taro.ya"]);
  });

  it("hides a name cut at the end of a signed-in page's header text, at its own limit", () => {
    const header = (text: string) =>
      hidden(observation({ headerText: text }), ["taro.yamada"]).headerText;
    const cut = `${"x ".repeat(495)}Hi taro.ya`;
    expect(cut).toHaveLength(1000);
    const text = header(cut)!;
    expect(text.startsWith(`${"x ".repeat(495)}Hi [acc`)).toBe(true);
    expect(text.length).toBeLessThanOrEqual(1000);
    expect(text).not.toContain("ta");
    // The same end in a shorter header was not cut.
    expect(header(`${"x ".repeat(100)}Hi taro.ya`)).toBe(`${"x ".repeat(100)}Hi taro.ya`);
    const long = `${"a ".repeat(498)}taro.yamada`;
    expect(header(long)!.length).toBeLessThanOrEqual(1000);
  });

  it("keeps hidden texts within the observed-text limit", () => {
    const long = `${"a ".repeat(58)}abc`;
    expect(long).toHaveLength(119);
    const [text] = headings([long], ["abc"])!;
    expect(text!.length).toBeLessThanOrEqual(120);
    expect(text!.startsWith("a a ")).toBe(true);
  });

  it.each([
    ["a text locator", { by: "text", value: "Not Taro?" }],
    ["an id", { by: "id", value: "switch-taro" }],
    ["a name", { by: "name", value: "taro" }],
    ["a test ID", { by: "test-id", value: "TARO-menu" }],
  ] as const)("leaves out a control whose locator holds a username as %s", (_label, target) => {
    const result = hidden(
      observation({
        // The login form's own controls, and a button outside it.
        candidates: [
          ...observation().candidates.map((candidate) => ({ ...candidate, group: "f1" })),
          { id: "c3", role: "button", target, label: "Not you?" },
          { id: "c4", role: "link", target: { by: "id", value: "help" }, label: "Help for taro" },
        ],
      }),
      ["taro"],
    );
    expect(result.candidates.map((candidate) => candidate.id)).toEqual(["c1", "c2", "c4"]);
    expect(JSON.stringify(result).toLowerCase()).not.toContain("taro");
  });

  it("refuses a page whose field locator or path holds a username", () => {
    const field = observation({
      candidates: [
        { id: "c1", role: "email", target: { by: "name", value: "login-taro" } },
        ...observation().candidates.slice(1),
      ],
    });
    expect(withoutUsernames(field, ["taro"])).toEqual({ ok: false, reason: "username-shown" });
    expect(withoutUsernames(observation({ path: "/users/taro/login" }), ["taro"])).toEqual({
      ok: false,
      reason: "username-shown",
    });
    expect(
      withoutUsernames(observation({ path: "/u/%E5%B1%B1%E7%94%B0%E5%A4%AA%E9%83%8E" }), [
        "山田太郎",
      ]),
    ).toEqual({ ok: false, reason: "username-shown" });
    // Only a segment that holds the username as a word of its own counts.
    for (const path of ["/login", "/taroko/signin", "/signin"])
      expect(withoutUsernames(observation({ path }), ["taro"]).ok).toBe(true);
    // An `autocomplete` token is the page's field kind, never a username.
    expect(
      withoutUsernames(
        observation({
          candidates: [
            { id: "c1", role: "text", target: { by: "autocomplete", value: "username" } },
            ...observation().candidates.slice(1),
          ],
        }),
        ["username"],
      ).ok,
    ).toBe(true);
  });

  it("refuses a page whose dropped button or link may belong to a field's form", () => {
    const grouped = (role: "button" | "link", group?: string) =>
      observation({
        candidates: [
          {
            id: "c1",
            role: "password",
            target: { by: "id", value: "password" },
            ...(group ? { group } : {}),
          },
          {
            id: "c2",
            role,
            target: { by: "text", value: "Log in as taro" },
            ...(group ? { group } : {}),
          },
        ],
      });
    // A submit in the field's form, or a button beside a field outside every form.
    expect(withoutUsernames(grouped("button", "f1"), ["taro"]).ok).toBe(false);
    expect(withoutUsernames(grouped("link", "f1"), ["taro"]).ok).toBe(false);
    expect(withoutUsernames(grouped("button"), ["taro"]).ok).toBe(false);
    // A link outside every form is left out.
    const link = withoutUsernames(grouped("link"), ["taro"]);
    expect(link.ok && link.observation.candidates.map((candidate) => candidate.id)).toEqual(["c1"]);
  });

  it("refuses a page left with nothing to describe", () => {
    const only = observation({
      candidates: [{ id: "c1", role: "button", target: { by: "text", value: "Continue as taro" } }],
    });
    expect(withoutUsernames(only, ["taro"])).toEqual({ ok: false, reason: "username-shown" });
  });

  it("returns the observation unchanged without a username to hide", () => {
    const value = observation({ headings: ["Hello taro"] });
    expect(withoutUsernames(value, [])).toEqual({ ok: true, observation: value });
    expect(withoutUsernames(value, ["", "   "])).toEqual({ ok: true, observation: value });
    expect(withoutUsernames(value, ["hanako"])).toEqual({ ok: true, observation: value });
  });

  it("hides a username in a login page and a signed-in page as the extractor reads them", () => {
    document.title = "Sign in - taro2024";
    document.body.innerHTML = `
      <h1>Welcome back, taro2024</h1>
      <form>
        <label for="pw">Password for taro2024</label><input id="pw" type="password">
        <button>Log in</button>
      </form>`;
    const login = extractLoginObservation();
    if (!login.ok) throw new Error(login.reason);
    const shownLogin = hidden(login.observation, ["taro2024"]);
    expect(shownLogin.title).toBe("Sign in - [account]");
    expect(shownLogin.headings).toEqual(["Welcome back, [account]"]);
    expect(shownLogin.candidates[0]!.label).toBe("Password for [account]");

    document.title = "Home";
    document.body.innerHTML = `
      <header><h2>taro12 さん</h2><button id="menu">Menu of TARO12</button></header>
      <main><a href="/settings">Settings</a></main>`;
    const signedIn = extractSignedInObservation();
    if (!signedIn.ok) throw new Error(signedIn.reason);
    const shownSignedIn = hidden(signedIn.observation, ["taro12"]);
    expect(shownSignedIn.headings).toEqual(["[account] さん"]);
    expect(shownSignedIn.candidates.map((candidate) => candidate.label)).toEqual([
      "Menu of [account]",
      "Settings",
    ]);
  });
});
