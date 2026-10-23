import type {
  LoginLogoutRecipe,
  LoginObservation,
  LoginTarget,
  LogoutPurpose,
} from "@pateat/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

const session = vi.hoisted(() => ({ values: {} as Record<string, unknown> }));
vi.mock("wxt/utils/storage", () => ({
  storage: {
    getItems: async (keys: string[]) =>
      keys.map((key) => ({ key, value: structuredClone(session.values[key]) })),
    setItems: async (items: { key: string; value: unknown }[]) => {
      for (const { key, value } of items) session.values[key] = structuredClone(value);
    },
  },
}));
const {
  createAccountPicks,
  runLogout,
  siteDefaultsMark,
  SESSION_PICKS_KEY,
  SWITCH_PICK_MS,
  SWITCH_PICKS_KEY,
} = await import("./switch");
type Driver = Parameters<typeof runLogout>[0];
type Service = Parameters<typeof runLogout>[1];

// ADR 0063: an account switch's logout, on a synthetic site's pages.

const origin = "https://shop.example.test";
const id = (value: string) => ({ by: "id" as const, value });
type Page = { document: { origin: string }; path: string; name: string };
const page = (name: string, path = "/home"): Page => ({ document: { origin }, path, name });
const observation = (path = "/home"): LoginObservation => ({
  version: 1,
  origin,
  path,
  language: "en",
  complete: true,
  candidates: [{ id: "c1", role: "button", target: id("account-menu") }],
});
const recipe = (
  targets: { value: string; purpose: LogoutPurpose; path?: string }[],
  revision = targets.length,
): LoginLogoutRecipe => ({
  version: 1,
  id: "gen-00000000000000000000000000000001",
  revision,
  origin,
  logout: {
    path: "/home",
    targets: targets.map(({ value, purpose, path = "/home" }) => ({
      kind: "click",
      path,
      target: id(value),
      purpose,
    })),
  },
});

/**
 * A tab whose page after each click is scripted by the clicked control: the next page and
 * whether it shows a sign-in input, or nothing when the tab left the site.
 */
function tab(after: Record<string, { page: Page; signIn: boolean } | undefined>) {
  let current: Page | undefined = page("home");
  const clicked: string[] = [];
  let last = "";
  const driver: Driver & { describe: ReturnType<typeof vi.fn> } = {
    page: () => current,
    describe: vi.fn(async (shown: Page) => ({ observation: observation(shown.path) })),
    click: vi.fn(async (_shown: Page, target: LoginTarget) => {
      clicked.push(target.value);
      last = target.value;
      return "clicked" as const;
    }),
    settle: vi.fn(async () => {
      const next = after[last];
      current = next?.page;
      return next;
    }),
  } as never;
  return { driver, clicked };
}
function service(
  stored: LoginLogoutRecipe[],
  answers: Awaited<ReturnType<Service["generate"]>>[] = [],
) {
  return {
    recipes: vi.fn(async () => stored),
    generate: vi.fn<Service["generate"]>(async () => {
      const answer = answers.shift();
      if (!answer) throw new Error("No synthetic answer queued");
      return answer;
    }),
  };
}

