import type { CustomField } from "./harness";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  parseLoginRecipe,
  type DetailLink,
  type LocalSettings,
  type LoginHandler,
  type LoginFieldTarget,
} from "@pateat/contracts";
import type { LoginGeneration, LoginReport } from "../runtime";
const fake = await vi.hoisted(async () => (await import("./browser-fake")).createBrowserFake());
vi.mock("wxt/browser", () => ({ browser: fake.browser }));
vi.stubEnv("MODE", "production");
const { createRuntimeTestHarness } = await import("./harness");
const {
  origin,
  connectionId,
  itemId,
  snapshotId,
  target,
  recipe,
  userId,
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
  const plain = parseLoginRecipe(unlearned);
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
      ["its inputs", ["birth", "phone"]],
      ["its button and one input", ["birth", "confirm"]],
    ])(
      "is not entered while only %s show",
      async (_label, present) => {
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
        expect(handlerReports(report)).toEqual([]);
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
  describe("the account's slots for the judge and a paired secret question", () => {
    const answerHandler = {
      kind: "detail" as const,
      path: "/question",
      fields: [{ detail: "secret-answer" as const, target: target("answer") }],
      target: target("next"),
    };
    const asked = parseLoginRecipe({
      ...unlearned,
      revision: 2,
      completion: home,
      handlers: [answerHandler],
    });
    const questionPage = observation("/question", [
      { id: "c1", role: "text", target: target("answer"), description: "母親の旧姓は？" },
      { id: "c2", role: "button", target: target("next"), label: "Next" },
    ]);
    const toQuestion = { path: "/question", present: ["answer", "next"], extracted: questionPage };
    const answerField = `custom.${snapshotId}.0`;
    const popup = {
      id: "synthetic-extension",
      url: "chrome-extension://synthetic-extension/popup.html",
    } as never;
    const noPasskey = vi.fn(async () => ({ passkey: false, discoverable: false }));
    const pairing = {
      field: target("answer"),
      slot: "custom-1",
      shown: "母親の旧姓は？",
    };
    const answerFills = () =>
      fake.state.messages.filter(
        (entry) =>
          (entry.type === "login.execute" &&
            entry.values?.some((value) => value.slot === "detail")) ||
          entry.type === "login.detail.fill",
      );
    function clickToQuestion(
      started: () => ReturnType<typeof harness>,
      documentId: string,
      pages: Parameters<typeof onClick>[0] = {},
    ) {
      onClick({ login: toQuestion, ...pages });
      const click = fake.state.onExecute!;
      fake.state.onExecute = async (message, tabId) => {
        await click(message, tabId);
        if (fake.state.observedPath !== "/question" || fake.state.pageUrl.endsWith("/question"))
          return;
        // The password page's document is gone.
        const { operation } = message as { operation: { document: { documentId: string } } };
        fake.state.gone.add(operation.document.documentId);
        fake.state.pageUrl = `${origin}/question`;
        setTimeout(() => void started().hello({ documentId }, false), 0);
      };
    }
    async function stoppedAtQuestion(
      questions: { field: LoginFieldTarget; slot: string; shown: string }[] | undefined,
      custom: CustomField[] = [{ name: "お母さんの旧姓", kind: "hidden" }],
    ) {
      vi.useFakeTimers();
      fake.state.question = "秘密の質問：母親の旧姓は？";
      clickToQuestion(() => h, "question-document");
      const answers: Awaited<ReturnType<LoginGeneration["judge"]>>[] = [
        { verdict: "challenge", recipe: asked, ...(questions ? { questions } : {}) },
      ];
      const service = generation(async () => answers.shift() ?? { verdict: "signed-in" });
      const report = vi.fn<(report: LoginReport) => void>();
      const h = harness(
        {},
        { passkeys: noPasskey, generation: service, report, username: true, custom },
      );
      h.recipes.recipe.mockResolvedValue(plain);
      expect(await h.hello()).toEqual({ ok: true });
      await until(settled("watching", "challenge"), 10_000);
      return { h, service, report };
    }
    const detailOf = (h: ReturnType<typeof harness>) =>
      h.login.handle({ version: 1, type: "login.detail.get", tabId: 1 }, popup);
    const fill = (h: ReturnType<typeof harness>) =>
      h.login.handle(
        {
          version: 1,
          type: "login.detail.fill",
          tabId: 1,
          documentId: "question-document",
          detail: "secret-answer",
          connectionId,
          itemId,
          fieldId: answerField,
        },
        popup,
      );
    it("sends the account's slots with the judged page, never a value", async () => {
      const { service } = await stoppedAtQuestion(undefined, [
        { name: "会員番号", kind: "text" },
        { name: "お母さんの旧姓", kind: "hidden" },
      ]);
      const slots = service.judge.mock.calls[0]![8];
      expect(slots).toEqual([
        expect.objectContaining({ id: "username", kind: "identifier" }),
        expect.objectContaining({ id: "password", kind: "secret" }),
        {
          id: "custom-1",
          kind: "identifier",
          description: "value of the user's vault field named in fieldName",
          fieldName: "会員番号",
          // The Text field's shape, read locally from the synthetic value.
          valueShape: expect.objectContaining({ length: "synthetic-secret".length }),
        },
        {
          id: "custom-2",
          kind: "hidden",
          description:
            "concealed value of the user's vault field named in fieldName, such as a PIN",
          fieldName: "お母さんの旧姓",
        },
      ]);
      // A Hidden field is never shaped, and no value, item name or binding is sent.
      expect(JSON.stringify(service.judge.mock.calls)).not.toContain("synthetic-secret");
      expect(JSON.stringify(service.judge.mock.calls)).not.toContain("Synthetic item");
      expect(JSON.stringify(service.judge.mock.calls)).not.toContain(itemId);
    });
    it("proposes the paired field for the question, and fills nothing before the owner confirms", async () => {
      const { h, report } = await stoppedAtQuestion([pairing]);
      // The login stops at the handler as one with no link.
      expect(report).toHaveBeenCalledWith(
        expect.objectContaining({ type: "handler", kind: "detail", outcome: "detail-unlinked" }),
      );
      expect(answerFills()).toEqual([]);
      expect(h.fields.mock.calls.map(([request]) => request.fieldId)).not.toContain(answerField);
      expect(await detailOf(h)).toEqual({
        ok: true,
        origin,
        offer: {
          documentId: "question-document",
          details: [
            {
              detail: "secret-answer",
              candidates: [
                {
                  connectionId,
                  itemId,
                  fieldId: answerField,
                  itemLabel: "Synthetic item",
                  fieldLabel: "お母さんの旧姓",
                },
              ],
              // As the page showed it, for the owner to recognize.
              question: "母親の旧姓は？",
            },
          ],
        },
        links: [],
      });
      // The pairing is kept for the tab only: in session, never in the settings.
      expect(JSON.stringify(fake.state.session)).toContain("母親の旧姓は");
      expect(h.settings.settings.detailLinks).toBeUndefined();
    });
    it("proposes nothing once the page no longer shows the paired question as it was", async () => {
      const { h } = await stoppedAtQuestion([pairing]);
      fake.state.question = "秘密の質問：母の旧姓は？";
      expect(await detailOf(h)).toEqual({ ok: true, origin, links: [] });
      expect(await fill(h)).toEqual({ ok: false, reason: "not-a-candidate" });
      expect(answerFills()).toEqual([]);
    });
    it("proposes nothing for a pairing whose question is only the label before it", async () => {
      // "Security question" is shown, but as the label of the question, not the question.
      const { h } = await stoppedAtQuestion([{ ...pairing, shown: "秘密の質問" }]);
      expect(await detailOf(h)).toEqual({ ok: true, origin, links: [] });
      expect(await fill(h)).toEqual({ ok: false, reason: "not-a-candidate" });
      expect(answerFills()).toEqual([]);
    });
    it("keeps a pairing with a slot sent for no field, or a question too short, out", async () => {
      const { h } = await stoppedAtQuestion([
        { ...pairing, slot: "password" },
        { ...pairing, field: target("other"), shown: "旧姓?" },
      ]);
      expect(await detailOf(h)).toEqual({ ok: true, origin, links: [] });
    });
    it("stores the confirmed question with the link once signed in, and later logins match it literally", async () => {
      const { h, service } = await stoppedAtQuestion([pairing]);
      expect(await fill(h)).toEqual({ ok: true });
      // The fill goes under the confirmed question, which must show as one whole question.
      expect(answerFills()).toEqual([
        expect.objectContaining({
          type: "login.detail.fill",
          fields: [
            expect.objectContaining({
              target: target("answer"),
              secret: "answer",
              question: { question: "母親の旧姓は" },
            }),
          ],
        }),
      ]);
      expect(h.settings.settings.detailLinks).toBeUndefined();
      // The person submits and the site signs in.
      fake.state.pageUrl = `${origin}/home`;
      fake.state.observedPath = "/home";
      fake.state.present = new Set(["logout"]);
      fake.state.extracted = { "signed-in": homePage };
      await h.hello({ documentId: "document-home" }, false);
      await until(settled("authenticated"), 60_000);
      expect(service.judge).toHaveBeenCalledTimes(1);
      await vi.waitFor(() =>
        expect(h.settings.settings.detailLinks).toEqual([
          {
            origin,
            provider: "bitwarden",
            server: "cloud-us",
            userId,
            itemId,
            detail: "secret-answer",
            source: { itemId, field: { custom: "お母さんの旧姓" } },
            question: "母親の旧姓は",
          },
        ]),
      );

      // A later login of the account, on another day's worker, answers the question from
      // the link, with no model: the account's handler is kept, the session is not.
      for (const listener of fake.state.removed.splice(0)) listener(1);
      fake.state.session = {};

      fake.state.messages = [];
      fake.state.pageUrl = `${origin}/signin`;
      fake.state.observedPath = "/signin";
      fake.state.present = new Set(["password", "login"]);
      clickToQuestion(() => again, "second-question", {
        next: { path: "/home", present: ["logout"], extracted: homePage },
      });
      const again = harness(
        { detailLinks: h.settings.settings.detailLinks! },
        {
          passkeys: noPasskey,
          generation: service,
          username: true,
          custom: [{ name: "お母さんの旧姓", kind: "hidden" }],
        },
      );
      again.recipes.recipe.mockResolvedValue(asked);
      expect(await again.hello({ documentId: "second-login" })).toEqual({ ok: true });
      await until(settled("authenticated"), 60_000);
      expect(service.judge).toHaveBeenCalledTimes(1);
      expect(again.fields.mock.calls.map(([request]) => request.fieldId)).toContain(answerField);
      const typed = fake.state.messages.find(
        (entry) =>
          entry.type === "login.execute" && entry.values?.some((value) => value.slot === "detail"),
      ) as unknown as { values: { slot: string; secret?: string; question?: unknown }[] };
      expect(typed.values).toEqual([
        expect.objectContaining({
          slot: "detail",
          secret: "answer",
          question: { question: "母親の旧姓は" },
        }),
      ]);
      // The page was asked by the stored question only, never the field's name.
      expect(fake.state.messages).toContainEqual(
        expect.objectContaining({
          type: "login.detail.question",
          names: [{ question: "母親の旧姓は" }],
        }),
      );
    });
  });
});
