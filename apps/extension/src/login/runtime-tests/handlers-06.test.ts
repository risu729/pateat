import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  parseLoginRecipe,
  type DetailLink,
  type LocalSettings,
  type LoginHandler,
} from "@pateat/contracts";
import type { LoginReport } from "../runtime/report";
const fake = await vi.hoisted(async () => (await import("./browser-fake")).createBrowserFake());
vi.mock("wxt/browser", () => ({ browser: fake.browser }));
vi.stubEnv("MODE", "production");
const { createRuntimeTestHarness } = await import("./harness");
const {
  origin,
  connectionId,
  itemId,
  sender,
  target,
  recipe,
  otherItemId,
  liveItemPolicy,
  harness,
  realTime,
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
  describe("the detail handler (ADR 0061)", () => {
    const detailHandler = {
      kind: "detail" as const,
      path: "/confirm",
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
    const toConfirm = { path: "/confirm", present: ["birth", "phone", "confirm"] };
    const noPasskey = vi.fn(async () => ({ passkey: false, discoverable: false }));
    const detailFills = () =>
      fake.state.messages.filter(
        (entry) =>
          entry.type === "login.execute" && entry.values?.some((value) => value.slot === "detail"),
      );
    const handlerReports = (report: ReturnType<typeof vi.fn<(report: LoginReport) => void>>) =>
      report.mock.calls.flatMap(([value]) =>
        value.type === "handler" ? [[value.handler, value.kind, value.outcome, value.steps]] : [],
      );

    const asCard = (h: ReturnType<typeof harness>) => {
      const original = h.store.handle.getMockImplementation()!;
      h.store.handle.mockImplementation(async () => {
        const response = await original();
        if (response.ok)
          response.catalog.connections[0]!.items[1]!.fields = [
            "card.number",
            "card.expMonth",
            "card.expYear",
          ].map((id) => ({ id, label: id.slice(5), name: null, kind: "text" as const }));
        return response;
      });
    };
    const cardValues: Record<string, string> = {
      "card.number": "4000 0000 0000 0002",
      "card.expMonth": "4",
      "card.expYear": "2031",
      "login.username": "synthetic-user@example.test",
    };
    const asking = (fields: Extract<LoginHandler, { kind: "detail" }>["fields"]) =>
      parseLoginRecipe({
        ...unlearned,
        completion: home,
        handlers: [{ ...detailHandler, fields }],
      });
    describe("the popup's Fill", () => {
      const popup = {
        id: "synthetic-extension",
        url: "chrome-extension://synthetic-extension/popup.html",
      } as never;
      const popupFills = () =>
        fake.state.messages.filter((entry) => entry.type === "login.detail.fill");
      async function stopped(
        fields: Extract<LoginHandler, { kind: "detail" }>["fields"],
        live: Parameters<typeof harness>[1] = {},
        overrides: Partial<LocalSettings> = {},
      ) {
        fake.state.detailFillReply = undefined;
        onClick({
          login: {
            path: "/confirm",
            present: [
              ...fields.flatMap((entry) =>
                "parts" in entry
                  ? entry.parts.map((part) => part.target.value)
                  : [entry.target.value],
              ),
              "confirm",
            ],
          },
          confirm: toHome,
        });
        const h = harness(overrides, { passkeys: noPasskey, ...live });
        h.recipes.recipe.mockResolvedValue(asking(fields));
        expect(await h.hello()).toEqual({ ok: true });
        await vi.waitFor(() =>
          expect(status()).toMatchObject([{ state: "watching", outcome: "challenge" }]),
        );
        return h;
      }
      const fill = (
        h: ReturnType<typeof harness>,
        detail: DetailLink["detail"],
        item: string,
        fieldId: string,
      ) =>
        h.login.handle(
          {
            version: 1,
            type: "login.detail.fill",
            tabId: 1,
            documentId: "synthetic-document",
            detail,
            connectionId,
            itemId: item,
            fieldId,
          },
          popup,
        );
      it("fills the login item's PIN, and never another login item's", async () => {
        const h = await stopped([{ detail: "pin", target: target("pin") }], {
          custom: [{ name: "暗証番号", kind: "hidden" }],
          otherCustom: [{ name: "PIN", kind: "hidden" }],
        });
        h.fields.mockImplementation(async (request) =>
          request.fieldId.startsWith("custom.") ? "01-23" : "synthetic-secret",
        );
        const offered = await h.login.handle(
          { version: 1, type: "login.detail.get", tabId: 1 },
          popup,
        );
        expect(offered).toMatchObject({
          offer: { details: [{ detail: "pin", candidates: [{ itemId, fieldLabel: "暗証番号" }] }] },
        });
        const fieldId = (offered as { offer: { details: { candidates: { fieldId: string }[] }[] } })
          .offer.details[0]!.candidates[0]!.fieldId;
        expect(await fill(h, "pin", otherItemId, fieldId)).toEqual({
          ok: false,
          reason: "not-a-candidate",
        });
        expect(popupFills()).toEqual([]);
        expect(await fill(h, "pin", itemId, fieldId)).toEqual({ ok: true });
        expect(popupFills()).toEqual([
          expect.objectContaining({
            path: "/confirm",
            fields: [{ target: target("pin"), value: "0123", secret: "pin" }],
          }),
        ]);
        // The item has no username, so the page is not asked to compare accounts.
        expect(popupFills()[0]).not.toHaveProperty("account");
      }, 10_000);
      it.each([false, true])(
        "popup detail destination authorization uses the login item when its match is %s",
        async (loginMatches) => {
          const destinationOrigin = "https://auth.login.example";
          const h = await stopped([{ detail: "card-number", target: target("card") }]);
          asCard(h);
          const originalCatalog = h.store.handle.getMockImplementation()!;
          h.store.handle.mockImplementation(async () => {
            const response = await originalCatalog();
            if (response.ok) {
              const items = response.catalog.connections[0]!.items;
              items[0]!.allowedOrigins = loginMatches ? [origin, destinationOrigin] : [origin];
              // The source card deliberately has the opposite rule: it never authorizes
              // the destination of the account whose login requested its value.
              items[1]!.allowedOrigins = loginMatches ? [] : [destinationOrigin];
            }
            return response;
          });
          h.fields.mockImplementation(
            async (request) => cardValues[request.fieldId] ?? "synthetic-secret",
          );
          const originalSend = fake.browser.tabs.sendMessage;
          let authorized: unknown;
          const spy = vi
            .spyOn(fake.browser.tabs, "sendMessage")
            .mockImplementation(async (tabId, message, options) => {
              if (message["type"] !== "login.detail.fill")
                return originalSend(tabId, message, options);
              authorized = await h.login.handle(
                {
                  version: 1,
                  type: "login.detail.authorize",
                  token: message["token"],
                  fillId: message["fillId"],
                  destinations: [`${destinationOrigin}/session`],
                },
                sender(),
              );
              return { ok: authorized === true };
            });
          try {
            expect(await fill(h, "card-number", otherItemId, "card.number")).toEqual(
              loginMatches ? { ok: true } : { ok: false, reason: "not-filled" },
            );
            expect(authorized).toBe(loginMatches);
          } finally {
            spy.mockRestore();
          }
        },
      );
      it("keeps no link when the page shows another account", async () => {
        const h = await stopped([{ detail: "card-number", target: target("card") }], {
          username: true,
        });
        asCard(h);
        h.fields.mockImplementation(
          async (request) => cardValues[request.fieldId] ?? "synthetic-secret",
        );
        fake.state.detailFillReply = { ok: false, reason: "other-account" };
        expect(await fill(h, "card-number", otherItemId, "card.number")).toEqual({
          ok: false,
          reason: "other-account",
        });
        expect(
          await h.login.handle({ version: 1, type: "login.detail.get", tabId: 1 }, popup),
        ).toMatchObject({ links: [] });
        fake.state.detailFillReply = undefined;
      }, 10_000);
    });
    it("is shown while one of its inputs is disabled, as a choice page may disable it", async () => {
      onClick({ login: toConfirm, confirm: toHome });
      fake.state.unusable = new Set(["phone"]);
      const report = vi.fn<(report: LoginReport) => void>();
      const h = harness({}, { passkeys: noPasskey, report });
      h.recipes.recipe.mockResolvedValue(detailed);
      expect(await h.hello()).toEqual({ ok: true });
      await vi.waitFor(() =>
        expect(status()).toMatchObject([{ state: "watching", outcome: "challenge" }]),
      );
      expect(handlerReports(report)).toEqual([[0, "detail", "detail-unlinked", 2]]);
      expect(detailFills()).toEqual([]);
      expect(clicks("confirm")).toBe(0);
    });
    it.each([
      ["its inputs", ["birth", "phone"], "ok.ok.missing"],
      ["its button and one input", ["birth", "confirm"], "ok.missing.ok"],
    ])(
      "is not entered while only %s show",
      async (_label, present, why) => {
        onClick({ login: { path: "/confirm", present } });
        const report = vi.fn<(report: LoginReport) => void>();
        const h = harness({}, { passkeys: noPasskey, report });
        h.recipes.recipe.mockResolvedValue(detailed);
        expect(await h.hello()).toEqual({ ok: true });
        await vi.waitFor(
          () =>
            expect(status()).toMatchObject([{ state: "reconciling", outcome: "unknown-submit" }]),
          { timeout: 6_000 },
        );
        expect(detailFills()).toEqual([]);
        // Said once, with the check of each input and then the button (#1381).
        expect(
          report.mock.calls.flatMap(([value]) =>
            value.type === "handler" ? [[value.handler, value.outcome, value.why]] : [],
          ),
        ).toEqual([[0, "not-shown", why]]);
      },
      10_000,
    );
    describe("the popup's guess of a card (owner 2026-10-23 12:26 UTC)", () => {
      const coded = parseLoginRecipe({
        ...unlearned,
        completion: home,
        handlers: [
          { ...detailHandler, fields: [{ detail: "card-code" as const, target: target("code") }] },
        ],
      });
      const popup = {
        id: "synthetic-extension",
        url: "chrome-extension://synthetic-extension/popup.html",
      } as never;
      const cards: Record<string, { number?: string; brand?: string }> = {
        "card-a": { number: "4242 4242 4242 7351", brand: "Visa" },
        "card-b": { number: "5555 5555 5555 9876", brand: "Mastercard" },
        "card-c": { number: "3530 1113 3330 9876", brand: "JCB" },
        // A card item without a brand.
        "card-d": { number: "3530 2224 4440 9876" },
      };
      async function stopped(
        ids: string[],
        hints: unknown,
        overrides: Partial<LocalSettings> = {},
        /** Card items with Bitwarden's re-prompt, and the harness's further options. */
        reprompt: { cards?: string[]; live?: Parameters<typeof harness>[1] } = {},
      ) {
        onClick({ login: { path: "/confirm", present: ["code", "confirm"] } });
        fake.state.cardHints = hints;
        const report = vi.fn<(entry: LoginReport) => void>();
        const h = harness(overrides, { passkeys: noPasskey, report, ...reprompt.live });
        const vault = { state: "ready" as "ready" | "locked" };
        const original = h.store.handle.getMockImplementation()!;
        h.store.handle.mockImplementation(async () => {
          const response = await original();
          if (response.ok) response.catalog.connections[0]!.state = vault.state;
          if (response.ok)
            response.catalog.connections[0]!.items.push(
              ...ids.map((id) => ({
                id,
                label: `Synthetic ${id}`,
                ...(reprompt.cards?.includes(id) ? { reprompt: true as const } : {}),
                allowedOrigins: [],
                groupIds: [],
                fields: ["card.number", "card.code", "card.brand"].map((field) => ({
                  id: field,
                  label: field.slice(5),
                  name: null,
                  kind: "text" as const,
                })),
              })),
            );
          return response;
        });
        h.fields.mockImplementation(async (request) => {
          const card = cards[request.account.itemId];
          if (!card) return "synthetic-secret";
          // A field without a value reads as nothing, as the vault field source answers.
          return request.fieldId === "card.number" ? card.number : card.brand;
        });
        h.recipes.recipe.mockResolvedValue(coded);
        if (reprompt.live?.askMasterPassword) {
          // The login starts once the master password was typed and the document announces again.
          fake.state.onReconnect = () => h.hello();
          await h.hello();
        } else expect(await h.hello()).toEqual({ ok: true });
        await vi.waitFor(() =>
          expect(status()).toMatchObject([{ state: "watching", outcome: "challenge" }]),
        );
        h.fields.mockClear();
        return { h, report, vault };
      }
      const offered = async (h: ReturnType<typeof harness>) => {
        const answer = (await h.login.handle(
          { version: 1, type: "login.detail.get", tabId: 1 },
          popup,
        )) as {
          offer?: { details: { candidates: { itemId: string }[]; preselect?: false }[] };
        };
        const [detail] = answer.offer!.details;
        return {
          order: detail!.candidates.map((entry) => entry.itemId),
          preselect: detail!.preselect,
        };
      };
      const reads = (h: ReturnType<typeof harness>) =>
        h.fields.mock.calls.map(([request]) => [request.account.itemId, request.fieldId]);
      it("puts first and selects the one card ending in the last digits the page shows", async () => {
        const { h, report } = await stopped(["card-a", "card-b"], {
          ok: true,
          last4: ["9876"],
          brands: [],
        });
        expect(await offered(h)).toEqual({ order: ["card-b", "card-a"], preselect: undefined });
        // Each card's number and brand, one at a time, before any confirmation.
        expect(reads(h)).toEqual([
          ["card-a", "card.number"],
          ["card-a", "card.brand"],
          ["card-b", "card.number"],
          ["card-b", "card.brand"],
        ]);
        expect(fake.state.messages).toContainEqual(
          expect.objectContaining({ type: "login.detail.card", target: target("code") }),
        );
        // Neither the page's digits nor a card's leave the worker: not to a document, the
        // log, the settings or the recipe service. The clock-derived values (`expiresAt` and
        // the UUIDv7 ids) are left out, as the current time can contain any of the digits.
        const out = JSON.stringify(
          [
            fake.state.messages,
            report.mock.calls,
            h.store.update.mock.calls,
            h.recipes.recipe.mock.calls,
            h.recipes.starts.mock.calls,
          ],
          (key, value: unknown) =>
            ["expiresAt", "attemptId", "operationId"].includes(key) ? undefined : value,
        );
        for (const digits of ["9876", "7351", "4242", "5555"]) expect(out).not.toContain(digits);
      });
      describe("a card with Bitwarden's re-prompt", () => {
        const listed = {
          repromptSites: [{ hostname: "login.example", includeSubdomains: false }],
        };
        const hints = { ok: true, last4: ["9876"], brands: [] };
        it("is guessed as any other card on a site that does not ask", async () => {
          const { h } = await stopped(
            ["card-a", "card-b", "card-c"],
            hints,
            {},
            {
              cards: ["card-b"],
            },
          );
          expect(await offered(h)).toEqual({
            order: ["card-b", "card-c", "card-a"],
            preselect: false,
          });
          expect(reads(h).map(([item]) => item)).toContain("card-b");
        });
        it("is not read for the guess on a site that asks, while the login does not hold the master password", async () => {
          const { h } = await stopped(["card-a", "card-b", "card-c"], hints, listed, {
            cards: ["card-b"],
          });
          // It stays a candidate after the guessed card, and as it was not read none is
          // selected; its Fill asks for the master password.
          expect(await offered(h)).toEqual({
            order: ["card-c", "card-a", "card-b"],
            preselect: false,
          });
          expect(reads(h)).toEqual([
            ["card-a", "card.number"],
            ["card-a", "card.brand"],
            ["card-c", "card.number"],
            ["card-c", "card.brand"],
          ]);
        });
        it("selects none, not even by name, when every card waits for the master password", async () => {
          const { h } = await stopped(["card-a", "card-b"], hints, listed, {
            cards: ["card-a", "card-b"],
          });
          expect(await offered(h)).toEqual({ order: ["card-a", "card-b"], preselect: false });
          expect(reads(h)).toEqual([]);
        });
        it("selects none by name on a page that shows no digits or brand while a card waits", async () => {
          const { h } = await stopped(
            ["card-a", "card-b"],
            { ok: true, last4: [], brands: [] },
            listed,
            { cards: ["card-b"] },
          );
          expect(await offered(h)).toEqual({ order: ["card-a", "card-b"], preselect: false });
          expect(reads(h)).toEqual([]);
        });
        it("is guessed in a login started after the master password was typed", async () => {
          realTime();
          const askMasterPassword = vi.fn(async (_input: unknown) => "verified" as const);
          const { h } = await stopped(["card-a", "card-b", "card-c"], hints, listed, {
            cards: ["card-b"],
            live: { reprompt: true, askMasterPassword },
          });
          expect(askMasterPassword).toHaveBeenCalledOnce();
          expect(await offered(h)).toEqual({
            order: ["card-b", "card-c", "card-a"],
            preselect: false,
          });
          expect(reads(h).map(([item]) => item)).toContain("card-b");
        }, 10_000);
      });
      it("selects the only card of the brand the page names when no last digits match", async () => {
        const { h } = await stopped(["card-a", "card-b"], {
          ok: true,
          last4: [],
          brands: ["Mastercard"],
        });
        expect(await offered(h)).toEqual({ order: ["card-b", "card-a"], preselect: undefined });
      });
      it("selects none of two cards that end in the same digits", async () => {
        const { h } = await stopped(["card-a", "card-b", "card-c"], {
          ok: true,
          last4: ["9876"],
          brands: [],
        });
        expect(await offered(h)).toEqual({
          order: ["card-b", "card-c", "card-a"],
          preselect: false,
        });
      });
      it("never reads an excluded card or an excluded number", async () => {
        const { h } = await stopped(
          ["card-a", "card-b", "card-c"],
          {
            ok: true,
            last4: ["9876"],
            brands: [],
          },
          {
            itemPolicies: [
              liveItemPolicy("card-c", { excluded: true }),
              liveItemPolicy("card-b", { excludedFields: ["card.number"] }),
            ],
          },
        );
        // Card B's number is not allowed, so its digits are unknown and it comes before card
        // A, whose digits differ, with none selected; card C is no candidate.
        expect(await offered(h)).toEqual({ order: ["card-b", "card-a"], preselect: false });
        expect(reads(h)).toEqual([
          ["card-a", "card.number"],
          ["card-a", "card.brand"],
          ["card-b", "card.brand"],
        ]);
      });
      it("keeps the order by name when a read fails, and reads nothing for a page that shows nothing", async () => {
        const { h } = await stopped(["card-a", "card-b"], {
          ok: true,
          last4: ["9876"],
          brands: [],
        });
        h.fields.mockRejectedValueOnce(new Error("locked"));
        expect(await offered(h)).toEqual({ order: ["card-a", "card-b"], preselect: undefined });
        expect(reads(h)).toEqual([["card-a", "card.number"]]);
        h.fields.mockClear();
        fake.state.cardHints = { ok: true, last4: [], brands: [] };
        expect(await offered(h)).toEqual({ order: ["card-a", "card-b"], preselect: undefined });
        // A page's answer that is not hints is none.
        fake.state.cardHints = { ok: true, last4: ["12345"], brands: [] };
        expect(await offered(h)).toEqual({ order: ["card-a", "card-b"], preselect: undefined });
        expect(reads(h)).toEqual([]);
      });
      it("reads on past a card without a brand", async () => {
        const { h } = await stopped(["card-a", "card-d"], {
          ok: true,
          last4: ["9876"],
          brands: [],
        });
        expect(await offered(h)).toEqual({ order: ["card-d", "card-a"], preselect: undefined });
        expect(reads(h)).toEqual([
          ["card-a", "card.number"],
          ["card-a", "card.brand"],
          ["card-d", "card.number"],
          ["card-d", "card.brand"],
        ]);
      });
      it("reads the vault once for the popup's polls, and keeps its guess when the page does not answer", async () => {
        const { h } = await stopped(["card-a", "card-b"], {
          ok: true,
          last4: ["9876"],
          brands: [],
        });
        expect(await offered(h)).toEqual({ order: ["card-b", "card-a"], preselect: undefined });
        expect(reads(h)).toHaveLength(4);
        h.fields.mockClear();
        expect(await offered(h)).toEqual({ order: ["card-b", "card-a"], preselect: undefined });
        fake.state.cardHints = { ok: false };
        expect(await offered(h)).toEqual({ order: ["card-b", "card-a"], preselect: undefined });
        expect(reads(h)).toEqual([]);
        // The page now shows other digits: the cards are read again.
        fake.state.cardHints = { ok: true, last4: ["7351"], brands: [] };
        expect(await offered(h)).toEqual({ order: ["card-a", "card-b"], preselect: undefined });
        expect(reads(h)).toHaveLength(4);
      });
      it("keeps the order by name while the vault is locked or when it changes during the reads", async () => {
        const { h, vault } = await stopped(["card-a", "card-b"], {
          ok: true,
          last4: ["9876"],
          brands: [],
        });
        vault.state = "locked";
        expect(await offered(h)).toEqual({ order: ["card-a", "card-b"], preselect: undefined });
        expect(reads(h)).toEqual([]);
        vault.state = "ready";
        const read = h.fields.getMockImplementation()!;
        // A vault that locked after its catalog was read gives no value at all.
        h.fields.mockImplementation(async () => undefined);
        expect(await offered(h)).toEqual({ order: ["card-a", "card-b"], preselect: undefined });
        expect(reads(h)).toHaveLength(4);
        h.fields.mockClear();
        h.fields.mockImplementation(read);
        // A sync opens another snapshot while the cards are read.
        h.fields.mockImplementationOnce(async (request) => {
          h.snapshot.current = "60000000-0000-4000-8000-000000000009";
          return read(request);
        });
        expect(await offered(h)).toEqual({ order: ["card-a", "card-b"], preselect: undefined });
        expect(reads(h)).toHaveLength(4);
        // Nothing was kept, so the next poll reads the new snapshot.
        expect(await offered(h)).toEqual({ order: ["card-b", "card-a"], preselect: undefined });
        expect(reads(h)).toHaveLength(8);
      });
      it("selects none when more cards could give the value than one guess reads", async () => {
        const many = Array.from({ length: 21 }, (_, index) => {
          const id = `card-${String(index + 10)}`;
          cards[id] = { number: `4242 4242 4242 ${String(index + 1000)}`, brand: "Visa" };
          return id;
        });
        const { h } = await stopped(many, { ok: true, last4: ["1000"], brands: [] });
        const guess = await offered(h);
        expect(guess.order[0]).toBe("card-10");
        expect(guess.order).toHaveLength(20);
        expect(guess.preselect).toBe(false);
        // The first 20 cards only, each its number and brand.
        expect(reads(h)).toHaveLength(40);
        expect(reads(h).some(([read]) => read === "card-30")).toBe(false);
      });
    });
  });
});