describe("an account switch's logout (ADR 0063)", () => {
  it("clicks a stored logout and ends once the sign-in page shows", async () => {
    const { driver, clicked } = tab({
      "sign-out": { page: page("signin", "/signin"), signIn: true },
    });
    const logout = service([recipe([{ value: "sign-out", purpose: "logout" }])]);
    expect(await runLogout(driver, logout)).toEqual({
      outcome: "signed-out",
      clicks: 1,
      recipe: { id: "gen-00000000000000000000000000000001", revision: 1 },
    });
    expect(clicked).toEqual(["sign-out"]);
    expect(logout.generate).not.toHaveBeenCalled();
    expect(driver.describe).not.toHaveBeenCalled();
  });

  it("opens the menu, then clicks the logout, from a stored recipe", async () => {
    const { driver, clicked } = tab({
      "account-menu": { page: page("menu"), signIn: false },
      "sign-out": { page: page("bye", "/bye"), signIn: false },
    });
    const logout = service([
      recipe([
        { value: "account-menu", purpose: "menu" },
        { value: "sign-out", purpose: "logout" },
      ]),
    ]);
    const purposes: [LogoutPurpose, boolean][] = [];
    expect(
      await runLogout(driver, logout, (purpose, learned) => purposes.push([purpose, learned])),
    ).toMatchObject({ outcome: "signed-out", clicks: 2 });
    expect(clicked).toEqual(["account-menu", "sign-out"]);
    // A stored recipe that ran to its end on its logout signed out.
    expect(logout.generate).not.toHaveBeenCalled();
    expect(purposes).toEqual([
      ["menu", false],
      ["logout", false],
    ]);
  });

  it("learns the menu, the logout and its confirmation, one question per page", async () => {
    const { driver, clicked } = tab({
      "account-menu": { page: page("menu"), signIn: false },
      "sign-out": { page: page("confirm", "/logout"), signIn: false },
      yes: { page: page("signin", "/signin"), signIn: true },
    });
    const menu = recipe([{ value: "account-menu", purpose: "menu" }]);
    const logoutOnly = recipe([
      { value: "account-menu", purpose: "menu" },
      { value: "sign-out", purpose: "logout" },
    ]);
    const confirmed = recipe([
      { value: "account-menu", purpose: "menu" },
      { value: "sign-out", purpose: "logout" },
      { value: "yes", purpose: "confirm", path: "/logout" },
    ]);
    const logout = service(
      [],
      [
        { outcome: "recipe", recipe: menu },
        { outcome: "recipe", recipe: logoutOnly },
        { outcome: "recipe", recipe: confirmed },
      ],
    );
    expect(await runLogout(driver, logout)).toEqual({
      outcome: "signed-out",
      clicks: 3,
      recipe: { id: confirmed.id, revision: 3 },
      learned: true,
    });
    expect(clicked).toEqual(["account-menu", "sign-out", "yes"]);
    expect(logout.generate.mock.calls.map(([request]) => request.base)).toEqual([
      undefined,
      { recipeId: menu.id, revision: 1 },
      { recipeId: menu.id, revision: 2 },
    ]);
    expect(logout.generate.mock.calls[2]![0].observation.path).toBe("/logout");
  });

  it("checks a logout it learned once more, which may answer signed-out", async () => {
    const { driver } = tab({ "sign-out": { page: page("bye", "/bye"), signIn: false } });
    const logout = service(
      [],
      [
        { outcome: "recipe", recipe: recipe([{ value: "sign-out", purpose: "logout" }]) },
        { outcome: "signed-out" },
      ],
    );
    expect(await runLogout(driver, logout)).toMatchObject({ outcome: "signed-out", clicks: 1 });
    expect(logout.generate).toHaveBeenCalledTimes(2);
  });

  it("fails after three clicks when the site still shows the account", async () => {
    const { driver, clicked } = tab({
      "account-menu": { page: page("menu"), signIn: false },
      more: { page: page("more"), signIn: false },
      again: { page: page("again"), signIn: false },
    });
    const logout = service(
      [],
      [
        { outcome: "recipe", recipe: recipe([{ value: "account-menu", purpose: "menu" }]) },
        {
          outcome: "recipe",
          recipe: recipe([
            { value: "account-menu", purpose: "menu" },
            { value: "more", purpose: "menu" },
          ]),
        },
        {
          outcome: "recipe",
          recipe: recipe([
            { value: "account-menu", purpose: "menu" },
            { value: "more", purpose: "menu" },
            { value: "again", purpose: "menu" },
          ]),
        },
      ],
    );
    expect(await runLogout(driver, logout)).toMatchObject({
      outcome: "failed",
      reason: "still-signed-in",
      clicks: 3,
    });
    expect(clicked).toHaveLength(3);
  });

  it("fails without a click when no control logs out, and ends at once on a signed-out page", async () => {
    const none = tab({});
    expect(
      await runLogout(
        none.driver,
        service([], [{ outcome: "abstained", reason: "no-logout-control" }]),
      ),
    ).toEqual({
      outcome: "failed",
      reason: "no-logout-control",
      detail: "no-logout-control",
      clicks: 0,
    });
    expect(none.clicked).toEqual([]);
    const out = tab({});
    expect(await runLogout(out.driver, service([], [{ outcome: "signed-out" }]))).toEqual({
      outcome: "signed-out",
      clicks: 0,
    });
  });

  it.each<[string, Partial<Driver>, Awaited<ReturnType<Service["generate"]>>[], object]>([
    [
      "a page it cannot describe",
      { describe: async () => ({ unsent: "too-many-fields" }) },
      [],
      { reason: "page-unreadable", detail: "too-many-fields" },
    ],
    [
      "a service that cannot answer",
      {},
      [{ outcome: "unavailable", reason: "daily-limit" }],
      { reason: "service-unavailable", detail: "daily-limit" },
    ],
    [
      "a control that is gone",
      { click: async () => "missing" },
      [{ outcome: "recipe", recipe: recipe([{ value: "sign-out", purpose: "logout" }]) }],
      { reason: "target-missing", detail: "missing", clicks: 0 },
    ],
    ["a closed tab", { page: () => undefined }, [], { reason: "left-site", clicks: 0 }],
  ])("fails on %s", async (_name, overrides, answers, failure) => {
    const { driver } = tab({});
    expect(await runLogout({ ...driver, ...overrides }, service([], answers))).toMatchObject({
      outcome: "failed",
      ...failure,
    });
  });

  it("counts a tab that left the site after a logout as signed out, but not after a menu", async () => {
    const logout = tab({ "sign-out": undefined });
    expect(
      await runLogout(logout.driver, service([recipe([{ value: "sign-out", purpose: "logout" }])])),
    ).toMatchObject({ outcome: "signed-out", clicks: 1 });
    const menu = tab({ "account-menu": undefined });
    expect(
      await runLogout(menu.driver, service([recipe([{ value: "account-menu", purpose: "menu" }])])),
    ).toMatchObject({ outcome: "failed", reason: "left-site", clicks: 1 });
  });

  it("refuses a stored click on another page than the one it was learned on", async () => {
    const { driver, clicked } = tab({
      "account-menu": { page: page("account", "/account"), signIn: false },
    });
    const logout = service([
      recipe([
        { value: "account-menu", purpose: "menu" },
        { value: "sign-out", purpose: "logout" },
      ]),
    ]);
    expect(await runLogout(driver, logout)).toMatchObject({
      outcome: "failed",
      reason: "page-changed",
      clicks: 1,
    });
    expect(clicked).toEqual(["account-menu"]);
  });
});

