import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseLoginRecipe, type LocalSettings, type LoginStep } from "@pateat/contracts";
import type { LiveUriMatcher } from "../../vault/site-candidates";
import type { LoginReport } from "../runtime";
const fake = await vi.hoisted(async () => (await import("./browser-fake")).createBrowserFake());
vi.mock("wxt/browser", () => ({ browser: fake.browser }));
vi.stubEnv("MODE", "production");
const { createRuntimeTestHarness, createLoginRuntime } = await import("./harness");
const {
  origin,
  connectionId,
  itemId,
  sender,
  target,
  startsOf,
  recipe,
  uriMatch,
  harness,
  realTime,
} = createRuntimeTestHarness(fake);

describe("production login document admission", () => {
  afterEach(() => {
    // Close every test's tabs, so no attempt left reconciling answers a later test.
    for (const listener of fake.state.removed.splice(0))
      for (const tabId of [1, 2, 3, 4]) listener(tabId);
    fake.state.replaced.length = 0;
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
    fake.state.present = undefined;
    fake.state.unusable = new Set();
    fake.state.unobservable = new Set();
    fake.state.disabled = new Set();
    fake.state.awaited = { ok: true };
    fake.state.onAwait = undefined;
    fake.state.executeReply = undefined;
    fake.state.switchReply = { ok: true };
    fake.state.chosen = { ok: true, click: "entry" };
    fake.state.siteAccount = { ok: false };
    fake.state.gone = new Set();
    fake.state.extracted = {};
    fake.state.signs = undefined;
    fake.state.loaded = true;
    fake.state.incognito = new Set();
    fake.state.openTabs = undefined;
  });
  it("completes a saved-default HTTPS login with a local recipe and live field", async () => {
    const h = harness();
    expect(await h.hello()).toEqual({ ok: true });
    await vi.waitFor(() =>
      expect(fake.state.messages.filter((entry) => entry.type === "login.execute")).toHaveLength(2),
    );
    expect(h.fields).toHaveBeenCalledTimes(1);
    // The saved default and binding are already stored, so nothing is written back.
    await vi.waitFor(() =>
      expect(fake.state.messages.filter((entry) => entry.type === "login.observe")).not.toEqual([]),
    );
    expect(h.store.update).not.toHaveBeenCalled();
    // The content script fills a Bitwarden password only into a password input.
    expect(fake.state.messages.find((entry) => entry.type === "login.execute")?.values).toEqual([
      { slot: "password", value: "synthetic-secret", secret: "password" },
    ]);
    expect(h.fields.mock.calls[0]![0]).toMatchObject({
      account: { origin, connectionId, itemId },
      fieldId: "login.password",
    });
    // An item without a username never asks the page to compare the shown account.
    expect(
      fake.state.messages.filter((entry) => entry.type === "login.execute" && entry.account),
    ).toEqual([]);
  });
  describe("Bitwarden master password re-prompt", () => {
    const executed = () => fake.state.messages.filter((entry) => entry.type === "login.execute");
    const listed = { repromptSites: [{ hostname: "login.example", includeSubdomains: false }] };
    const popupSender = {
      id: "synthetic-extension",
      url: "chrome-extension://synthetic-extension/popup.html",
    } as never;
    it("uses a re-prompt item as any other on a site that does not ask", async () => {
      const askMasterPassword = vi.fn(async () => "verified" as const);
      const h = harness({}, { reprompt: true, askMasterPassword });
      expect(await h.hello()).toEqual({ ok: true });
      await vi.waitFor(() => expect(executed()).toHaveLength(2));
      expect(askMasterPassword).not.toHaveBeenCalled();
    });
    it("fills nothing until the master password is entered, then starts the login once", async () => {
      realTime();
      let answer!: (value: "verified") => void;
      const askMasterPassword = vi.fn(
        (_input: unknown) => new Promise<"verified">((resolve) => (answer = resolve)),
      );
      const h = harness(listed, { reprompt: true, askMasterPassword });
      fake.state.onReconnect = () => h.hello();
      await h.hello();
      await vi.waitFor(() => expect(askMasterPassword).toHaveBeenCalledOnce());
      expect(askMasterPassword.mock.calls[0]![0]).toMatchObject({
        tabId: 1,
        origin,
        account: { connectionId, itemId },
        connection: { id: connectionId },
        item: { id: itemId, reprompt: true },
      });
      // A document announcing again while the window asks opens no second window.
      await h.hello();
      expect(askMasterPassword).toHaveBeenCalledOnce();
      expect(executed()).toEqual([]);
      expect(h.fields).not.toHaveBeenCalled();
      expect(
        await h.login.handle({ version: 1, type: "login.status.get", tabId: 1 }, popupSender),
      ).toMatchObject({ page: { state: "denied", reason: "master-password-reprompt" } });
      answer("verified");
      await vi.waitFor(() => expect(fake.state.reconnects).toHaveLength(1));
      await vi.waitFor(() => expect(executed()).toHaveLength(2));
      expect(askMasterPassword).toHaveBeenCalledOnce();
      // The grant is used up: the next page of the site asks again.
      fake.state.messages = [];
      await h.hello({ documentId: "second-document" });
      await vi.waitFor(() => expect(askMasterPassword).toHaveBeenCalledTimes(2));
    });
    it("asks again once the grant expires unused", async () => {
      const askMasterPassword = vi.fn(async (_input: unknown) => "verified" as const);
      const h = harness(listed, { reprompt: true, askMasterPassword });
      // The document does not announce again in time, as a page still loading.
      fake.state.onReconnect = async () => ({ ok: true });
      await h.hello();
      await vi.waitFor(() => expect(fake.state.reconnects).toHaveLength(1));
      await vi.advanceTimersByTimeAsync(61_000);
      await h.hello();
      await vi.waitFor(() => expect(askMasterPassword).toHaveBeenCalledTimes(2));
      expect(executed()).toEqual([]);
    });
    it("closes the window of a document another document replaced, which then asks", async () => {
      realTime();
      const signals: AbortSignal[] = [];
      const askMasterPassword = vi.fn(
        (input: { signal: AbortSignal }) =>
          new Promise<"closed">((resolve) => {
            signals.push(input.signal);
            input.signal.addEventListener("abort", () => resolve("closed"));
          }),
      );
      const h = harness(listed, { reprompt: true, askMasterPassword });
      await h.hello();
      await vi.waitFor(() => expect(askMasterPassword).toHaveBeenCalledOnce());
      await h.hello({ documentId: "second-document" });
      await vi.waitFor(() => expect(askMasterPassword).toHaveBeenCalledTimes(2));
      expect(signals[0]!.aborted).toBe(true);
      expect(signals[1]!.aborted).toBe(false);
      expect(executed()).toEqual([]);
    });
    it("asks in a new window when the document comes back before its closed window ends", async () => {
      realTime();
      const signals: AbortSignal[] = [];
      const ends: (() => void)[] = [];
      // A closed window ends only some time after it was told to close.
      const askMasterPassword = vi.fn(
        (input: { signal: AbortSignal }) =>
          new Promise<"closed">((resolve) => {
            signals.push(input.signal);
            ends.push(() => resolve("closed"));
          }),
      );
      const h = harness(listed, { reprompt: true, askMasterPassword });
      await h.hello();
      await vi.waitFor(() => expect(askMasterPassword).toHaveBeenCalledOnce());
      await h.hello({ documentId: "second-document" });
      await vi.waitFor(() => expect(askMasterPassword).toHaveBeenCalledTimes(2));
      // The first document comes back, as from the back-forward cache, while its window
      // still closes.
      await h.hello();
      await vi.waitFor(() => expect(askMasterPassword).toHaveBeenCalledTimes(3));
      expect(signals.map((signal) => signal.aborted)).toEqual([true, true, false]);
      expect(askMasterPassword.mock.calls[2]![0]).toMatchObject({ tabId: 1, origin });
      for (const end of ends) end();
      expect(executed()).toEqual([]);
    });
    it("asks again from the popup after the window was closed", async () => {
      realTime();
      const askMasterPassword = vi
        .fn<NonNullable<Parameters<typeof createLoginRuntime>[1]["askMasterPassword"]>>()
        .mockResolvedValueOnce("closed")
        .mockResolvedValueOnce("verified");
      const h = harness(listed, { reprompt: true, askMasterPassword });
      fake.state.onReconnect = () => h.hello();
      await h.hello();
      await vi.waitFor(() => expect(askMasterPassword).toHaveBeenCalledOnce());
      expect(executed()).toEqual([]);
      expect(
        await h.login.handle({ version: 1, type: "login.reprompt.ask", tabId: 1 }, popupSender),
      ).toEqual({ ok: true });
      await vi.waitFor(() => expect(executed()).toHaveLength(2));
      // Nothing waits any more.
      expect(
        await h.login.handle({ version: 1, type: "login.reprompt.ask", tabId: 1 }, popupSender),
      ).toEqual({ ok: false, reason: "not-waiting" });
    });
    it("starts nothing when no window can ask", async () => {
      realTime();
      const h = harness(listed, { reprompt: true });
      await h.hello();
      expect(
        await h.login.handle({ version: 1, type: "login.reprompt.ask", tabId: 1 }, popupSender),
      ).toEqual({ ok: false, reason: "unavailable" });
      expect(executed()).toEqual([]);
      expect(h.fields).not.toHaveBeenCalled();
    });
  });
  it("sends the username with a password-only fill and stops on a wrong displayed account", async () => {
    fake.state.executeReply = { ok: false, reason: "wrong-account" };
    const h = harness({}, { username: true });
    h.fields.mockImplementation(async ({ fieldId }) =>
      fieldId === "login.username" ? "my2@example.com" : "synthetic-secret",
    );
    expect(await h.hello()).toEqual({ ok: true });
    await vi.waitFor(() =>
      expect(fake.state.storage["pateat.login-attempts.v5"]).toMatchObject([
        { state: "blocked", outcome: "wrong-account", submissions: 0, retries: 0 },
      ]),
    );
    const executes = fake.state.messages.filter((entry) => entry.type === "login.execute");
    // The fill is refused once and never retried; the click never runs.
    expect(executes).toHaveLength(1);
    expect(executes[0]!.account).toEqual({ username: "my2@example.com" });
    expect(h.fields.mock.calls.map(([request]) => request.fieldId)).toEqual([
      "login.password",
      "login.username",
    ]);
  });
  it("clicks the recipe's account switch only after recording it, then starts afresh once", async () => {
    const accountSwitch = { by: "text", value: "Use another account" } as const;
    fake.state.executeReply = { ok: false, reason: "wrong-account", switchable: true };
    const h = harness({}, { username: true });
    h.recipes.recipe.mockResolvedValue(parseLoginRecipe({ ...recipe, accountSwitch }));
    h.fields.mockImplementation(async ({ fieldId }) =>
      fieldId === "login.username" ? "my2@example.com" : "synthetic-secret",
    );
    const attempts = () => fake.state.storage["pateat.login-attempts.v5"];
    const types = () => fake.state.messages.map((entry) => entry.type);
    expect(await h.hello()).toEqual({ ok: true });
    await vi.waitFor(() => expect(types()).toContain("login.switch"));
    expect(attempts()).toMatchObject([
      { state: "blocked", outcome: "account-switched", submissions: 0 },
    ]);
    const executes = () => fake.state.messages.filter((entry) => entry.type === "login.execute");
    expect(executes()[0]!.accountSwitch).toEqual(accountSwitch);
    // The switch is stored and published before the page is asked to click it.
    expect(
      fake.state.messages.findIndex((entry) => entry.outcome === "account-switched"),
    ).toBeLessThan(types().indexOf("login.switch"));
    // The page it leads to starts a new attempt, which never switches again.
    expect(await h.hello({ documentId: "next-page" })).toEqual({ ok: true });
    await vi.waitFor(() =>
      expect(attempts()).toMatchObject([
        { state: "blocked", outcome: "wrong-account", accountSwitched: true },
      ]),
    );
    expect(executes()).toHaveLength(2);
    expect(executes()[1]!.accountSwitch).toBeUndefined();
    expect(types().filter((type) => type === "login.switch")).toHaveLength(1);
  });
  it("asks for the page's own switch without a recipe target, and takes the same document again only when it switched in place (ADR 0078)", async () => {
    fake.state.executeReply = { ok: false, reason: "wrong-account", switchable: true };
    const h = harness({}, { username: true });
    h.fields.mockImplementation(async ({ fieldId }) =>
      fieldId === "login.username" ? "my2@example.com" : "synthetic-secret",
    );
    const attempts = () => fake.state.storage["pateat.login-attempts.v5"];
    const types = () => fake.state.messages.map((entry) => entry.type);
    const executes = () =>
      fake.state.messages.filter((entry) => entry.type === "login.execute") as {
        otherSwitch?: true;
        accountSwitch?: unknown;
      }[];
    expect(await h.hello()).toEqual({ ok: true });
    await vi.waitFor(() => expect(types()).toContain("login.switch"));
    expect(executes()[0]).toMatchObject({ otherSwitch: true });
    expect(executes()[0]!.accountSwitch).toBeUndefined();
    expect(attempts()).toMatchObject([{ state: "blocked", outcome: "account-switched" }]);
    // The same document announcing again without the mark, as a slow navigation's old
    // page does, is not a new page.
    expect(await h.hello()).toEqual({ ok: false, reason: "duplicate-document" });
    expect(await h.hello({}, true, true)).toEqual({ ok: true });
    await vi.waitFor(() =>
      expect(attempts()).toMatchObject([
        { state: "blocked", outcome: "wrong-account", accountSwitched: true },
      ]),
    );
    expect(executes()).toHaveLength(2);
    // The attempt carrying the switch never asks for another.
    expect(executes()[1]!.otherSwitch).toBeUndefined();
    expect(types().filter((type) => type === "login.switch")).toHaveLength(1);
  });
  describe("a software keyboard that submits by itself (ADR 0067)", () => {
    const keypadRecipe = parseLoginRecipe({
      ...recipe,
      steps: [
        {
          kind: "fill",
          path: "/signin",
          fields: [
            { slot: "password", target: target("password"), keypad: { by: "id", value: "keys" } },
          ],
        },
        recipe.steps[1],
      ],
    });
    const attempts = () => fake.state.storage["pateat.login-attempts.v5"];
    const executed = () =>
      fake.state.messages
        .filter((entry) => entry.type === "login.execute")
        .map((entry) => (entry as unknown as { operation: { step: LoginStep } }).operation.step);
    it("takes the page's own submission after a key press for the click", async () => {
      // The page took the field away after a press, as a PIN pad that submits at its last
      // digit does, and shows that it signed in.
      fake.state.onExecute = async () => {
        fake.state.executeReply = { ok: false, reason: "submitted", mutation: "possible" };
        fake.state.present = new Set(["authenticated"]);
      };
      const h = harness();
      h.recipes.recipe.mockResolvedValue(keypadRecipe);
      expect(await h.hello()).toEqual({ ok: true });
      await vi.waitFor(() =>
        expect(attempts()).toMatchObject([{ state: "authenticated", submissions: 1 }]),
      );
      expect(executed().map((step) => step.kind)).toEqual(["fill"]);
    });
    it.each([false, true])(
      "takes a page replaced during the keypad fill for its submission only after the page told of a key press (%s)",
      async (pressed) => {
        const h = harness();
        h.recipes.recipe.mockResolvedValue(keypadRecipe);
        const answers: unknown[] = [];
        let held = false;
        fake.state.onExecute = async (message) => {
          const operation = message["operation"] as {
            attemptId: string;
            operationId: string;
            step: LoginStep;
          };
          if (operation.step.kind !== "fill") return;
          if (pressed)
            answers.push(
              await h.login.handle(
                {
                  version: 1,
                  type: "login.keypad.press",
                  token: "synthetic-token",
                  attemptId: operation.attemptId,
                  operationId: operation.operationId,
                },
                sender(),
              ),
            );
          // The document is replaced before the fill answers, as by a PIN pad that
          // submits at its last digit, or by the person's own link click.
          held = true;
          await new Promise(() => undefined);
        };
        expect(await h.hello()).toEqual({ ok: true });
        await vi.waitFor(() => expect(held).toBe(true));
        expect(answers).toEqual(pressed ? [true] : []);
        fake.state.onExecute = undefined;
        expect(await h.hello({ documentId: "next-page" })).toEqual({ ok: true });
        await vi.waitFor(() =>
          expect(attempts()).toMatchObject([
            pressed ? { submissions: 1, operationKind: "click" } : { submissions: 0, stepIndex: 0 },
          ]),
        );
        // The page's own click is never pressed after a replaced keypad page.
        expect(executed().map((step) => step.kind)).toEqual(["fill"]);
      },
    );
    const press = (h: ReturnType<typeof harness>, message: Record<string, unknown>) => {
      const operation = message["operation"] as { attemptId: string; operationId: string };
      return h.login.handle(
        {
          version: 1,
          type: "login.keypad.press",
          token: "synthetic-token",
          attemptId: operation.attemptId,
          operationId: operation.operationId,
        },
        sender(),
      );
    };
    it.each([false, true])(
      "takes a page replaced after the keypad fill went in and before its click for its submission only after a key press (%s)",
      async (pressed) => {
        const h = harness();
        h.recipes.recipe.mockResolvedValue(keypadRecipe);
        fake.state.onExecute = async (message) => {
          if (pressed) await press(h, message);
        };
        // The fill answered; the click's wait for its button holds, and the page that
        // submitted at its last digit is replaced meanwhile.
        let waiting = false;
        fake.state.awaitReply = () => {
          if (executed().length === 0) return undefined;
          waiting = true;
          return new Promise(() => undefined) as never;
        };
        expect(await h.hello()).toEqual({ ok: true });
        await vi.waitFor(() => expect(waiting).toBe(true));
        expect(attempts()).toMatchObject([{ stepIndex: 1, submissions: 0 }]);
        fake.state.onExecute = undefined;
        fake.state.awaitReply = undefined;
        expect(await h.hello({ documentId: "next-page" })).toEqual({ ok: true });
        await vi.waitFor(() =>
          expect(attempts()).toMatchObject([
            pressed
              ? { submissions: 1, operationKind: "click" }
              : { submissions: 0, outcome: "interrupted" },
          ]),
        );
        if (pressed) expect(executed().map((step) => step.kind)).toEqual(["fill"]);
      },
    );
    it("takes no page after a keypad stop that pressed keys for a submission", async () => {
      // The fill stopped after a key press, as when the page redrew its field; the person
      // reloads the page as told while the login still waits for the page's result.
      fake.state.executeReply = {
        ok: false,
        reason: "structural-mismatch",
        mutation: "possible",
        detail: "keypad-pressed",
      };
      const h = harness();
      h.recipes.recipe.mockResolvedValue(keypadRecipe);
      const answers: unknown[] = [];
      fake.state.onExecute = async (message) => {
        answers.push(await press(h, message));
      };
      expect(await h.hello()).toEqual({ ok: true });
      await vi.waitFor(() =>
        expect(attempts()).toMatchObject([
          { state: "reconciling", outcome: "structural-mismatch" },
        ]),
      );
      expect(answers).toEqual([true]);
      fake.state.onExecute = undefined;
      expect(await h.hello({ documentId: "reloaded" })).toEqual({ ok: true });
      await vi.waitFor(() =>
        expect(attempts()).toMatchObject([{ document: { documentId: "reloaded" } }]),
      );
      expect(attempts()).toMatchObject([{ submissions: 0 }]);
      expect(executed().map((step) => step.kind)).toEqual(["fill"]);
    });
    it("refuses a key press notice for a step that is no keypad fill", async () => {
      const h = harness();
      const answers: unknown[] = [];
      fake.state.onExecute = async (message) => {
        const operation = message["operation"] as { attemptId: string; operationId: string };
        answers.push(
          await h.login.handle(
            {
              version: 1,
              type: "login.keypad.press",
              token: "synthetic-token",
              attemptId: operation.attemptId,
              operationId: operation.operationId,
            },
            sender(),
          ),
        );
        fake.state.onExecute = undefined;
      };
      expect(await h.hello()).toEqual({ ok: true });
      await vi.waitFor(() => expect(answers).toHaveLength(1));
      expect(answers).toEqual([false]);
    });
    it("takes no missing key for a submission", async () => {
      fake.state.executeReply = {
        ok: false,
        reason: "structural-mismatch",
        mutation: "possible",
        detail: "keypad-key-missing",
      };
      const h = harness();
      h.recipes.recipe.mockResolvedValue(keypadRecipe);
      expect(await h.hello()).toEqual({ ok: true });
      // The fill failed after the field was pressed, so its result is waited for as after
      // any fill that may have changed the page, with no submission counted.
      await vi.waitFor(() =>
        expect(attempts()).toMatchObject([
          { outcome: "structural-mismatch", submissions: 0, operationKind: "fill" },
        ]),
      );
      expect(executed().map((step) => step.kind)).toEqual(["fill"]);
    });
  });
  it("ends as wrong-account and keeps the tab when the page does not click the switch", async () => {
    fake.state.executeReply = { ok: false, reason: "wrong-account", switchable: true };
    fake.state.switchReply = { ok: false };
    const h = harness({}, { username: true });
    h.recipes.recipe.mockResolvedValue(
      parseLoginRecipe({ ...recipe, accountSwitch: { by: "text", value: "Use another account" } }),
    );
    h.fields.mockImplementation(async ({ fieldId }) =>
      fieldId === "login.username" ? "my2@example.com" : "synthetic-secret",
    );
    const executes = () => fake.state.messages.filter((entry) => entry.type === "login.execute");
    expect(await h.hello()).toEqual({ ok: true });
    await vi.waitFor(() =>
      expect(fake.state.storage["pateat.login-attempts.v5"]).toMatchObject([
        { state: "blocked", outcome: "wrong-account", submissions: 0 },
      ]),
    );
    expect(fake.state.messages.map((entry) => entry.type)).toContain("login.switch");
    expect(fake.state.messages.at(-1)).toMatchObject({ outcome: "wrong-account" });
    // The next document of the tab does not start another attempt.
    await h.hello({ documentId: "next-page" });
    expect(executes()).toHaveLength(1);
  });
  it("stops without a retry or a click when a value does not fit its input", async () => {
    fake.state.executeReply = { ok: false, reason: "value-mismatch" };
    const h = harness();
    expect(await h.hello()).toEqual({ ok: true });
    await vi.waitFor(() =>
      expect(fake.state.storage["pateat.login-attempts.v5"]).toMatchObject([
        { state: "blocked", outcome: "value-mismatch", submissions: 0, retries: 0 },
      ]),
    );
    expect(fake.state.messages.filter((entry) => entry.type === "login.execute")).toHaveLength(1);
    expect(fake.state.messages.at(-1)).toMatchObject({ outcome: "value-mismatch" });
  });
  it.each(["target-missing", "form-changed"] as const)(
    "logs the page's reason when a step fails with %s",
    async (detail) => {
      fake.state.executeReply = { ok: false, reason: "structural-mismatch", detail };
      const report = vi.fn<(report: LoginReport) => void>();
      const h = harness({}, { report });
      expect(await h.hello()).toEqual({ ok: true });
      await vi.waitFor(() =>
        expect(report).toHaveBeenCalledWith(
          expect.objectContaining({ type: "attempt", cause: detail }),
        ),
      );
    },
  );
  describe("telling of a login that signed in (ADR 0007)", () => {
    const attempts = () =>
      (fake.state.storage["pateat.login-attempts.v5"] ?? []) as { state: string }[];
    it("tells once when a login reaches signed in, and not again on the tab's next page", async () => {
      const signedIn = vi.fn<(tabId: number, origin: string) => void>();
      const h = harness({}, { signedIn });
      expect(await h.hello()).toEqual({ ok: true });
      await vi.waitFor(() => expect(attempts()).toMatchObject([{ state: "authenticated" }]));
      expect(signedIn.mock.calls).toEqual([[1, origin]]);
      // The tab's next page of the site, without its form, starts nothing and tells nothing.
      await h.hello({ documentId: "next-page" }, false);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(signedIn).toHaveBeenCalledOnce();
    });
    it.each([
      ["a wrong account", { ok: false, reason: "wrong-account" }],
      ["a value the page rejects", { ok: false, reason: "value-mismatch" }],
    ])("never tells of a login stopped by %s", async (_name, reply) => {
      fake.state.executeReply = reply;
      const states: string[] = [];
      const signedIn = vi.fn<(tabId: number, origin: string) => void>();
      const h = harness(
        {},
        {
          signedIn,
          report: (entry) => {
            if (entry.type === "attempt") states.push(entry.state);
          },
        },
      );
      expect(await h.hello()).toEqual({ ok: true });
      await vi.waitFor(() => expect(attempts()).toMatchObject([{ state: "blocked" }]));
      expect(states.length).toBeGreaterThan(1);
      expect(signedIn).not.toHaveBeenCalled();
    });
    it("never tells of a login whose completion is not seen", async () => {
      fake.state.observed = ["missing", "missing"];
      const signedIn = vi.fn<(tabId: number, origin: string) => void>();
      const h = harness({}, { signedIn });
      expect(await h.hello()).toEqual({ ok: true });
      await vi.waitFor(() =>
        expect(fake.state.messages.filter((entry) => entry.type === "login.execute")).toHaveLength(
          2,
        ),
      );
      // Wait for the observation budget to end without seeing the completion.
      await vi.waitFor(
        () =>
          expect(attempts()).toMatchObject([
            { state: "reconciling", outcome: "unknown-submit", settled: true },
          ]),
        { timeout: 6_000 },
      );
      expect(signedIn).not.toHaveBeenCalled();
    }, 10_000);
    it("completes the login when telling of it throws", async () => {
      const signedIn = vi.fn(() => {
        throw new Error("storage");
      });
      const h = harness({}, { signedIn });
      expect(await h.hello()).toEqual({ ok: true });
      await vi.waitFor(() => expect(attempts()).toMatchObject([{ state: "authenticated" }]));
      expect(signedIn).toHaveBeenCalledOnce();
      expect(await h.login.active()).toBe(false);
    });
  });
  it("does not click when the page rejects the filled values", async () => {
    fake.state.executeReply = { ok: false, reason: "fill-rejected", mutation: "possible" };
    const h = harness();
    expect(await h.hello()).toEqual({ ok: true });
    await vi.waitFor(() =>
      expect(fake.state.storage["pateat.login-attempts.v5"]).toMatchObject([
        { state: "blocked", outcome: "fill-rejected", submissions: 0, retries: 0 },
      ]),
    );
    expect(fake.state.messages.filter((entry) => entry.type === "login.execute")).toHaveLength(1);
  });
  it.each([
    ["an origin without a saved default", "https://other.example/signin"],
    ["a subdomain of the saved origin", "https://sub.login.example/signin"],
    ["a different port of the saved origin", "https://login.example:8443/signin"],
    ["a plain HTTP page of the saved host (ADR 0050)", "http://login.example/signin"],
  ])("stops %s without a recipe before any policy or vault access", async (_name, url) => {
    fake.state.pageUrl = url;
    const h = harness();
    expect(await h.hello()).toEqual({ ok: false, reason: "recipe-not-found" });
    expect(h.store.handle).not.toHaveBeenCalled();
    expect(h.fields).not.toHaveBeenCalled();
    expect(fake.state.messages.map((entry) => entry.type)).toEqual(["login.status"]);
  });
  it.each([
    [
      "an excluded site",
      "https://login.example/signin",
      { excludedSites: [{ hostname: "login.example", includeSubdomains: false }] },
    ],
    [
      "an excluded site's plain HTTP page",
      "http://login.example/signin",
      { excludedSites: [{ hostname: "login.example", includeSubdomains: false }] },
    ],
    [
      "a site the allowed sites leave out (ADR 0077)",
      "https://login.example/signin",
      {
        allowedSitesEnabled: true,
        allowedSites: [{ hostname: "other.example", includeSubdomains: false }],
      },
    ],
  ])("fills nothing on %s, which the rule pauses (ADR 0062)", async (_name, url, overrides) => {
    fake.state.pageUrl = url;
    const h = harness(overrides as Partial<LocalSettings>);
    expect(await h.hello()).toMatchObject({ ok: false });
    expect(h.fields).not.toHaveBeenCalled();
    expect(fake.state.messages.map((entry) => entry.type)).not.toContain("login.execute");
  });
  it.each([
    // Chrome withholds the tab's URL without host access to the tab's page.
    ["a frame whose tab URL is withheld", { frameId: 1 }],
    ["a sender without a document id", { documentId: undefined }],
    // A page the site serves with a CSP `sandbox` header has an opaque origin (#637).
    ["a sandboxed document on the saved origin's URL", { origin: "null" }],
    ["a sender without an origin", { origin: undefined }],
    ["a sender whose origin is not its URL's", { origin: "https://other.example" }],
  ])("ignores %s on a saved-default origin", async (_name, overrides) => {
    const h = harness();
    expect(await h.hello(overrides)).toEqual({ ok: false, reason: "unauthorized-document" });
    expect(h.store.handle).not.toHaveBeenCalled();
    expect(h.recipes.recipe).not.toHaveBeenCalled();
    expect(h.fields).not.toHaveBeenCalled();
    expect(fake.state.messages).toEqual([]);
  });
  it("treats the loopback probe origin as any HTTP page outside the probe build", async () => {
    fake.state.storage["pateat.login-probe-origin.v1"] = { origin: "http://127.0.0.1:3847" };
    fake.state.pageUrl = "http://127.0.0.1:3847/signin";
    const h = harness({ siteDefaults: [] });
    // No probe recipe or binding: without a cached recipe the page stops there.
    expect(await h.hello()).toEqual({ ok: false, reason: "recipe-not-found" });
    expect(h.store.handle).not.toHaveBeenCalled();
    expect(fake.state.messages.map((entry) => entry.type)).toEqual(["login.status"]);
  });
  it("refuses a fill authorization once site access is withdrawn mid-attempt", async () => {
    const h = harness();
    const answers: unknown[] = [];
    fake.state.onExecute = async (message) => {
      const operation = message["operation"] as { attemptId: string; operationId: string };
      const authorize = () =>
        h.login.handle(
          {
            version: 1,
            type: "login.operation.authorize",
            token: "synthetic-token",
            attemptId: operation.attemptId,
            operationId: operation.operationId,
          },
          sender(),
        );
      answers.push(await authorize());
      fake.state.granted = false;
      answers.push(await authorize());
      fake.state.onExecute = undefined;
    };
    expect(await h.hello()).toEqual({ ok: true });
    await vi.waitFor(() => expect(answers).toHaveLength(2));
    expect(answers).toEqual([true, false]);
  });
  it("refuses a fill authorization from a sandboxed document at the attempt's URL", async () => {
    const h = harness();
    const answers: unknown[] = [];
    fake.state.onExecute = async (message) => {
      const operation = message["operation"] as { attemptId: string; operationId: string };
      const authorize = (from: Record<string, unknown>) =>
        h.login.handle(
          {
            version: 1,
            type: "login.operation.authorize",
            token: "synthetic-token",
            attemptId: operation.attemptId,
            operationId: operation.operationId,
          },
          sender(from),
        );
      // The same tab, frame, document and URL, but an opaque origin (#637).
      answers.push(await authorize({ origin: "null" }));
      answers.push(await authorize({}));
      fake.state.onExecute = undefined;
    };
    expect(await h.hello()).toEqual({ ok: true });
    await vi.waitFor(() => expect(answers).toHaveLength(2));
    expect(answers).toEqual([false, true]);
  });
  describe("a form destination off the document's origin (ADR 0051)", () => {
    const check = async (
      destinations: string[],
      live: Parameters<typeof harness>[1] = {},
      during?: (h: ReturnType<typeof harness>) => void,
      request: Record<string, unknown> = {},
      settings: Partial<LocalSettings> = {},
    ) => {
      const h = harness(settings, live);
      const answers: unknown[] = [];
      fake.state.onExecute = async (message) => {
        fake.state.onExecute = undefined;
        const operation = message["operation"] as { attemptId: string; operationId: string };
        during?.(h);
        for (const destination of destinations)
          answers.push(
            // oxlint-disable-next-line no-await-in-loop -- one check at a time, as asked in order
            await h.login.handle(
              {
                version: 1,
                type: "login.destination.check",
                token: "synthetic-token",
                attemptId: operation.attemptId,
                operationId: operation.operationId,
                destination,
                ...request,
              },
              sender(),
            ),
          );
      };
      expect(await h.hello()).toEqual({ ok: true });
      await vi.waitFor(() => expect(answers).toHaveLength(destinations.length));
      return answers;
    };
    const uris = vi.fn<LiveUriMatcher>(async (_connection, url) => ({
      ok: true,
      data: uriMatch({
        targetOrigin: new URL(url).origin,
        ...(["login.example", "auth.login.example"].includes(new URL(url).hostname)
          ? {}
          : { candidates: [] }),
      }),
    }));
    it("allows another host of the site only when the item matches the destination", async () => {
      expect(
        await check(
          [
            "https://auth.login.example/session",
            "https://other.login.example/session",
            "https://attacker.example/collect",
            "https://user@auth.login.example/session",
            "http://auth.login.example/session",
          ],
          { allowedOrigins: [], uris },
        ),
      ).toEqual([
        { ok: true },
        { ok: false, reason: "item-mismatch" },
        { ok: false, reason: "cross-site" },
        { ok: false, reason: "cross-site" },
        { ok: false, reason: "insecure" },
      ]);
      expect(uris.mock.calls.map((call) => call[1])).toEqual([
        "https://login.example/signin",
        "https://auth.login.example/session",
        "https://other.login.example/session",
      ]);
    });
    it("counts the item's static allowed origins", async () => {
      expect(
        await check(["https://auth.login.example/session", "https://other.login.example/x"], {
          allowedOrigins: [origin, "https://auth.login.example"],
        }),
      ).toEqual([{ ok: true }, { ok: false, reason: "item-mismatch" }]);
    });
    it("admits a destination on a host of the site a rule pauses (ADR 0062)", async () => {
      expect(
        await check(
          ["https://auth.login.example/session"],
          { allowedOrigins: [], uris },
          undefined,
          {},
          { excludedSites: [{ hostname: "auth.login.example", includeSubdomains: false }] },
        ),
        // The login's next page there is paused, which stops an automatic login.
      ).toEqual([{ ok: true }]);
    });
    it("refuses every check once site access is withdrawn", async () => {
      expect(
        await check(["https://auth.login.example/session"], { allowedOrigins: [], uris }, () => {
          fake.state.granted = false;
        }),
      ).toEqual([{ ok: false, reason: "not-authorized" }]);
    });
    it("answers unchecked when the item's rules could not be evaluated", async () => {
      const unevaluated = vi.fn<LiveUriMatcher>(async (_connection, url) => ({
        ok: true,
        data: uriMatch({
          targetOrigin: new URL(url).origin,
          ...(new URL(url).hostname === "login.example"
            ? {}
            : { candidates: [], unavailableItemIds: [itemId] }),
        }),
      }));
      expect(
        await check(["https://auth.login.example/session"], {
          allowedOrigins: [],
          uris: unevaluated,
        }),
      ).toEqual([{ ok: false, reason: "unchecked" }]);
    });
    it("refuses every check once the settings changed under the login", async () => {
      expect(
        await check(["https://auth.login.example/session"], { allowedOrigins: [], uris }, (h) => {
          h.settings.revision += 1;
        }),
      ).toEqual([{ ok: false, reason: "not-authorized" }]);
    });
    it("refuses a check for another operation", async () => {
      expect(
        await check(
          ["https://auth.login.example/session"],
          { allowedOrigins: [], uris },
          undefined,
          { operationId: "another-operation" },
        ),
      ).toEqual([{ ok: false, reason: "not-authorized" }]);
    });
  });
  const signinStart = {
    path: "/signin",
    require: "writable",
    targets: [{ by: "id", value: "password" }],
  };
  it("refuses an admitted page without a saved recipe and never reads the vault", async () => {
    fake.state.pageUrl = "https://login.example/elsewhere";
    const h = harness();
    // The origin has a recipe elsewhere, so the document watches for its first step.
    expect(await h.hello()).toEqual({
      ok: false,
      reason: "recipe-not-found",
      starts: [signinStart],
    });
    // The policy catalog (and with it every configured vault) is never opened.
    expect(h.store.handle).not.toHaveBeenCalled();
    expect(h.fields).not.toHaveBeenCalled();
    expect(fake.state.messages.map((entry) => entry.type)).toEqual(["login.status"]);
  });
  it("leaves a path where several recipes start out of the watch list", async () => {
    fake.state.pageUrl = "https://login.example/elsewhere";
    const h = harness();
    h.recipes.starts.mockResolvedValue(
      startsOf([
        recipe.steps[0]!,
        { ...recipe.steps[0]!, fields: [{ slot: "password", target: target("other") }] },
        { ...recipe.steps[0]!, path: "/other" },
      ] as never),
    );
    expect(await h.hello()).toEqual({
      ok: false,
      reason: "recipe-not-found",
      starts: [{ ...signinStart, path: "/other" }],
    });
  });
  void parseLoginRecipe({
    ...recipe,
    slots: ["branch", "password"],
    steps: [
      {
        kind: "fill",
        path: "/signin",
        fields: [
          { slot: "branch", target: target("branch") },
          { slot: "password", target: target("password") },
        ],
      },
      recipe.steps[1],
    ],
  });
});
