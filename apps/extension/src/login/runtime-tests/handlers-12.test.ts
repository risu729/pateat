import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseLoginRecipe, type DetailLink } from "@pateat/contracts";
import type { LoginGeneration } from "../runtime/deps";
import type { LoginReport } from "../runtime/report";
const fake = await vi.hoisted(async () => (await import("./browser-fake")).createBrowserFake());
vi.mock("wxt/browser", () => ({ browser: fake.browser }));
vi.stubEnv("MODE", "production");
const { createRuntimeTestHarness } = await import("./harness");
const { origin, itemId, snapshotId, target, recipe, userId, harness } =
  createRuntimeTestHarness(fake);

// A birth date or phone number is read only from an identity, the login item or a secure
// note; the popup shows each field's value, and a login fills the only field without a
// link (ADR 0061, owner 2026-11-21 10:12 UTC).
describe("a birth date or phone number from the person's own items (ADR 0061)", () => {
  afterEach(() => {
    vi.useRealTimers();
    for (const listener of fake.state.removed.splice(0))
      for (const tabId of [1, 2]) listener(tabId);
  });
  beforeEach(() => {
    fake.state.storage = {};
    fake.state.session = {};
    fake.state.badges = {};
    fake.state.reconnects = [];
    fake.state.onReconnect = undefined;
    fake.state.messages = [];
    fake.state.granted = true;
    fake.state.pageUrl = "https://login.example/signin";
    fake.state.onExecute = undefined;
    fake.state.tabUrls = {};
    fake.state.incognito = new Set();
    fake.state.observed = ["unique", "missing"];
    fake.state.observedPath = "/signin";
    fake.state.present = new Set(["password", "login"]);
    fake.state.unusable = new Set();
    fake.state.unobservable = new Set();
    fake.state.disabled = new Set();
    fake.state.awaited = { ok: true };
    fake.state.onAwait = undefined;
    fake.state.executeReply = undefined;
    fake.state.switchReply = { ok: true };
    fake.state.chosen = { ok: true, click: "entry" };
    fake.state.gone = new Set();
    fake.state.extracted = {};
    fake.state.signs = undefined;
    fake.state.cardHints = undefined;
    fake.state.question = undefined;
  });
  const status = () =>
    fake.state.storage["pateat.login-attempts.v5"] as Record<string, unknown>[] | undefined;
  const clicks = (value: string) =>
    fake.state.messages.filter((entry) => {
      const step = (
        entry as unknown as { operation?: { step: { kind: string; target?: { value: string } } } }
      ).operation?.step;
      return (
        entry.type === "login.execute" && step?.kind === "click" && step.target?.value === value
      );
    }).length;
  const onClick = (
    pages: Record<string, { path: string; present: string[]; extracted?: unknown }>,
  ) => {
    fake.state.onExecute = async (message) => {
      const step = (message["operation"] as { step: { kind: string; target?: { value: string } } })
        .step;
      if (step.kind !== "click" || !step.target) return;
      const next = pages[step.target.value];
      if (!next) return;
      fake.state.observedPath = next.path;
      fake.state.present = new Set(next.present);
      if (next.extracted) fake.state.extracted = { "signed-in": next.extracted };
    };
  };
  async function until(check: () => boolean, maxMs = 200_000) {
    for (let spent = 0; !check(); spent += 100) {
      if (spent > maxMs) throw new Error("Condition not reached in fake time");
      // eslint-disable-next-line no-await-in-loop
      await vi.advanceTimersByTimeAsync(100);
    }
  }
  const settled = (state: string, outcome?: string) => () =>
    status()?.[0]?.["state"] === state &&
    (outcome === undefined || status()?.[0]?.["outcome"] === outcome);
  const homePage = {
    ok: true,
    observation: {
      version: 1,
      origin,
      path: "/home",
      language: "en",
      complete: true,
      candidates: [{ id: "c1", role: "button", target: target("logout"), label: "Sign out" }],
    },
  };
  const toHome = { path: "/home", present: ["logout"], extracted: homePage };
  const identityId = "80000000-0000-4000-8000-000000000003";
  const siteId = "80000000-0000-4000-8000-000000000006";
  const birthField = `custom.${snapshotId}.0`;
  const identity = {
    id: identityId,
    builtin: [{ id: "identity.phone", label: "Phone number", kind: "text" as const }],
    custom: [{ name: "生年月日", kind: "text" as const }],
  };
  // Another site's login item, whose phone field may hold that site's own number.
  const otherSite = { id: siteId, custom: [{ name: "Phone", kind: "text" as const }] };
  const { completion: _unlearned, ...unlearned } = recipe;
  const handler = (detail: "birth-date" | "phone-last-4") => ({
    kind: "detail" as const,
    path: "/signin",
    fields: [
      detail === "birth-date"
        ? { detail, format: "yyyymm" as const, target: target("birth") }
        : { detail, target: target("birth") },
    ],
    target: target("confirm"),
  });
  const home = [{ target: target("logout") }];
  const birthRecipe = parseLoginRecipe({
    ...unlearned,
    completion: home,
    handlers: [handler("birth-date")],
  });
  const phoneRecipe = parseLoginRecipe({ ...birthRecipe, handlers: [handler("phone-last-4")] });
  const rejecting = parseLoginRecipe({ ...birthRecipe, rejection: target("rejected") });
  const toConfirm = { path: "/signin", present: ["birth", "confirm"] };
  const noPasskey = vi.fn(async () => ({ passkey: false, discoverable: false }));
  const birthLink: DetailLink = {
    origin,
    provider: "bitwarden",
    server: "cloud-us",
    userId,
    itemId,
    detail: "birth-date",
    source: { itemId: identityId, field: { custom: "生年月日" } },
  };
  const detailFills = () =>
    fake.state.messages.filter(
      (entry) =>
        entry.type === "login.execute" && entry.values?.some((value) => value.slot === "detail"),
    );
  const handlerReports = (report: ReturnType<typeof vi.fn<(report: LoginReport) => void>>) =>
    report.mock.calls.flatMap(([value]) =>
      value.type === "handler" ? [[value.handler, value.kind, value.outcome] as const] : [],
    );
  const reads = (h: ReturnType<typeof harness>) =>
    h.fields.mock.calls.map(([request]) => [request.account.itemId, request.fieldId]);
  function start(
    extraItems: NonNullable<NonNullable<Parameters<typeof harness>[1]>["extraItems"]>,
    chosen = birthRecipe,
    read: Record<string, string> = { [birthField]: "1990-04-01" },
  ) {
    const report = vi.fn<(report: LoginReport) => void>();
    const h = harness({ detailLinks: [] }, { passkeys: noPasskey, report, extraItems });
    h.fields.mockImplementation(async ({ fieldId }) => read[fieldId] ?? "synthetic-secret");
    h.recipes.recipe.mockResolvedValue(chosen);
    return { h, report };
  }
  const popup = {
    id: "synthetic-extension",
    url: "chrome-extension://synthetic-extension/popup.html",
  } as never;
  const ask = (h: ReturnType<typeof harness>) =>
    h.login.handle({ version: 1, type: "login.detail.get", tabId: 1 }, popup);

  it("fills the only field without a link, presses the button and saves the link once confirmed", async () => {
    onClick({ login: toConfirm, confirm: toHome });
    const { h, report } = start([identity]);
    expect(await h.hello()).toEqual({ ok: true });
    await vi.waitFor(() => expect(status()).toMatchObject([{ state: "authenticated" }]), {
      timeout: 6_000,
    });
    expect(detailFills()).toEqual([
      expect.objectContaining({
        values: [expect.objectContaining({ slot: "detail", value: "199004" })],
      }),
    ]);
    expect(clicks("confirm")).toBe(1);
    await vi.waitFor(() => expect(h.settings.settings.detailLinks).toEqual([birthLink]));
    expect(handlerReports(report)).toEqual([
      [0, "detail", "entered"],
      [0, "detail", "detail-saved"],
    ]);
  }, 10_000);

  it("completes on a signed-in page that keeps the handler's form hidden", async () => {
    // My Digital Connect (2026-11-21): the form posts to a new document on the same path,
    // signed in, which still holds the detail form's inputs and button, all hidden.
    // Without a signed-in marker, the page itself decides, as the recipe there has none.
    const judge = vi.fn<LoginGeneration["judge"]>(async (...args) => {
      args[4]?.();
      return { verdict: "signed-in" };
    });
    const report = vi.fn<(report: LoginReport) => void>();
    const h = harness(
      { detailLinks: [] },
      {
        passkeys: noPasskey,
        report,
        extraItems: [identity],
        generation: {
          available: vi.fn<LoginGeneration["available"]>(async () => "sent"),
          generate: vi.fn<LoginGeneration["generate"]>(async () => ({
            outcome: "skipped",
            reason: "sent",
          })),
          generateEntry: vi.fn<LoginGeneration["generateEntry"]>(),
          judge,
          slotFields: vi.fn<LoginGeneration["slotFields"]>(async () => undefined),
        },
      },
    );
    h.fields.mockImplementation(async ({ fieldId }) =>
      fieldId === birthField ? "1990-04-01" : "synthetic-secret",
    );
    h.recipes.recipe.mockResolvedValue(
      parseLoginRecipe({ ...unlearned, handlers: [handler("birth-date")] }),
    );
    onClick({ login: toConfirm });
    const onLogin = fake.state.onExecute!;
    fake.state.onExecute = async (message, tabId) => {
      const step = (message["operation"] as { step: { kind: string; target?: { value: string } } })
        .step;
      if (step.kind !== "click" || step.target?.value !== "confirm") return onLogin(message, tabId);
      fake.state.gone.add("synthetic-document");
      fake.state.present = new Set(["logout", "birth", "confirm"]);
      fake.state.unusable = new Set(["birth", "confirm"]);
      fake.state.extracted = {
        "signed-in": { ...homePage, observation: { ...homePage.observation, path: "/signin" } },
      };
      setTimeout(() => void h.hello({ documentId: "signed-in" }, false), 0);
      throw new Error("Could not establish connection. Receiving end does not exist.");
    };
    expect(await h.hello()).toEqual({ ok: true });
    await vi.waitFor(
      () =>
        expect(status()).toMatchObject([
          { state: "authenticated", document: { documentId: "signed-in" } },
        ]),
      { timeout: 6_000 },
    );
    await vi.waitFor(() => expect(h.settings.settings.detailLinks).toEqual([birthLink]));
    expect(handlerReports(report)).toEqual([
      [0, "detail", "entered"],
      [0, "detail", "detail-saved"],
    ]);
    expect(judge).toHaveBeenCalledTimes(1);
  }, 10_000);

  it.each([
    ["the sign-in page again with the form kept hidden", ["password", "login", "birth", "confirm"]],
    ["its inputs hidden beside its button", ["birth", "confirm"]],
  ])("never fills it unasked again once refused by %s", async (_label, present) => {
    vi.useFakeTimers();
    onClick({ login: toConfirm, confirm: toConfirm });
    const { h, report } = start([identity]);
    expect(await h.hello()).toEqual({ ok: true });
    await until(() => clicks("confirm") === 1);
    // The site refused the value and loads a new document on the same path: the sign-in
    // form again with the detail form only in its markup, or the detail form with its
    // inputs hidden. Either is the handler's page shown again (ADR 0061).
    fake.state.present = new Set(present);
    fake.state.unusable = new Set(present.includes("password") ? ["birth", "confirm"] : ["birth"]);
    await h.hello({ documentId: "again" }, false);
    await until(settled("watching", "challenge"), 5_000);
    expect(detailFills()).toHaveLength(1);
    expect(clicks("confirm")).toBe(1);
    expect(handlerReports(report)).toEqual([
      [0, "detail", "entered"],
      [0, "detail", "detail-forgotten"],
      [0, "detail", "shown-again"],
    ]);
    expect(h.settings.settings.detailLinks).toEqual([]);
    expect(fake.state.session["pateat.login-refused-proposals.v1"]).toHaveLength(1);
  });

  it("never fills it unasked again once the login is rejected", async () => {
    onClick({ login: toConfirm, confirm: { path: "/signin", present: ["rejected"] } });
    const { h, report } = start([identity], rejecting);
    expect(await h.hello()).toEqual({ ok: true });
    await vi.waitFor(() =>
      expect(status()).toMatchObject([{ state: "blocked", outcome: "credential-rejected" }]),
    );
    await vi.waitFor(() =>
      expect(fake.state.session["pateat.login-refused-proposals.v1"]).toHaveLength(1),
    );
    expect(handlerReports(report)).toEqual([
      [0, "detail", "entered"],
      [0, "detail", "detail-forgotten"],
    ]);
    expect(h.settings.settings.detailLinks).toEqual([]);
    expect(fake.state.session["pateat.login-pending-details.v1"]).toEqual([]);
  }, 10_000);

  it("never fills it unasked again once the person removed its link", async () => {
    onClick({ login: toConfirm, confirm: toHome });
    const { h } = start([identity]);
    expect(await h.hello()).toEqual({ ok: true });
    await vi.waitFor(() => expect(h.settings.settings.detailLinks).toEqual([birthLink]), {
      timeout: 6_000,
    });
    expect(
      await h.login.handle(
        { version: 1, type: "login.detail.remove", tabId: 1, detail: "birth-date" },
        popup,
      ),
    ).toEqual({ ok: true });
    expect(h.settings.settings.detailLinks).toEqual([]);
    expect(fake.state.session["pateat.login-refused-proposals.v1"]).toHaveLength(1);
  }, 10_000);

  it("fills the only field when the saved link names a field the device may no longer read", async () => {
    onClick({ login: toConfirm, confirm: toHome });
    const report = vi.fn<(report: LoginReport) => void>();
    const elsewhere = { ...birthLink, source: { itemId: siteId, field: { custom: "生年月日" } } };
    const h = harness(
      { detailLinks: [elsewhere] },
      {
        passkeys: noPasskey,
        report,
        extraItems: [identity, { id: siteId, custom: [{ name: "生年月日", kind: "text" }] }],
      },
    );
    h.fields.mockImplementation(async ({ fieldId }) =>
      fieldId === birthField ? "1990-04-01" : "synthetic-secret",
    );
    h.recipes.recipe.mockResolvedValue(birthRecipe);
    expect(await h.hello()).toEqual({ ok: true });
    await vi.waitFor(() => expect(status()).toMatchObject([{ state: "authenticated" }]), {
      timeout: 6_000,
    });
    expect(reads(h).at(-1)).toEqual([identityId, birthField]);
    // The link the login confirmed replaces the one it could not read.
    await vi.waitFor(() => expect(h.settings.settings.detailLinks).toEqual([birthLink]));
  }, 10_000);

  it("never fills it unasked again once the site refused it, and the popup still offers it", async () => {
    vi.useFakeTimers();
    onClick({ login: toConfirm, confirm: toConfirm });
    const { h, report } = start([identity]);
    expect(await h.hello()).toEqual({ ok: true });
    await until(() => clicks("confirm") === 1);
    // The site refused the value: it loads the page that asks for it again.
    await h.hello({ documentId: "again" }, false);
    await until(settled("watching", "challenge"), 5_000);
    expect(handlerReports(report)).toEqual([
      [0, "detail", "entered"],
      [0, "detail", "detail-forgotten"],
      [0, "detail", "shown-again"],
    ]);
    expect(h.settings.settings.detailLinks).toEqual([]);
    expect(fake.state.session["pateat.login-refused-proposals.v1"]).toHaveLength(1);
    // The person signs out and the page asks again: the field is offered, not filled.
    for (const listener of fake.state.removed.splice(0)) listener(1);
    await vi.advanceTimersByTimeAsync(1_000);
    fake.state.present = new Set(["password", "login"]);
    expect(await h.hello({ documentId: "later" })).toEqual({ ok: true });
    await until(() => handlerReports(report).length === 4, 10_000);
    expect(handlerReports(report).at(-1)).toEqual([0, "detail", "detail-unlinked"]);
    expect(detailFills()).toHaveLength(1);
    await until(() => fake.state.session["pateat.login-detail-offers.v1"] !== undefined);
    const offered = await ask(h);
    expect(offered).toMatchObject({
      offer: {
        details: [
          {
            detail: "birth-date",
            candidates: [{ itemId: identityId, fieldId: birthField, shown: "1990-04-01" }],
          },
        ],
      },
    });
  });

  it("never fills or lists another site's login item, and says where to save the number", async () => {
    onClick({ login: toConfirm, confirm: toHome });
    const { h, report } = start([otherSite], phoneRecipe, { [birthField]: "090-1234-5678" });
    expect(await h.hello()).toEqual({ ok: true });
    await vi.waitFor(() =>
      expect(status()).toMatchObject([{ state: "watching", outcome: "challenge" }]),
    );
    expect(detailFills()).toEqual([]);
    expect(handlerReports(report)).toEqual([[0, "detail", "detail-unlinked"]]);
    await vi.waitFor(async () =>
      expect(await ask(h)).toMatchObject({
        offer: { details: [{ detail: "phone-last-4", candidates: [] }] },
      }),
    );
    expect(reads(h)).toEqual([[itemId, "login.password"]]);
  }, 10_000);

  it("never reads an item with Bitwarden's re-prompt for the popup", async () => {
    onClick({ login: toConfirm, confirm: toHome });
    const note = {
      id: siteId,
      note: true as const,
      reprompt: true as const,
      custom: [{ name: "Birth date", kind: "text" as const }],
    };
    const { h } = start([identity, note]);
    expect(await h.hello()).toEqual({ ok: true });
    await vi.waitFor(() =>
      expect(status()).toMatchObject([{ state: "watching", outcome: "challenge" }]),
    );
    await vi.waitFor(async () =>
      expect(await ask(h)).toMatchObject({
        offer: {
          details: [
            {
              detail: "birth-date",
              candidates: [
                { itemId: identityId, shown: "1990-04-01" },
                { itemId: siteId, fieldLabel: "Birth date" },
              ],
            },
          ],
        },
      }),
    );
    // Read once for the popup, and not again on its next poll while nothing changes.
    const offered = (await ask(h)) as { offer: { details: [{ candidates: object[] }] } };
    expect(offered.offer.details[0].candidates[1]).not.toHaveProperty("shown");
    expect(reads(h)).toEqual([
      [itemId, "login.password"],
      [identityId, birthField],
    ]);
  }, 10_000);
});