describe("account picks for a switch and the browser session (ADR 0063)", () => {
  beforeEach(() => {
    session.values = {};
  });
  const item = { connectionId: "connection-1", itemId: "item-2" };
  const siteOf = (value: string) => new URL(value).hostname.split(".").slice(-3).join(".");

  it("keeps a switch's pick for its tab, site and window kind for two minutes", async () => {
    let now = 1_000_000;
    const picks = createAccountPicks(() => now);
    await picks.startSwitch({
      tabId: 1,
      site: "shop.example.test",
      incognito: false,
      makeDefault: false,
      ...item,
    });
    expect(session.values[SWITCH_PICKS_KEY]).toEqual([
      expect.objectContaining({ tabId: 1, until: now + SWITCH_PICK_MS }),
    ]);
    expect(await picks.switchFor(1, "shop.example.test", false)).toMatchObject(item);
    expect(await picks.switchFor(1, "other.example.test", false)).toBeUndefined();
    expect(await picks.switchFor(1, "shop.example.test", true)).toBeUndefined();
    expect(await picks.switchFor(2, "shop.example.test", false)).toBeUndefined();
    // A worker restarted in the same session still has it.
    expect(
      await createAccountPicks(() => now).switchFor(1, "shop.example.test", false),
    ).toMatchObject(item);
    now += SWITCH_PICK_MS;
    expect(await picks.switchFor(1, "shop.example.test", false)).toBeUndefined();
    await vi.waitFor(() => expect(session.values[SWITCH_PICKS_KEY]).toEqual([]));
  });

  it("ends a switch's pick once taken", async () => {
    const picks = createAccountPicks();
    await picks.startSwitch({
      tabId: 1,
      site: "shop.example.test",
      incognito: false,
      makeDefault: true,
      ...item,
    });
    await picks.endSwitch(1);
    expect(await picks.switchFor(1, "shop.example.test", false)).toBeUndefined();
    expect(session.values[SWITCH_PICKS_KEY]).toEqual([]);
  });

  it("keeps the session's pick per site and window kind, while the site's defaults stay", async () => {
    const defaults = [
      { origin: "https://shop.example.test", provider: "bitwarden", userId: "u", itemId: "item-1" },
    ];
    const mark = siteDefaultsMark(defaults, "shop.example.test", siteOf);
    const picks = createAccountPicks();
    await picks.keepSession({
      site: "shop.example.test",
      incognito: false,
      defaults: mark,
      ...item,
    });
    expect(await picks.sessionFor("shop.example.test", false, mark)).toEqual(item);
    expect(await picks.sessionFor("shop.example.test", true, mark)).toBeUndefined();
    expect(await picks.sessionFor("other.example.test", false, mark)).toBeUndefined();
    // A pick for the same site replaces the earlier one.
    await picks.keepSession({
      site: "shop.example.test",
      incognito: false,
      defaults: mark,
      connectionId: "connection-1",
      itemId: "item-3",
    });
    expect(session.values[SESSION_PICKS_KEY]).toEqual([
      expect.objectContaining({ itemId: "item-3" }),
    ]);
    // A default saved since for an origin of the site ends it.
    const changed = siteDefaultsMark(
      [
        ...defaults,
        {
          origin: "https://www.shop.example.test",
          provider: "bitwarden",
          userId: "u",
          itemId: "item-2",
        },
      ],
      "shop.example.test",
      siteOf,
    );
    expect(changed).not.toBe(mark);
    // Another site's default does not.
    expect(
      siteDefaultsMark(
        [
          ...defaults,
          { origin: "https://other.example.test", provider: "bitwarden", userId: "u", itemId: "x" },
        ],
        "shop.example.test",
        siteOf,
      ),
    ).toBe(mark);
    expect(await picks.sessionFor("shop.example.test", false, changed)).toBeUndefined();
    await vi.waitFor(() => expect(session.values[SESSION_PICKS_KEY]).toEqual([]));
  });

  it("drops the site's session pick when one is made the default", async () => {
    const picks = createAccountPicks();
    await picks.keepSession({
      site: "shop.example.test",
      incognito: true,
      defaults: "[]",
      ...item,
    });
    await picks.keepSession({
      site: "shop.example.test",
      incognito: false,
      defaults: "[]",
      ...item,
    });
    await picks.dropSession("shop.example.test", true);
    expect(session.values[SESSION_PICKS_KEY]).toEqual([
      expect.objectContaining({ incognito: false }),
    ]);
  });

  it("holds no pick when session storage cannot be read or holds another shape", async () => {
    session.values[SESSION_PICKS_KEY] = [{ site: "shop.example.test" }];
    session.values[SWITCH_PICKS_KEY] = "broken";
    const picks = createAccountPicks();
    expect(await picks.sessionFor("shop.example.test", false, "[]")).toBeUndefined();
    expect(await picks.switchFor(1, "shop.example.test", false)).toBeUndefined();
  });
});
