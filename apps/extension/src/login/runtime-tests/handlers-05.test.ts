import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  parseLoginRecipe,
  type DetailLink,
  type LocalSettings,
  type LoginHandler,
} from "@pateat/contracts";
import type { LoginReport } from "../runtime";
const fake = await vi.hoisted(async () => (await import("./browser-fake")).createBrowserFake());
vi.mock("wxt/browser", () => ({ browser: fake.browser }));
vi.stubEnv("MODE", "production");
const { createRuntimeTestHarness } = await import("./harness");
const { origin, connectionId, itemId, target, recipe, userId, otherItemId, harness, realTime } =
  createRuntimeTestHarness(fake);

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
    void parseLoginRecipe({
      ...unlearned,
      completion: home,
      handlers: [detailHandler],
    });

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
    const linkTo = (detail: DetailLink["detail"], source: DetailLink["source"]): DetailLink => ({
      origin,
      provider: "bitwarden",
      server: "cloud-us",
      userId,
      itemId,
      detail,
      source,
    });
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
    describe("a linked card with Bitwarden's re-prompt", () => {
      const documentFills = () =>
        fake.state.messages.filter((entry) => entry.type === "login.detail.fill");
      const listed = { repromptSites: [{ hostname: "login.example", includeSubdomains: false }] };
      const numberLink = linkTo("card-number", { itemId: otherItemId, field: "card.number" });
      const cardReads = (h: ReturnType<typeof harness>) =>
        h.fields.mock.calls.filter(([request]) => request.account.itemId === otherItemId);
      const cardPage = (h: ReturnType<typeof harness>) => {
        asCard(h);
        h.fields.mockImplementation(
          async (request) => cardValues[request.fieldId] ?? "synthetic-secret",
        );
        h.recipes.recipe.mockResolvedValue(
          asking([{ detail: "card-number", target: target("card") }]),
        );
      };
      it("fills it as usual, asking nothing more, in a login started after the master password", async () => {
        realTime();
        onClick({ login: { path: "/confirm", present: ["card", "confirm"] }, confirm: toHome });
        const askMasterPassword = vi.fn(async (_input: unknown) => "verified" as const);
        const h = harness(
          { ...listed, detailLinks: [numberLink] },
          { passkeys: noPasskey, reprompt: true, otherReprompt: true, askMasterPassword },
        );
        cardPage(h);
        fake.state.onReconnect = () => h.hello();
        await h.hello();
        await vi.waitFor(() => expect(status()).toMatchObject([{ state: "authenticated" }]), {
          timeout: 6_000,
        });
        expect(askMasterPassword).toHaveBeenCalledOnce();
        expect(detailFills().map((entry) => entry.values)).toEqual([
          [{ slot: "detail", value: "4000000000000002", secret: "card-number" }],
        ]);
        expect(cardReads(h).map(([request]) => request.fieldId)).toEqual(["card.number"]);
      }, 10_000);
      it("asks before it reads an identity, and fills the very input the login stopped at", async () => {
        realTime();
        // Two inputs ask for the phone's last digits; the first is disabled, so the login
        // stopped at the second, which the fill after the password goes to.
        onClick({
          login: { path: "/confirm", present: ["phone1", "phone2", "confirm"] },
          confirm: toHome,
        });
        fake.state.unusable = new Set(["phone1"]);
        const report = vi.fn<(report: LoginReport) => void>();
        const askMasterPassword = vi.fn(async (_input: unknown) => "verified" as const);
        const h = harness(
          {
            ...listed,
            detailLinks: [linkTo("phone-last-4", { itemId: otherItemId, field: "identity.phone" })],
          },
          { passkeys: noPasskey, report, otherReprompt: true, askMasterPassword },
        );
        // The other item is an identity with a phone number; synthetic number only.
        const original = h.store.handle.getMockImplementation()!;
        h.store.handle.mockImplementation(async () => {
          const response = await original();
          if (response.ok)
            response.catalog.connections[0]!.items[1]!.fields = [
              { id: "identity.phone", label: "phone", name: null, kind: "text" as const },
            ];
          return response;
        });
        h.fields.mockImplementation(async (request) =>
          request.fieldId === "identity.phone" ? "090-0000-5678" : "synthetic-secret",
        );
        h.recipes.recipe.mockResolvedValue(
          asking([
            { detail: "phone-last-4", target: target("phone1") },
            { detail: "phone-last-4", target: target("phone2") },
          ]),
        );
        expect(await h.hello()).toEqual({ ok: true });
        await vi.waitFor(() => expect(documentFills()).toHaveLength(1));
        expect(handlerReports(report)).toEqual([[0, "detail", "detail-reprompt", 2]]);
        expect(askMasterPassword.mock.calls[0]![0]).toMatchObject({
          item: { id: otherItemId, reprompt: true },
        });
        expect(documentFills()[0]).toMatchObject({
          fields: [{ target: target("phone2"), value: "5678", secret: "detail" }],
        });
        expect(cardReads(h).map(([request]) => request.fieldId)).toEqual(["identity.phone"]);
        expect(clicks("confirm")).toBe(0);
      }, 10_000);
      it("reads nothing when the site starts to ask between the input's choice and its fill", async () => {
        onClick({ login: { path: "/confirm", present: ["card", "confirm"] }, confirm: toHome });
        const h = harness(
          { detailLinks: [numberLink] },
          { passkeys: noPasskey, otherReprompt: true },
        );
        cardPage(h);
        // Once the login chose the card input, the settings read list the site, as a change
        // that reached the device in between would.
        let asks = false;
        const original = h.store.handle.getMockImplementation()!;
        h.store.handle.mockImplementation(async () => {
          const response = await original();
          if (response.ok && asks) response.snapshot.settings.repromptSites = listed.repromptSites;
          return response;
        });
        const push = fake.state.messages.push.bind(fake.state.messages);
        fake.state.messages.push = (...entries) => {
          for (const entry of entries)
            if (
              entry.type === "login.observe" &&
              (entry as { require?: string[] }).require?.includes("settable")
            )
              asks = true;
          return push(...entries);
        };
        expect(await h.hello()).toEqual({ ok: true });
        await vi.waitFor(() => expect(asks).toBe(true));
        // The handler was entered for the card input; its fill then meets an item that
        // waits, which it never reads, and the login stops as for a field it may not read.
        await vi.waitFor(
          () =>
            expect(status()).toMatchObject([
              { state: "blocked", outcome: "policy-changed", handlers: [{ index: 0, field: 0 }] },
            ]),
          { timeout: 6_000 },
        );
        expect(cardReads(h)).toEqual([]);
        expect(detailFills()).toEqual([]);
        expect(documentFills()).toEqual([]);
        expect(clicks("confirm")).toBe(0);
      }, 10_000);
    });
    describe("a value split over several inputs (owner, 2026-10-23 12:26 UTC)", () => {
      const splitBirth = {
        detail: "birth-date" as const,
        parts: [
          { part: "year" as const, format: "yyyy" as const, target: target("by") },
          { part: "month" as const, format: "m" as const, target: target("bm") },
          { part: "day" as const, format: "dd" as const, target: target("bd") },
        ],
      };
      const born = parseLoginRecipe({
        ...unlearned,
        completion: home,
        handlers: [{ ...detailHandler, path: "/signin", fields: [splitBirth] }],
      });
      it("chooses a birth date's year, month and day in three selects, made after one read", async () => {
        onClick({
          login: { path: "/signin", present: ["by", "bm", "bd", "confirm"] },
          confirm: toHome,
        });
        const report = vi.fn<(report: LoginReport) => void>();
        const h = harness(
          {
            detailLinks: [
              {
                origin,
                provider: "bitwarden",
                server: "cloud-us",
                userId,
                itemId,
                detail: "birth-date",
                source: { itemId: otherItemId, field: { custom: "生年月日" } },
              },
            ],
          },
          { passkeys: noPasskey, report, otherCustom: [{ name: "生年月日", kind: "text" }] },
        );
        h.fields.mockImplementation(async (request) =>
          request.fieldId.startsWith("custom.") ? "1990-04-05" : "synthetic-secret",
        );
        h.recipes.recipe.mockResolvedValue(born);
        expect(await h.hello()).toEqual({ ok: true });
        await vi.waitFor(() => expect(status()).toMatchObject([{ state: "authenticated" }]), {
          timeout: 6_000,
        });
        // Each part goes to the content script on its own, never the whole date.
        expect(detailFills().map((entry) => entry.values)).toEqual([
          [
            { slot: "detail", value: "1990", secret: "date-part", part: "year" },
            { slot: "detail 2", value: "4", secret: "date-part", part: "month" },
            { slot: "detail 3", value: "05", secret: "date-part", part: "day" },
          ],
        ]);
        expect(JSON.stringify(fake.state.messages)).not.toContain("1990-04-05");
        expect(h.fields.mock.calls.map(([request]) => request.account.itemId)).toEqual([
          itemId,
          otherItemId,
        ]);
        // Its selects are observed as ones a value can be set in before the fill is chosen.
        expect(fake.state.messages).toContainEqual(
          expect.objectContaining({
            type: "login.observe",
            targets: [target("by"), target("bm"), target("bd")],
            require: ["settable", "settable", "settable"],
          }),
        );
        expect(clicks("confirm")).toBe(1);
        expect(handlerReports(report)).toEqual([[0, "detail", "entered", 2]]);
      }, 10_000);
      it("ends as a challenge with nothing chosen when a select has no option for its part", async () => {
        onClick({
          login: { path: "/signin", present: ["by", "bm", "bd", "confirm"] },
          confirm: toHome,
        });
        const report = vi.fn<(report: LoginReport) => void>();
        const h = harness(
          {
            detailLinks: [
              {
                origin,
                provider: "bitwarden",
                server: "cloud-us",
                userId,
                itemId,
                detail: "birth-date",
                source: { itemId: otherItemId, field: { custom: "生年月日" } },
              },
            ],
          },
          { passkeys: noPasskey, report, otherCustom: [{ name: "生年月日", kind: "text" }] },
        );
        h.fields.mockImplementation(async (request) =>
          request.fieldId.startsWith("custom.") ? "1990-04-05" : "synthetic-secret",
        );
        // The content script finds no option for one part before it chooses any.
        const clicked = fake.state.onExecute!;
        fake.state.onExecute = async (message, tabId) => {
          const values = message["values"] as { slot: string }[] | undefined;
          if (values?.some((value) => value.slot === "detail 2"))
            fake.state.executeReply = { ok: false, reason: "value-mismatch" };
          return clicked(message, tabId);
        };
        h.recipes.recipe.mockResolvedValue(born);
        expect(await h.hello()).toEqual({ ok: true });
        // The person finishes the page, so the login is watched as after a judged
        // challenge (ADR 0027).
        await vi.waitFor(
          () => expect(status()).toMatchObject([{ state: "watching", outcome: "challenge" }]),
          { timeout: 6_000 },
        );
        expect(detailFills()).toHaveLength(1);
        expect(clicks("confirm")).toBe(0);
        expect(handlerReports(report)).toEqual([
          [0, "detail", "entered", 2],
          [0, "detail", "detail-unfit", 2],
        ]);
      }, 10_000);
      it("types a card number's digits as groups into four boxes", async () => {
        const boxed = parseLoginRecipe({
          ...unlearned,
          completion: home,
          handlers: [
            {
              ...detailHandler,
              path: "/signin",
              fields: [
                {
                  detail: "card-number" as const,
                  parts: [1, 2, 3, 4].map((part) => ({
                    part,
                    length: 4,
                    target: target(`c${part}`),
                  })),
                },
              ],
            },
          ],
        });
        onClick({
          login: { path: "/signin", present: ["c1", "c2", "c3", "c4", "confirm"] },
          confirm: toHome,
        });
        const h = harness(
          {
            detailLinks: [
              {
                origin,
                provider: "bitwarden",
                server: "cloud-us",
                userId,
                itemId,
                detail: "card-number",
                source: { itemId: otherItemId, field: "card.number" },
              },
            ],
          },
          { passkeys: noPasskey },
        );
        const original = h.store.handle.getMockImplementation()!;
        h.store.handle.mockImplementation(async () => {
          const response = await original();
          if (response.ok)
            response.catalog.connections[0]!.items[1]!.fields = [
              { id: "card.number", label: "number", name: null, kind: "text" as const },
            ];
          return response;
        });
        h.fields.mockImplementation(async (request) =>
          request.fieldId === "card.number" ? "4000 0000 0000 0002" : "synthetic-secret",
        );
        h.recipes.recipe.mockResolvedValue(boxed);
        expect(await h.hello()).toEqual({ ok: true });
        await vi.waitFor(() => expect(status()).toMatchObject([{ state: "authenticated" }]), {
          timeout: 6_000,
        });
        expect(detailFills().map((entry) => entry.values)).toEqual([
          ["4000", "0000", "0000", "0002"].map((value, at) => ({
            slot: at === 0 ? "detail" : `detail ${at + 1}`,
            value,
            secret: "card-number",
            group: 4,
          })),
        ]);
        expect(JSON.stringify(fake.state.messages)).not.toContain("4000000000000002");
        expect(clicks("confirm")).toBe(1);
      }, 10_000);
      function boxedCard(lengths: number[], digits: string) {
        const boxed = parseLoginRecipe({
          ...unlearned,
          completion: home,
          handlers: [
            {
              ...detailHandler,
              path: "/signin",
              fields: [
                {
                  detail: "card-number" as const,
                  parts: lengths.map((length, at) => ({
                    part: at + 1,
                    length,
                    target: target(`c${at + 1}`),
                  })),
                },
              ],
            },
          ],
        });
        const report = vi.fn<(report: LoginReport) => void>();
        const h = harness(
          {
            detailLinks: [
              {
                origin,
                provider: "bitwarden",
                server: "cloud-us",
                userId,
                itemId,
                detail: "card-number",
                source: { itemId: otherItemId, field: "card.number" },
              },
            ],
          },
          { passkeys: noPasskey, report },
        );
        const original = h.store.handle.getMockImplementation()!;
        h.store.handle.mockImplementation(async () => {
          const response = await original();
          if (response.ok)
            response.catalog.connections[0]!.items[1]!.fields = [
              { id: "card.number", label: "number", name: null, kind: "text" as const },
            ];
          return response;
        });
        h.fields.mockImplementation(async (request) =>
          request.fieldId === "card.number" ? digits : "synthetic-secret",
        );
        h.recipes.recipe.mockResolvedValue(boxed);
        return { h, report };
      }
      it("types a 16-digit card number into boxes whose last takes up to 7 digits", async () => {
        onClick({
          login: { path: "/signin", present: ["c1", "c2", "c3", "c4", "confirm"] },
          confirm: toHome,
        });
        const { h } = boxedCard([4, 4, 4, 7], "4000 0000 0000 0002");
        expect(await h.hello()).toEqual({ ok: true });
        await vi.waitFor(() => expect(status()).toMatchObject([{ state: "authenticated" }]), {
          timeout: 6_000,
        });
        // The last group goes only into a box of its input's length.
        expect(detailFills().map((entry) => entry.values)).toEqual([
          [
            { slot: "detail", value: "4000", secret: "card-number", group: 4 },
            { slot: "detail 2", value: "0000", secret: "card-number", group: 4 },
            { slot: "detail 3", value: "0000", secret: "card-number", group: 4 },
            { slot: "detail 4", value: "0002", secret: "card-number", group: 7 },
          ],
        ]);
        expect(clicks("confirm")).toBe(1);
      }, 10_000);
      it("fills nothing, and leaves the page to the person, when the card's digits do not fit its boxes", async () => {
        onClick({ login: { path: "/signin", present: ["c1", "c2", "c3", "confirm"] } });
        // 16 digits leave 8 for a last box of 4.
        const { h, report } = boxedCard([4, 4, 4], "4000 0000 0000 0002");
        expect(await h.hello()).toEqual({ ok: true });
        await vi.waitFor(
          () => expect(status()).toMatchObject([{ state: "watching", outcome: "challenge" }]),
          { timeout: 6_000 },
        );
        expect(detailFills()).toEqual([]);
        expect(clicks("confirm")).toBe(0);
        expect(handlerReports(report)).toEqual([
          [0, "detail", "entered", 2],
          [0, "detail", "detail-unfit", 2],
        ]);
        // A value that does not fit the page is no change of the owner's settings.
        expect(report.mock.calls.map(([entry]) => entry)).not.toContainEqual(
          expect.objectContaining({ outcome: "policy-changed" }),
        );
      }, 10_000);
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
      it.each([
        [
          "a card's expiry date, both reads from the same card item",
          { detail: "card-expiry" as const, format: "mm/yy" as const },
          "card.expMonth",
          { value: "04/31", secret: "detail" },
          ["card.expMonth", "card.expYear"],
          "expMonth / expYear",
        ],
        [
          "a card's whole number",
          { detail: "card-number" as const },
          "card.number",
          { value: "4000000000000002", secret: "card-number" },
          ["card.number"],
          "number",
        ],
      ])(
        "fills %s on the page's own path, with the login item's username",
        async (_label, asked, fieldId, filled, read, fieldLabel) => {
          const h = await stopped([{ ...asked, target: target("card") }], { username: true });
          asCard(h);
          h.fields.mockImplementation(
            async (request) => cardValues[request.fieldId] ?? "synthetic-secret",
          );
          const offered = await h.login.handle(
            { version: 1, type: "login.detail.get", tabId: 1 },
            popup,
          );
          expect(offered).toMatchObject({
            ok: true,
            offer: {
              details: [
                {
                  detail: asked.detail,
                  candidates: [{ itemId: otherItemId, fieldId, fieldLabel }],
                },
              ],
            },
          });
          h.fields.mockClear();
          expect(await fill(h, asked.detail, otherItemId, fieldId)).toEqual({ ok: true });
          expect(popupFills()).toEqual([
            expect.objectContaining({
              path: "/confirm",
              fields: [{ target: target("card"), ...filled }],
              account: { username: cardValues["login.username"] },
            }),
          ]);
          expect(
            h.fields.mock.calls.map(([request]) => [request.account.itemId, request.fieldId]),
          ).toEqual([[itemId, "login.username"], ...read.map((id) => [otherItemId, id])]);
          // The link is kept for the tab until the login is confirmed.
          expect(
            await h.login.handle({ version: 1, type: "login.detail.get", tabId: 1 }, popup),
          ).toMatchObject({ links: [{ detail: asked.detail, fieldLabel, pending: true }] });
        },
        10_000,
      );
      describe("a card with Bitwarden's re-prompt", () => {
        const listed = {
          repromptSites: [{ hostname: "login.example", includeSubdomains: false }],
        };
        const cardReads = (h: ReturnType<typeof harness>) =>
          h.fields.mock.calls
            .filter(([request]) => request.account.itemId === otherItemId)
            .map(([request]) => request.fieldId);
        async function proposed(
          overrides: Partial<LocalSettings>,
          askMasterPassword?: NonNullable<Parameters<typeof harness>[1]>["askMasterPassword"],
        ) {
          realTime();
          const h = await stopped(
            [{ detail: "card-number", target: target("card") }],
            { otherReprompt: true, ...(askMasterPassword ? { askMasterPassword } : {}) },
            overrides,
          );
          asCard(h);
          h.fields.mockImplementation(
            async (request) => cardValues[request.fieldId] ?? "synthetic-secret",
          );
          // It is proposed on either site.
          expect(
            await h.login.handle({ version: 1, type: "login.detail.get", tabId: 1 }, popup),
          ).toMatchObject({
            offer: {
              details: [{ candidates: [{ itemId: otherItemId, fieldId: "card.number" }] }],
            },
          });
          h.fields.mockClear();
          return h;
        }
        it("fills it without asking on a site that does not ask", async () => {
          const askMasterPassword = vi.fn(async (_input: unknown) => "verified" as const);
          const h = await proposed({}, askMasterPassword);
          expect(await fill(h, "card-number", otherItemId, "card.number")).toEqual({ ok: true });
          expect(askMasterPassword).not.toHaveBeenCalled();
          expect(cardReads(h)).toEqual(["card.number"]);
          expect(popupFills()).toHaveLength(1);
        }, 10_000);
        it("asks for the master password on a site that asks, then fills it", async () => {
          const askMasterPassword = vi.fn(async (_input: unknown) => "verified" as const);
          const h = await proposed(listed, askMasterPassword);
          expect(await fill(h, "card-number", otherItemId, "card.number")).toEqual({ ok: true });
          expect(askMasterPassword).toHaveBeenCalledOnce();
          expect(askMasterPassword.mock.calls[0]![0]).toMatchObject({
            item: { id: otherItemId, reprompt: true },
          });
          expect(cardReads(h)).toEqual(["card.number"]);
          expect(popupFills()).toEqual([
            expect.objectContaining({
              fields: [
                { target: target("card"), value: "4000000000000002", secret: "card-number" },
              ],
            }),
          ]);
          // The login now holds the password: a second Fill asks nothing.
          expect(await fill(h, "card-number", otherItemId, "card.number")).toEqual({ ok: true });
          expect(askMasterPassword).toHaveBeenCalledOnce();
        }, 10_000);
        it.each([["closed" as const], ["unavailable" as const]])(
          "reads and fills nothing when the window answers %s",
          async (given) => {
            const askMasterPassword = vi.fn(async (_input: unknown) => given);
            const h = await proposed(listed, askMasterPassword);
            expect(await fill(h, "card-number", otherItemId, "card.number")).toEqual({
              ok: false,
              reason: "no-master-password",
            });
            expect(cardReads(h)).toEqual([]);
            expect(popupFills()).toEqual([]);
          },
          10_000,
        );
        it("reads and fills nothing where no window can ask", async () => {
          const h = await proposed(listed);
          expect(await fill(h, "card-number", otherItemId, "card.number")).toEqual({
            ok: false,
            reason: "no-master-password",
          });
          expect(cardReads(h)).toEqual([]);
          expect(popupFills()).toEqual([]);
        }, 10_000);
        it("opens one window for two Fills at once, and fills for both once it is answered", async () => {
          let answer!: (value: "verified") => void;
          const askMasterPassword = vi.fn(
            (_input: unknown) => new Promise<"verified">((resolve) => (answer = resolve)),
          );
          const h = await proposed(listed, askMasterPassword);
          const first = fill(h, "card-number", otherItemId, "card.number");
          const second = fill(h, "card-number", otherItemId, "card.number");
          await vi.waitFor(() => expect(askMasterPassword).toHaveBeenCalledOnce());
          expect(cardReads(h)).toEqual([]);
          answer("verified");
          expect(await first).toEqual({ ok: true });
          expect(await second).toEqual({ ok: true });
          expect(askMasterPassword).toHaveBeenCalledOnce();
          expect(popupFills()).toHaveLength(2);
        }, 10_000);
        it("reads and fills nothing when another document replaces the page while the window asks", async () => {
          const signals: AbortSignal[] = [];
          // The window answers as if the password were right even once it was closed, so
          // only the closing stops the read.
          const askMasterPassword = vi.fn(
            (input: { signal: AbortSignal }) =>
              new Promise<"verified">((resolve) => {
                signals.push(input.signal);
                input.signal.addEventListener("abort", () => resolve("verified"));
              }),
          );
          const h = await proposed(listed, askMasterPassword);
          const filling = fill(h, "card-number", otherItemId, "card.number");
          await vi.waitFor(() => expect(askMasterPassword).toHaveBeenCalledOnce());
          await h.hello({ documentId: "second-document" });
          expect(await filling).toEqual({ ok: false, reason: "no-master-password" });
          expect(signals[0]!.aborted).toBe(true);
          expect(cardReads(h)).toEqual([]);
          expect(popupFills()).toEqual([]);
        }, 10_000);
      });
      it("offers and fills a card expiry split over two selects as its one link", async () => {
        // Owner, 2026-10-23 12:26 UTC: a split value is offered like its one-input form.
        const h = await stopped(
          [
            {
              detail: "card-expiry",
              parts: [
                { part: "month", format: "mm", target: target("em") },
                { part: "year", format: "yy", target: target("ey") },
              ],
            },
          ],
          { username: true },
        );
        asCard(h);
        h.fields.mockImplementation(
          async (request) => cardValues[request.fieldId] ?? "synthetic-secret",
        );
        const offered = await h.login.handle(
          { version: 1, type: "login.detail.get", tabId: 1 },
          popup,
        );
        expect(offered).toMatchObject({
          offer: {
            details: [
              {
                detail: "card-expiry",
                candidates: [{ itemId: otherItemId, fieldId: "card.expMonth" }],
              },
            ],
          },
        });
        expect(await fill(h, "card-expiry", otherItemId, "card.expMonth")).toEqual({ ok: true });
        // Each select gets only its own part, checked as settable before the fill.
        expect(popupFills()).toEqual([
          expect.objectContaining({
            path: "/confirm",
            fields: [
              { target: target("em"), value: "04", secret: "date-part", part: "month" },
              {
                target: target("ey"),
                value: "31",
                secret: "date-part",
                part: "year",
                shortYear: true,
              },
            ],
          }),
        ]);
        expect(fake.state.messages).toContainEqual(
          expect.objectContaining({
            type: "login.observe",
            targets: [target("em"), target("ey"), target("confirm")],
            require: ["settable", "settable", "shown"],
          }),
        );
        expect(
          await h.login.handle({ version: 1, type: "login.detail.get", tabId: 1 }, popup),
        ).toMatchObject({ links: [{ detail: "card-expiry", pending: true }] });
      }, 10_000);
    });
  });
});
