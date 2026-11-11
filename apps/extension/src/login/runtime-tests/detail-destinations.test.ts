import type { CustomField } from "./harness";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseLoginRecipe, type LoginFieldTarget } from "@pateat/contracts";
import type { LoginGeneration } from "../runtime/deps";
import type { LoginReport } from "../runtime/report";
import { LOGIN_STEP_WAIT_MS } from "../wire";
const fake = await vi.hoisted(async () => (await import("./browser-fake")).createBrowserFake());
vi.mock("wxt/browser", () => ({ browser: fake.browser }));
vi.stubEnv("MODE", "production");
const { createRuntimeTestHarness } = await import("./harness");
const { origin, connectionId, itemId, snapshotId, sender, target, recipe, userId, harness } =
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
  const { completion: _unlearned, ...unlearned } = recipe;
  const plain = parseLoginRecipe(unlearned);
  const home = [{ target: target("logout") }];
  const observation = (path: string, candidates: unknown[]) => ({
    ok: true,
    observation: { version: 1, origin, path, language: "en", complete: true, candidates },
  });
  const homePage = observation("/home", [
    { id: "c1", role: "button", target: target("logout"), label: "Sign out" },
  ]);
  const status = () =>
    fake.state.storage["pateat.login-attempts.v5"] as Record<string, unknown>[] | undefined;
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
      live: Parameters<typeof harness>[1] = {},
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
        { passkeys: noPasskey, generation: service, report, username: true, custom, ...live },
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
    describe("popup detail destination authorization", () => {
      type Check = (
        overrides?: Record<string, unknown>,
        caller?: Record<string, unknown>,
      ) => Promise<unknown>;
      async function duringFill(
        h: ReturnType<typeof harness>,
        inspect: (check: Check) => Promise<void>,
        accepted = true,
      ): Promise<Check> {
        const original = fake.browser.tabs.sendMessage;
        let check: Check | undefined;
        let failure: unknown;
        const spy = vi
          .spyOn(fake.browser.tabs, "sendMessage")
          .mockImplementation(async (tabId, message, options) => {
            if (message["type"] !== "login.detail.fill") return original(tabId, message, options);
            const authorization = {
              version: 1,
              type: "login.detail.authorize",
              token: message["token"],
              fillId: message["fillId"],
              destinations: [],
            };
            check = (overrides = {}, caller = {}) =>
              h.login.handle(
                { ...authorization, ...overrides },
                sender({ documentId: "question-document", ...caller }),
              );
            try {
              await inspect(check);
            } catch (error) {
              failure = error;
            }
            return { ok: (await check()) === true };
          });
        try {
          const result = await fill(h);
          if (failure) throw failure;
          expect(result).toEqual(accepted ? { ok: true } : { ok: false, reason: "not-filled" });
          if (!check) throw new Error("The popup sent no detail fill");
          return check;
        } finally {
          spy.mockRestore();
        }
      }

      it("binds authorization to the document, token, fill and pending request", async () => {
        const { h } = await stoppedAtQuestion([pairing]);
        expect(
          await h.login.handle(
            {
              version: 1,
              type: "login.detail.authorize",
              token: "synthetic-token",
              fillId: "90000000-0000-4000-8000-000000000001",
              destinations: [],
            },
            sender({ documentId: "question-document" }),
          ),
        ).toBe(false);
        const after = await duringFill(h, async (check) => {
          expect(await check()).toBe(true);
          expect(await check({ token: "another-token" })).toBe(false);
          expect(await check({ fillId: "90000000-0000-4000-8000-000000000001" })).toBe(false);
          expect(await check({}, { documentId: "another-document" })).toBe(false);
          expect(await check({}, { frameId: 1 })).toBe(false);
          expect(
            await check(
              {},
              { origin: "https://attacker.example", url: "https://attacker.example/x" },
            ),
          ).toBe(false);
        });
        expect(await after()).toBe(false);
      });

      it("allows the login item's same-site destination and refuses cross-site or insecure ones", async () => {
        const { h } = await stoppedAtQuestion([pairing], undefined, {
          allowedOrigins: [origin, "https://auth.login.example"],
        });
        await duringFill(h, async (check) => {
          expect(await check({ destinations: ["https://auth.login.example/session"] })).toBe(true);
          expect(await check({ destinations: ["https://other.login.example/session"] })).toBe(
            false,
          );
          expect(await check({ destinations: ["https://attacker.example/collect"] })).toBe(false);
          expect(await check({ destinations: ["http://auth.login.example/session"] })).toBe(false);
          expect(await check({ destinations: ["https://user@auth.login.example/session"] })).toBe(
            false,
          );
        });
      });

      it("expires authorization while the fill reply is still pending", async () => {
        const { h } = await stoppedAtQuestion([pairing]);
        await duringFill(
          h,
          async (check) => {
            expect(await check()).toBe(true);
            await vi.advanceTimersByTimeAsync(LOGIN_STEP_WAIT_MS);
            expect(await check()).toBe(false);
          },
          false,
        );
      });

      it("withdraws a pending authorization when settings change", async () => {
        const { h } = await stoppedAtQuestion([pairing]);
        await duringFill(
          h,
          async (check) => {
            expect(await check()).toBe(true);
            h.settings.revision += 1;
            expect(await check()).toBe(false);
          },
          false,
        );
      });

      it("withdraws a pending authorization when its vault snapshot changes", async () => {
        const { h } = await stoppedAtQuestion([pairing]);
        await duringFill(
          h,
          async (check) => {
            expect(await check()).toBe(true);
            h.snapshot.current = "60000000-0000-4000-8000-000000000009";
            expect(await check()).toBe(false);
          },
          false,
        );
      });

      it("withdraws a pending authorization when its document leaves", async () => {
        const { h } = await stoppedAtQuestion([pairing]);
        await duringFill(
          h,
          async (check) => {
            expect(await check()).toBe(true);
            for (const listener of fake.state.removed) listener(1);
            expect(await check()).toBe(false);
          },
          false,
        );
      });
    });

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
