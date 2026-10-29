import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { parseLoginRecipe, type DetailLink, type LocalSettings } from "@pateat/contracts";
import type { LoginGeneration } from "../runtime/deps";
import type { LoginReport } from "../runtime/report";
const fake = await vi.hoisted(async () => (await import("./browser-fake")).createBrowserFake());
vi.mock("wxt/browser", () => ({ browser: fake.browser }));
vi.stubEnv("MODE", "production");
const { createRuntimeTestHarness } = await import("./harness");
const {
  origin,
  connectionId,
  itemId,
  snapshotId,
  sender,
  target,
  recipe,
  userId,
  otherItemId,
  liveItemPolicy,
  excludingLive,
  liveDefault,
  harness,
} = createRuntimeTestHarness(fake);

describe("second-factor page handlers chosen per account (ADR 0027)", () => {
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
  const securityKey = { by: "text" as const, value: "Use security key" };
  const keyHandler = { kind: "passkey" as const, path: "/login/webauthn", target: securityKey };
  const { completion: _unlearned, ...unlearned } = recipe;
  void parseLoginRecipe(unlearned);
  const home = [{ target: target("logout") }];
  void parseLoginRecipe({ ...unlearned, completion: home, handlers: [keyHandler] });
  void parseLoginRecipe({ ...unlearned, revision: 2, handlers: [keyHandler] });
  void vi.fn(async () => ({ passkey: true, discoverable: false }));
  const observation = (path: string, candidates: unknown[]) => ({
    ok: true,
    observation: { version: 1, origin, path, language: "en", complete: true, candidates },
  });
  void observation("/login/webauthn", [
    { id: "c1", role: "button", target: securityKey, label: "Use security key" },
  ]);
  const homePage = observation("/home", [
    { id: "c1", role: "button", target: target("logout"), label: "Sign out" },
  ]);
  const status = () =>
    fake.state.storage["pateat.login-attempts.v5"] as Record<string, unknown>[] | undefined;
  const executed = () =>
    fake.state.messages
      .filter((entry) => entry.type === "login.execute")
      .map(
        (entry) =>
          (
            entry as unknown as {
              operation: { step: { kind: string; target?: { value: string } } };
            }
          ).operation.step,
      );
  const clicks = (value: string) =>
    executed().filter((step) => step.kind === "click" && step.target?.value === value).length;
  const onClick = (
    pages: Record<string, { path: string; present: string[]; extracted?: unknown } | "hang">,
  ) => {
    fake.state.onExecute = async (message) => {
      const step = (message["operation"] as { step: { kind: string; target?: { value: string } } })
        .step;
      if (step.kind !== "click" || !step.target) return;
      const next = pages[step.target.value];
      if (next === "hang") return new Promise<void>(() => undefined);
      if (!next) return;
      fake.state.observedPath = next.path;
      fake.state.present = new Set(next.present);
      if (next.extracted) fake.state.extracted = { "signed-in": next.extracted };
    };
  };

  const toHome = { path: "/home", present: ["logout"], extracted: homePage };
  function generation(judge: LoginGeneration["judge"] = async () => ({ verdict: "unclear" })) {
    return {
      available: vi.fn<LoginGeneration["available"]>(async () => "sent"),
      generate: vi.fn<LoginGeneration["generate"]>(async () => ({
        outcome: "skipped",
        reason: "sent",
      })),
      // Like the service, it says just before the request leaves the device.
      generateEntry: vi.fn<LoginGeneration["generateEntry"]>(),
      judge: vi.fn<LoginGeneration["judge"]>(async (...args) => {
        args[4]?.();
        return judge(...args);
      }),
      slotFields: vi.fn<LoginGeneration["slotFields"]>(async () => undefined),
    };
  }
  const editFields = (
    h: ReturnType<typeof harness>,
    edit: (fields: Record<string, unknown>[]) => Record<string, unknown>[],
  ) => {
    const original = h.store.handle.getMockImplementation()!;
    h.store.handle.mockImplementation(async () => {
      const response = await original();
      if (response.ok) {
        const item = response.catalog.connections[0]!.items[0]!;
        item.fields = edit(item.fields as never) as never;
      }
      return response;
    });
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
  describe("personal details from linked vault items (ADR 0061)", () => {
    const identityId = "80000000-0000-4000-8000-000000000003";
    const cardId = "80000000-0000-4000-8000-000000000004";
    const birthField = `custom.${snapshotId}.0`;
    const phoneField = `custom.${snapshotId}.1`;
    const extraItems = [
      {
        id: identityId,
        builtin: [{ id: "identity.phone", label: "Phone number", kind: "text" as const }],
        custom: [
          { name: "生年月日", kind: "text" as const },
          { name: "Phone", kind: "text" as const },
        ],
      },
      {
        id: cardId,
        builtin: [
          { id: "card.number", label: "Card number", kind: "hidden" as const },
          { id: "card.code", label: "Security code", kind: "hidden" as const },
        ],
        custom: [],
      },
    ];
    const detailHandler = {
      kind: "detail" as const,
      path: "/signin",
      fields: [
        { detail: "birth-date" as const, format: "yyyymm" as const, target: target("birth") },
        { detail: "phone-last-4" as const, target: target("phone") },
      ],
      target: target("confirm"),
    };
    const detailed = parseLoginRecipe({
      ...unlearned,
      completion: home,
      handlers: [detailHandler],
    });
    const rejecting = parseLoginRecipe({ ...detailed, rejection: target("rejected") });
    const toConfirm = { path: "/signin", present: ["birth", "phone", "confirm"] };
    const toRejected = { path: "/signin", present: ["rejected"] };
    const noPasskey = vi.fn(async () => ({ passkey: false, discoverable: false }));
    const linkTo = (detail: DetailLink["detail"], source: DetailLink["source"]): DetailLink => ({
      origin,
      provider: "bitwarden",
      server: "cloud-us",
      userId,
      itemId,
      detail,
      source,
    });
    const birthLink = linkTo("birth-date", { itemId: identityId, field: { custom: "生年月日" } });
    const phoneLink = linkTo("phone-last-4", { itemId: identityId, field: "identity.phone" });
    const values = (h: ReturnType<typeof harness>, read: Record<string, string>) =>
      h.fields.mockImplementation(async ({ fieldId }) => read[fieldId] ?? "synthetic-secret");
    const birthValue = { [birthField]: "1990-04-01" };
    const detailFills = () =>
      fake.state.messages.filter(
        (entry) =>
          entry.type === "login.execute" && entry.values?.some((value) => value.slot === "detail"),
      );
    const handlerReports = (report: ReturnType<typeof vi.fn<(report: LoginReport) => void>>) =>
      report.mock.calls.flatMap(([value]) =>
        value.type === "handler" ? [[value.handler, value.kind, value.outcome, value.steps]] : [],
      );
    const reads = (h: ReturnType<typeof harness>) =>
      h.fields.mock.calls.map(([request]) => [request.account.itemId, request.fieldId]);
    const savedLinks = (h: ReturnType<typeof harness>) => h.settings.settings.detailLinks;
    const refusedKey = "pateat.login-refused-details.v1";
    const { source: _source, ...birthRefusal } = birthLink;
    function start(
      links: DetailLink[],
      read: Record<string, string> = birthValue,
      chosen = detailed,
      overrides: Partial<LocalSettings> = {},
      live: Parameters<typeof harness>[1] = {},
    ) {
      const report = vi.fn<(report: LoginReport) => void>();
      const h = harness(
        { detailLinks: links, ...overrides },
        { passkeys: noPasskey, report, extraItems, ...live },
      );
      values(h, read);
      h.recipes.recipe.mockResolvedValue(chosen);
      return { h, report };
    }
    describe("a saved link", () => {
      it.each([
        ["an excluded item", { itemPolicies: [liveItemPolicy(identityId, { excluded: true })] }],
        [
          "an excluded field",
          excludingLive([{ custom: "生年月日", position: 1, count: 1 }], identityId),
        ],
      ])(
        "is not used when it names %s",
        async (_label, overrides) => {
          onClick({ login: toConfirm, confirm: toHome });
          const { h, report } = start([birthLink], birthValue, detailed, overrides);
          expect(await h.hello()).toEqual({ ok: true });
          await vi.waitFor(() =>
            expect(status()).toMatchObject([{ state: "watching", outcome: "challenge" }]),
          );
          expect(detailFills()).toEqual([]);
          expect(reads(h)).toEqual([[itemId, "login.password"]]);
          expect(handlerReports(report)).toEqual([[0, "detail", "detail-unlinked", 2]]);
        },
        10_000,
      );
      it("is not used for another login item of the site", async () => {
        onClick({ login: toConfirm, confirm: toHome });
        const { h, report } = start([{ ...birthLink, itemId: otherItemId }]);
        expect(await h.hello()).toEqual({ ok: true });
        await vi.waitFor(() =>
          expect(status()).toMatchObject([{ state: "watching", outcome: "challenge" }]),
        );
        expect(detailFills()).toEqual([]);
        expect(handlerReports(report)).toEqual([[0, "detail", "detail-unlinked", 2]]);
      }, 10_000);
      it("waits for a totp handler shown with it, which goes first", async () => {
        const codeHandler = {
          kind: "totp" as const,
          path: "/signin",
          field: target("app-code"),
          target: target("verify"),
        };
        // The recipe lists the detail first; the code still goes first.
        const both = parseLoginRecipe({ ...detailed, handlers: [detailHandler, codeHandler] });
        onClick({
          login: { path: "/signin", present: [...toConfirm.present, "app-code", "verify"] },
          verify: toHome,
          confirm: toHome,
        });
        const { h, report } = start(
          [birthLink],
          { ...birthValue, "login.totp-code": "012345" },
          both,
        );
        editFields(h, (fields) => [
          ...fields,
          { id: "login.totp-code", label: "Verification code", name: null, kind: "otp" },
        ]);
        expect(await h.hello()).toEqual({ ok: true });
        await vi.waitFor(() => expect(status()).toMatchObject([{ state: "authenticated" }]), {
          timeout: 6_000,
        });
        expect(handlerReports(report)).toEqual([[1, "totp", "entered", 2]]);
        expect(clicks("verify")).toBe(1);
        expect(clicks("confirm")).toBe(0);
        expect(detailFills()).toEqual([]);
        expect(reads(h).map(([, fieldId]) => fieldId)).not.toContain(birthField);
      }, 10_000);
    });
    describe("no usable link", () => {
      const offersKey = "pateat.login-detail-offers.v1";
      it("stops at the handler and keeps it for the popup, reading no detail", async () => {
        onClick({ login: toConfirm, confirm: toHome });
        const { h, report } = start([]);
        expect(await h.hello()).toEqual({ ok: true });
        await vi.waitFor(() =>
          expect(status()).toMatchObject([{ state: "watching", outcome: "challenge" }]),
        );
        expect(detailFills()).toEqual([]);
        expect(clicks("confirm")).toBe(0);
        expect(reads(h)).toEqual([[itemId, "login.password"]]);
        expect(handlerReports(report)).toEqual([[0, "detail", "detail-unlinked", 2]]);
        // The offer names the login's document, its login item and the handler's inputs,
        // never a value or an item name.
        await vi.waitFor(() =>
          expect(fake.state.session[offersKey]).toEqual([
            {
              document: expect.objectContaining({ tabId: 1, documentId: "synthetic-document" }),
              path: "/signin",
              attemptId: status()![0]!["id"],
              handler: 0,
              account: { connectionId, itemId, origin },
              fields: detailHandler.fields,
              target: target("confirm"),
            },
          ]),
        );
        expect(JSON.stringify(fake.state.session)).not.toContain("Extra synthetic item");
        expect(h.store.update).not.toHaveBeenCalled();
      }, 10_000);
      it("stops for the popup when the only linked input is not writable", async () => {
        onClick({ login: toConfirm, confirm: toHome });
        // The birth input is linked but disabled; the phone input is not linked.
        fake.state.unusable = new Set(["birth"]);
        const { h, report } = start([birthLink]);
        expect(await h.hello()).toEqual({ ok: true });
        await vi.waitFor(() =>
          expect(status()).toMatchObject([{ state: "watching", outcome: "challenge" }]),
        );
        expect(detailFills()).toEqual([]);
        expect(clicks("confirm")).toBe(0);
        expect(reads(h)).toEqual([[itemId, "login.password"]]);
        expect(handlerReports(report)).toEqual([[0, "detail", "detail-unlinked", 2]]);
        await vi.waitFor(() =>
          expect(fake.state.session[offersKey]).toEqual([
            expect.objectContaining({ handler: 0, fields: detailHandler.fields }),
          ]),
        );
        // The saved link stays the owner's.
        expect(savedLinks(h)).toEqual([birthLink]);
      }, 10_000);
    });
    describe("a refused value", () => {
      it("removes the filled link when the login is rejected, keeping the others", async () => {
        onClick({ login: toConfirm, confirm: toRejected });
        const { h, report } = start([birthLink, phoneLink], birthValue, rejecting);
        expect(await h.hello()).toEqual({ ok: true });
        await vi.waitFor(() =>
          expect(status()).toMatchObject([{ state: "blocked", outcome: "credential-rejected" }]),
        );
        await vi.waitFor(() => expect(savedLinks(h)).toEqual([phoneLink]));
        expect(handlerReports(report)).toEqual([
          [0, "detail", "entered", 2],
          [0, "detail", "detail-forgotten", 2],
        ]);
        expect(fake.state.session[refusedKey]).toEqual([]);
      }, 10_000);
      it("removes the filled link when the handler's page shows again", async () => {
        vi.useFakeTimers();
        onClick({ login: toConfirm, confirm: toConfirm });
        const { h, report } = start([birthLink, phoneLink]);
        expect(await h.hello()).toEqual({ ok: true });
        await until(() => clicks("confirm") === 1);
        // The site refused the value: it loads the page that asks for it again.
        await h.hello({ documentId: "again" }, false);
        await until(settled("watching", "challenge"), 5_000);
        expect(detailFills()).toHaveLength(1);
        expect(clicks("confirm")).toBe(1);
        expect(savedLinks(h)).toEqual([phoneLink]);
        expect(handlerReports(report)).toEqual([
          [0, "detail", "entered", 2],
          [0, "detail", "detail-forgotten", 2],
          [0, "detail", "shown-again", 2],
        ]);
      });
      it("keeps the link refused while another tab's login is in progress, and removes it once that login ends", async () => {
        const second = "https://second.example";
        onClick({ login: toConfirm, confirm: toRejected });
        const report = vi.fn<(report: LoginReport) => void>();
        const h = harness(
          {
            detailLinks: [birthLink],
            siteDefaults: [liveDefault(), liveDefault({ origin: second })],
          },
          { passkeys: noPasskey, report, extraItems, allowedOrigins: [origin, second] },
        );
        values(h, birthValue);
        h.recipes.recipe.mockImplementation(async (at: string) =>
          at === origin ? rejecting : at === second ? { ...recipe, origin: second } : undefined,
        );
        // The other tab's login stays on its first step until it is released.
        fake.state.tabUrls[2] = `${second}/signin`;
        const { promise: released, resolve: release } = Promise.withResolvers<void>();
        let held = false;
        const clicked = fake.state.onExecute;
        fake.state.onExecute = async (message, tabId) => {
          if (tabId === 2) {
            held = true;
            await released;
            return;
          }
          await clicked?.(message, tabId);
        };
        expect(await h.hello({ tab: { id: 2 }, url: `${second}/signin` })).toEqual({ ok: true });
        await vi.waitFor(() => expect(held).toBe(true));
        expect(await h.hello()).toEqual({ ok: true });
        await vi.waitFor(() =>
          expect(handlerReports(report)).toEqual([
            [0, "detail", "entered", 2],
            [0, "detail", "detail-kept", 2],
          ]),
        );
        expect(status()).toContainEqual(
          expect.objectContaining({ state: "blocked", outcome: "credential-rejected" }),
        );
        expect(savedLinks(h)).toEqual([birthLink]);
        expect(h.store.update).not.toHaveBeenCalled();
        // No login uses the link meanwhile.
        expect(fake.state.session[refusedKey]).toEqual([birthRefusal]);
        // The other tab's login ends, refused by its page.
        fake.state.executeReply = {
          ok: false,
          reason: "structural-mismatch",
          detail: "target-missing",
        };
        release();
        await vi.waitFor(() => expect(savedLinks(h)).toEqual([]));
        await vi.waitFor(() => expect(fake.state.session[refusedKey]).toEqual([]));
      }, 10_000);
      it("is not used by the next login while it could not be removed", async () => {
        vi.useFakeTimers();
        onClick({ login: toConfirm, confirm: toConfirm });
        const { h, report } = start([birthLink]);
        // The settings refuse the removal.
        h.store.update.mockRejectedValue(new Error("synthetic storage failure"));
        expect(await h.hello()).toEqual({ ok: true });
        await until(() => clicks("confirm") === 1);
        await h.hello({ documentId: "again" }, false);
        await until(settled("watching", "challenge"), 5_000);
        expect(handlerReports(report)).toEqual([
          [0, "detail", "entered", 2],
          [0, "detail", "detail-kept", 2],
          [0, "detail", "shown-again", 2],
        ]);
        expect(savedLinks(h)).toEqual([birthLink]);
        expect(fake.state.session[refusedKey]).toEqual([birthRefusal]);
        // The person signs out and the page asks again: the link is not used.
        for (const listener of fake.state.removed.splice(0)) listener(1);
        await vi.advanceTimersByTimeAsync(1_000);
        fake.state.present = new Set(["password", "login"]);
        expect(await h.hello({ documentId: "later" })).toEqual({ ok: true });
        await until(() => handlerReports(report).length === 4, 10_000);
        expect(handlerReports(report).at(-1)).toEqual([0, "detail", "detail-unlinked", 2]);
        expect(detailFills()).toHaveLength(1);
      });
    });
    describe("the popup's proposal", () => {
      const popup = {
        id: "synthetic-extension",
        url: "chrome-extension://synthetic-extension/popup.html",
      } as never;
      const ask = (h: ReturnType<typeof harness>, from: never = popup) =>
        h.login.handle({ version: 1, type: "login.detail.get", tabId: 1 }, from);
      const fill = (
        h: ReturnType<typeof harness>,
        documentId: string,
        overrides: Record<string, unknown> = {},
      ) =>
        h.login.handle(
          {
            version: 1,
            type: "login.detail.fill",
            tabId: 1,
            documentId,
            detail: "birth-date",
            connectionId,
            itemId: identityId,
            fieldId: birthField,
            ...overrides,
          },
          popup,
        );
      const remove = (h: ReturnType<typeof harness>, detail = "birth-date") =>
        h.login.handle({ version: 1, type: "login.detail.remove", tabId: 1, detail }, popup);
      const source = (fieldId: string, fieldLabel: string) => ({
        connectionId,
        itemId: identityId,
        fieldId,
        itemLabel: "Extra synthetic item",
        fieldLabel,
      });
      const popupFills = () =>
        fake.state.messages.filter((entry) => entry.type === "login.detail.fill");
      const pendingKey = "pateat.login-pending-details.v1";
      const offersKey = "pateat.login-detail-offers.v1";
      async function stopped(read: Record<string, string> = birthValue) {
        vi.useFakeTimers();
        onClick({ login: toConfirm, confirm: toHome });
        const started = start([], read);
        expect(await started.h.hello()).toEqual({ ok: true });
        await until(settled("watching", "challenge"), 10_000);
        return started;
      }
      async function signedIn(h: ReturnType<typeof harness>) {
        fake.state.pageUrl = `${origin}/home`;
        fake.state.observedPath = "/home";
        fake.state.present = new Set(["logout"]);
        fake.state.extracted = { "signed-in": homePage };
        await h.hello({ documentId: "document-home" }, false);
        await vi.advanceTimersByTimeAsync(30_000);
      }
      it("lists the fields that could give each detail the page asks for", async () => {
        const { h } = await stopped();
        expect(await ask(h)).toEqual({
          ok: true,
          origin,
          offer: {
            documentId: "synthetic-document",
            details: [
              {
                detail: "birth-date",
                format: "yyyymm",
                candidates: [source(birthField, "生年月日")],
              },
              {
                detail: "phone-last-4",
                candidates: [source("identity.phone", "Phone number"), source(phoneField, "Phone")],
              },
            ],
          },
          links: [],
        });
        // Nothing is read from the vault until the person picks a field.
        expect(reads(h)).toEqual([[itemId, "login.password"]]);
        // A content script is not the popup.
        expect(await ask(h, sender() as never)).toBeUndefined();
      });
      it("fills the chosen field's value without pressing the button, and saves it once the login is confirmed", async () => {
        const { h, report } = await stopped();
        const executions = executed().length;
        expect(await fill(h, "synthetic-document")).toEqual({ ok: true });
        // The page is asked first whether it still shows the handler.
        expect(fake.state.messages).toContainEqual(
          expect.objectContaining({
            type: "login.observe",
            path: "/signin",
            targets: [target("birth"), target("confirm")],
            require: ["settable", "shown"],
          }),
        );
        expect(popupFills()).toEqual([
          expect.objectContaining({
            type: "login.detail.fill",
            path: "/signin",
            fields: [{ target: target("birth"), value: "199004", secret: "detail" }],
          }),
        ]);
        expect(JSON.stringify(fake.state.messages)).not.toContain("1990-04-01");
        expect(reads(h).at(-1)).toEqual([identityId, birthField]);
        expect(executed()).toHaveLength(executions);
        // The link waits for the login to be confirmed.
        expect(await ask(h)).toMatchObject({
          links: [
            {
              detail: "birth-date",
              itemLabel: "Extra synthetic item",
              fieldLabel: "生年月日",
              pending: true,
            },
          ],
        });
        expect(h.store.update).not.toHaveBeenCalled();
        expect(fake.state.session[pendingKey]).toEqual([
          expect.objectContaining({ tabId: 1, link: birthLink }),
        ]);
        await signedIn(h);
        expect(status()).toMatchObject([{ state: "authenticated", outcome: "authenticated" }]);
        expect(savedLinks(h)).toEqual([birthLink]);
        expect(handlerReports(report)).toEqual([
          [0, "detail", "detail-unlinked", 2],
          [0, "detail", "detail-saved", 2],
        ]);
        expect(fake.state.session[pendingKey]).toEqual([]);
        expect(fake.state.session["pateat.login-detail-offers.v1"]).toEqual([]);
        // The saved link is listed as the site's, and the popup proposes nothing more.
        expect(await ask(h)).toEqual({
          ok: true,
          origin,
          links: [
            { detail: "birth-date", itemLabel: "Extra synthetic item", fieldLabel: "生年月日" },
          ],
        });
      });
      it("keeps only the link last filled for the handler, named by its custom field", async () => {
        const { h } = await stopped({ ...birthValue, [phoneField]: "090-0000-5678" });
        expect(await fill(h, "synthetic-document")).toEqual({ ok: true });
        // The person chooses the other radio instead.
        expect(
          await fill(h, "synthetic-document", { detail: "phone-last-4", fieldId: phoneField }),
        ).toEqual({ ok: true });
        expect(popupFills().at(-1)).toMatchObject({
          fields: [{ target: target("phone"), value: "5678" }],
        });
        expect(fake.state.session[pendingKey]).toHaveLength(1);
        await signedIn(h);
        expect(savedLinks(h)).toEqual([
          linkTo("phone-last-4", { itemId: identityId, field: { custom: "Phone" } }),
        ]);
      });
      it("says when the confirmed login's link could not be saved", async () => {
        const { h, report } = await stopped();
        expect(await fill(h, "synthetic-document")).toEqual({ ok: true });
        h.store.update.mockRejectedValueOnce(new Error("synthetic storage failure"));
        await signedIn(h);
        expect(status()).toMatchObject([{ state: "authenticated" }]);
        expect(savedLinks(h)).toEqual([]);
        expect(handlerReports(report).at(-1)).toEqual([0, "detail", "detail-not-saved", 2]);
      });
      it("drops the kept link when the tab closes before the login is confirmed", async () => {
        const { h } = await stopped();
        expect(await fill(h, "synthetic-document")).toEqual({ ok: true });
        for (const listener of fake.state.removed) listener(1);
        await vi.advanceTimersByTimeAsync(100);
        expect(fake.state.session[pendingKey]).toEqual([]);
        expect(fake.state.session["pateat.login-detail-offers.v1"]).toEqual([]);
        expect(h.store.update).not.toHaveBeenCalled();
      });
      it("removes a kept link before it is saved", async () => {
        const { h } = await stopped();
        expect(await fill(h, "synthetic-document")).toEqual({ ok: true });
        expect(await remove(h)).toEqual({ ok: true });
        expect(fake.state.session[pendingKey]).toEqual([]);
        expect(await ask(h)).toMatchObject({ links: [] });
        expect(await remove(h)).toEqual({ ok: false, reason: "no-link" });
        await signedIn(h);
        expect(status()).toMatchObject([{ state: "authenticated" }]);
        expect(savedLinks(h)).toEqual([]);
        expect(h.store.update).not.toHaveBeenCalled();
      });
      it("drops the kept link when the watched login is rejected", async () => {
        vi.useFakeTimers();
        onClick({ login: toConfirm, confirm: toHome });
        // The page after the person's submission says the value was wrong.
        const service = generation(async (_recipe, _revision, _route, page) => ({
          verdict: page.path === "/next" ? "rejected" : "unclear",
        }));
        const { h, report } = start([], birthValue, detailed, {}, { generation: service });
        expect(await h.hello()).toEqual({ ok: true });
        await until(settled("watching", "challenge"), 10_000);
        expect(await fill(h, "synthetic-document")).toEqual({ ok: true });
        expect(fake.state.session[pendingKey]).toHaveLength(1);
        fake.state.pageUrl = `${origin}/next`;
        fake.state.observedPath = "/next";
        fake.state.present = new Set();
        fake.state.signs = {
          password: false,
          code: false,
          captcha: false,
          invalid: false,
          alert: false,
        };
        fake.state.extracted = {
          "signed-in": {
            ok: true,
            observation: {
              version: 1,
              origin,
              path: "/next",
              language: "en",
              complete: true,
              candidates: [{ id: "c1", role: "link", target: target("help"), label: "Help" }],
            },
          },
        };
        await h.hello({ documentId: "document-next" }, false);
        await until(settled("blocked", "credential-rejected"), 60_000);
        expect(fake.state.session[pendingKey]).toEqual([]);
        expect(savedLinks(h)).toEqual([]);
        expect(h.store.update).not.toHaveBeenCalled();
        // No link was saved, so none is forgotten either.
        expect(handlerReports(report)).toEqual([[0, "detail", "detail-unlinked", 2]]);
        expect(await ask(h)).toMatchObject({ links: [] });
      });
      it("proposes nothing more once the person typed the value and the login was confirmed", async () => {
        const { h, report } = await stopped();
        await signedIn(h);
        expect(status()).toMatchObject([{ state: "authenticated", outcome: "authenticated" }]);
        expect(await ask(h)).toEqual({ ok: true, origin, links: [] });
        expect(await fill(h, "synthetic-document")).toEqual({
          ok: false,
          reason: "document-gone",
        });
        expect(savedLinks(h)).toEqual([]);
        expect(popupFills()).toEqual([]);
        expect(handlerReports(report)).toEqual([[0, "detail", "detail-unlinked", 2]]);
        // The offer ended with the login, in the session too, so a restarted worker does
        // not bring it back.
        expect(fake.state.session[offersKey]).toEqual([]);
      });
      it("proposes nothing more in the document that asked once the person typed the value and the login was confirmed", async () => {
        const { h, report } = await stopped();
        await signedIn(h);
        expect(status()).toMatchObject([{ state: "authenticated", outcome: "authenticated" }]);
        // The tab shows the document that asked again, as a single-page site or the
        // back-forward cache keeps it: the login's offer ended with the login.
        await h.hello({ documentId: "synthetic-document" }, false);
        await vi.advanceTimersByTimeAsync(1_000);
        expect(status()).toMatchObject([{ state: "authenticated", outcome: "authenticated" }]);
        expect(await ask(h)).toEqual({ ok: true, origin, links: [] });
        expect(fake.state.session[offersKey]).toEqual([]);
        expect(savedLinks(h)).toEqual([]);
        expect(popupFills()).toEqual([]);
        expect(handlerReports(report)).toEqual([[0, "detail", "detail-unlinked", 2]]);
      });
      it("lifts a refused link that the person fills again, once the login is confirmed", async () => {
        vi.useFakeTimers();
        onClick({ login: toConfirm, confirm: toConfirm });
        const { h, report } = start([birthLink]);
        // The settings refuse the refused link's removal.
        const write = h.store.update.getMockImplementation()!;
        h.store.update.mockRejectedValue(new Error("synthetic storage failure"));
        expect(await h.hello()).toEqual({ ok: true });
        await until(() => clicks("confirm") === 1);
        await h.hello({ documentId: "again" }, false);
        await until(settled("watching", "challenge"), 5_000);
        expect(fake.state.session[refusedKey]).toEqual([birthRefusal]);
        // The person signs out and the page asks again; the refused link is not used.
        for (const listener of fake.state.removed.splice(0)) listener(1);
        await vi.advanceTimersByTimeAsync(1_000);
        fake.state.present = new Set(["password", "login"]);
        expect(await h.hello({ documentId: "later" })).toEqual({ ok: true });
        await until(() => handlerReports(report).length === 4, 10_000);
        expect(handlerReports(report).at(-1)).toEqual([0, "detail", "detail-unlinked", 2]);
        // The person picks the same field in the popup, and the login is confirmed.
        h.store.update.mockImplementation(write);
        expect(await fill(h, "later")).toEqual({ ok: true });
        await signedIn(h);
        await vi.waitFor(() =>
          expect(handlerReports(report).at(-1)).toEqual([0, "detail", "detail-saved", 2]),
        );
        expect(savedLinks(h)).toEqual([birthLink]);
        // The session no longer keeps the refusal, so a restarted worker does not bring it
        // back.
        expect(fake.state.session[refusedKey]).toEqual([]);
      });
      it("has nothing to show for a tab without a web page or a login", async () => {
        const { h } = start([birthLink]);
        fake.state.tabUrls[1] = "chrome://newtab/";
        expect(await ask(h)).toEqual({ ok: false, reason: "no-page" });
        expect(await remove(h)).toEqual({ ok: false, reason: "no-link" });
        delete fake.state.tabUrls[1];
        // No login ran in the tab, so it has no login item whose links to list.
        expect(await ask(h)).toEqual({ ok: true, origin, links: [] });
        expect(await remove(h)).toEqual({ ok: false, reason: "no-link" });
        expect(savedLinks(h)).toEqual([birthLink]);
        expect(h.store.update).not.toHaveBeenCalled();
      });
      it("fills nothing in another document than the login's", async () => {
        const { h } = await stopped();
        expect(await fill(h, "another-document")).toEqual({ ok: false, reason: "document-gone" });
        // The page is loaded again: the offer's document is gone.
        await h.hello({ documentId: "reloaded" }, false);
        await vi.advanceTimersByTimeAsync(1_000);
        expect(await fill(h, "synthetic-document")).toEqual({
          ok: false,
          reason: "document-gone",
        });
        expect(popupFills()).toEqual([]);
        expect(reads(h)).toEqual([[itemId, "login.password"]]);
      });
      it.each([
        ["its button", "confirm"],
        ["its input", "birth"],
      ])("fills nothing once the page no longer shows %s", async (_label, gone) => {
        const { h } = await stopped();
        fake.state.present = new Set(toConfirm.present.filter((value) => value !== gone));
        expect(await fill(h, "synthetic-document")).toEqual({
          ok: false,
          reason: "document-gone",
        });
        expect(popupFills()).toEqual([]);
        expect(reads(h)).toEqual([[itemId, "login.password"]]);
      });
      it("fills nothing once the login item may no longer be used", async () => {
        const { h } = await stopped();
        h.settings.settings.itemPolicies = [liveItemPolicy(itemId, { excluded: true })];
        expect(await fill(h, "synthetic-document")).toEqual({ ok: false, reason: "unavailable" });
        expect(popupFills()).toEqual([]);
        expect(reads(h)).toEqual([[itemId, "login.password"]]);
      });
      it.each([
        ["a field the popup did not offer", { fieldId: "login.password" }],
        ["a field of another detail", { fieldId: "identity.phone" }],
        ["a detail the page does not ask for", { detail: "card-code", fieldId: "card.code" }],
        ["another connection", { connectionId: "duplicate-connection" }],
      ])("fills nothing from %s", async (_label, overrides) => {
        const { h } = await stopped();
        expect(await fill(h, "synthetic-document", overrides)).toEqual({
          ok: false,
          reason: "not-a-candidate",
        });
        expect(popupFills()).toEqual([]);
        expect(reads(h)).toEqual([[itemId, "login.password"]]);
      });
      it("fills nothing from a value that is no date, or that the vault cannot give", async () => {
        const { h } = await stopped({ [birthField]: "spring of 1990" });
        expect(await fill(h, "synthetic-document")).toEqual({ ok: false, reason: "unreadable" });
        h.fields.mockImplementation(async () => undefined);
        expect(await fill(h, "synthetic-document")).toEqual({ ok: false, reason: "unavailable" });
        expect(popupFills()).toEqual([]);
        expect(fake.state.session[pendingKey]).toEqual([]);
      });
      it("keeps no link when the page refuses the fill", async () => {
        const { h } = await stopped();
        const answer = fake.browser.tabs.sendMessage;
        vi.spyOn(fake.browser.tabs, "sendMessage").mockImplementation(async (...args) =>
          args[1]["type"] === "login.detail.fill" ? { ok: false } : answer(...args),
        );
        onTestFinished(() => vi.mocked(fake.browser.tabs.sendMessage).mockRestore());
        expect(await fill(h, "synthetic-document")).toEqual({ ok: false, reason: "not-filled" });
        expect(fake.state.session[pendingKey]).toEqual([]);
        expect(await ask(h)).toMatchObject({ links: [] });
      });
      it("removes a saved link of the tab's login item", async () => {
        vi.useFakeTimers();
        onClick({ login: toConfirm, confirm: toHome });
        const other = { ...birthLink, itemId: otherItemId };
        const { h } = start([birthLink, phoneLink, other]);
        expect(await h.hello()).toEqual({ ok: true });
        await until(settled("authenticated"), 10_000);
        expect(await ask(h)).toEqual({
          ok: true,
          origin,
          links: [
            { detail: "birth-date", itemLabel: "Extra synthetic item", fieldLabel: "生年月日" },
            {
              detail: "phone-last-4",
              itemLabel: "Extra synthetic item",
              fieldLabel: "Phone number",
            },
          ],
        });
        expect(await remove(h)).toEqual({ ok: true });
        expect(savedLinks(h)).toEqual([phoneLink, other]);
        expect(await remove(h, "card-code")).toEqual({ ok: false, reason: "no-link" });
      });
      it("does not remove a saved link while a login is in progress", async () => {
        onClick({ login: toConfirm, confirm: "hang" });
        const { h } = start([birthLink]);
        expect(await h.hello()).toEqual({ ok: true });
        await vi.waitFor(() => expect(clicks("confirm")).toBe(1), { timeout: 6_000 });
        expect(await remove(h)).toEqual({ ok: false, reason: "not-saved" });
        expect(savedLinks(h)).toEqual([birthLink]);
        expect(h.store.update).not.toHaveBeenCalled();
      }, 10_000);
      it.each([
        [
          "keeps a saved link while a login between pages changed within two minutes",
          10_000,
          false,
        ],
        [
          "removes a saved link once a login between pages has not changed for two minutes",
          2 * 60_000,
          true,
        ],
      ])(
        "after a worker restart, %s (owner, 2026-10-25)",
        async (_name, age, removed) => {
          onClick({ login: toConfirm, confirm: "hang" });
          const { h: first } = start([birthLink]);
          expect(await first.hello()).toEqual({ ok: true });
          await vi.waitFor(() => expect(clicks("confirm")).toBe(1), { timeout: 6_000 });
          const [record] = status() as Record<string, unknown>[];
          record!["changedAt"] = (record!["changedAt"] as number) - age;
          // The restarted worker has no run of the tab, only the record of its login.
          const query = fake.browser.tabs.query;
          fake.browser.tabs.query = async () => [{ id: 1 }] as never;
          onTestFinished(() => {
            fake.browser.tabs.query = query;
          });
          // The popup asks at once, before anything else waited for the stored records.
          const { h } = start([birthLink]);
          expect(await remove(h)).toEqual(
            removed ? { ok: true } : { ok: false, reason: "not-saved" },
          );
          expect(savedLinks(h)).toEqual(removed ? [] : [birthLink]);
        },
        10_000,
      );
    });
  });
});
