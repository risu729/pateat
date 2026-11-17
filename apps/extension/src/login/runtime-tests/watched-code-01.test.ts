import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseLoginRecipe, type LoginStep } from "@pateat/contracts";
import type { LoginGeneration } from "../runtime/deps";
import type { LoginReport } from "../runtime/report";
const fake = await vi.hoisted(async () => (await import("./browser-fake")).createBrowserFake());
vi.mock("wxt/browser", () => ({ browser: fake.browser }));
vi.stubEnv("MODE", "production");
const { createRuntimeTestHarness } = await import("./harness");
const { origin, target, sender, harness } = createRuntimeTestHarness(fake);

// Luma, 2026-11-17 (#1655): the email and Continue, then in one dialog of one document and
// one path the code the site emailed, which the person types, then the authenticator app's
// code. The watch reads the swapped code page and types the item's TOTP once (ADR 0027
// amendment of 2026-11-17).
describe("a code page a watched document swaps in place", () => {
  afterEach(() => {
    vi.useRealTimers();
    for (const listener of fake.state.removed.splice(0)) listener(1);
  });
  beforeEach(() => {
    fake.state.storage = {};
    fake.state.session = {};
    fake.state.badges = {};
    fake.state.messages = [];
    fake.state.granted = true;
    fake.state.pageUrl = "https://login.example/signin";
    fake.state.tabUrls = {};
    fake.state.incognito = new Set();
    fake.state.observedPath = "/signin";
    fake.state.present = new Set(["email", "continue"]);
    fake.state.unusable = new Set();
    fake.state.unobservable = new Set();
    fake.state.disabled = new Set();
    fake.state.codeSent = new Set();
    fake.state.appCode = new Set();
    fake.state.codeDigest = "a1a1a1a1a1a1a1a1";
    fake.state.awaited = { ok: true };
    fake.state.executeReply = undefined;
    fake.state.gone = new Set();
    fake.state.extracted = {};
    fake.state.signs = undefined;
    // Continue shows the emailed code's page in the same document.
    fake.state.onExecute = async (message) => {
      const step = (message["operation"] as { step: LoginStep }).step;
      if (step.kind === "click" && step.target.value === "continue") {
        fake.state.present = new Set(["code"]);
        fake.state.codeSent = new Set(["code"]);
        fake.state.signs = codePage;
      }
    };
  });
  const codeHandler = { kind: "totp" as const, path: "/signin", field: target("code") };
  const emailCode = parseLoginRecipe({
    version: 1,
    id: "synthetic-email-code",
    revision: 1,
    origin,
    pageKind: "sign-in",
    slots: ["username", "password"],
    steps: [
      { kind: "fill", path: "/signin", fields: [{ slot: "username", target: target("email") }] },
      { kind: "click", path: "/signin", target: target("continue"), purpose: "advance" },
    ],
    maxSubmissions: 1,
  });
  const learned = parseLoginRecipe({ ...emailCode, revision: 2, handlers: [codeHandler] });
  const codePage = () => ({
    password: false,
    code: true,
    captcha: false,
    invalid: false,
    alert: false,
    username: false,
  });
  const status = () =>
    fake.state.storage["pateat.login-attempts.v5"] as Record<string, unknown>[] | undefined;
  const codeFills = () =>
    fake.state.messages.filter(
      (entry) =>
        entry.type === "login.execute" && entry.values?.some((value) => value.slot === "totp"),
    );
  const handlerReports = (report: ReturnType<typeof vi.fn<(report: LoginReport) => void>>) =>
    report.mock.calls.flatMap(([value]) =>
      value.type === "handler" ? [[value.handler, value.kind, value.outcome]] : [],
    );
  function start(recipe = learned, generation?: LoginGeneration, totp = true) {
    const report = vi.fn<(report: LoginReport) => void>();
    const h = harness(
      {},
      {
        username: true,
        report,
        passkeys: vi.fn(async () => ({ passkey: true, discoverable: false })),
        ...(generation ? { generation } : {}),
      },
    );
    h.recipes.recipe.mockResolvedValue(recipe);
    const original = h.store.handle.getMockImplementation()!;
    h.store.handle.mockImplementation(async () => {
      const response = await original();
      if (response.ok) {
        const item = response.catalog.connections[0]!.items[0]!;
        for (const field of item.fields) if (field.id === "login.password") field.empty = true;
        if (totp)
          item.fields = [
            ...item.fields,
            { id: "login.totp-code", label: "Verification code", name: null, kind: "otp" },
          ] as never;
      }
      return response;
    });
    h.fields.mockImplementation(async ({ fieldId }) =>
      fieldId === "login.totp-code" ? "012345" : "synthetic-secret",
    );
    return { h, report };
  }
  async function until(check: () => boolean, maxMs = 120_000) {
    for (let spent = 0; !check(); spent += 100) {
      if (spent > maxMs) throw new Error("Condition not reached in fake time");
      // eslint-disable-next-line no-await-in-loop
      await vi.advanceTimersByTimeAsync(100);
    }
  }
  const changed = (h: ReturnType<typeof start>["h"]) =>
    h.login.handle(
      { version: 1, type: "login.document.code-changed", token: "synthetic-token" },
      sender(),
    );
  /** The emailed code's page, watched at the stop, its code field's digest kept. */
  async function watched(recipe = learned, generation?: LoginGeneration, totp = true) {
    const started = start(recipe, generation, totp);
    expect(await started.h.hello()).toEqual({ ok: true });
    await until(
      () =>
        status()?.[0]?.["state"] === "watching" &&
        (status()![0]!["watch"] as { code?: string } | undefined)?.code !== undefined,
    );
    expect(status()![0]).toMatchObject({
      stopAt: 2,
      watch: { code: "a1a1a1a1a1a1a1a1" },
    });
    expect(fake.state.messages.filter((entry) => entry.type === "login.code.watch")).toHaveLength(
      1,
    );
    expect(codeFills()).toEqual([]);
    return started;
  }
  /** The person typed the emailed code: the dialog asks for the authenticator app's. */
  const appPage = () => {
    fake.state.codeSent = new Set();
    fake.state.appCode = new Set(["code"]);
    fake.state.codeDigest = "b2b2b2b2b2b2b2b2";
  };

  it("types the item's TOTP once into the authenticator app's page with the learned handler", async () => {
    vi.useFakeTimers();
    const { h, report } = await watched();
    appPage();
    await changed(h);
    await until(() => codeFills().length > 0);
    expect(codeFills()).toHaveLength(1);
    expect(handlerReports(report)).toContainEqual([0, "totp", "entered"]);
    expect(status()![0]).toMatchObject({ handlers: [{ index: 0, start: 2 }], stopAt: 3 });
    // The page asks again, as after a wrong code: the code is never typed twice.
    fake.state.codeDigest = "c3c3c3c3c3c3c3c3";
    await until(() => status()?.[0]?.["state"] === "watching");
    await changed(h);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(codeFills()).toHaveLength(1);
  });

  it("types nothing into a page that does not name an authenticator app", async () => {
    vi.useFakeTimers();
    const { h, report } = await watched();
    // Another code page, which says neither where its code comes from nor that it is empty.
    fake.state.codeSent = new Set();
    fake.state.codeDigest = "b2b2b2b2b2b2b2b2";
    await changed(h);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(codeFills()).toEqual([]);
    expect(status()![0]).toMatchObject({ state: "watching" });
    expect(handlerReports(report)).not.toContainEqual([0, "totp", "entered"]);
    // The document is asked again, its baseline the page as it is now.
    const asks = fake.state.messages.filter((entry) => entry.type === "login.code.watch");
    expect(asks.length).toBe(2);
    expect(asks.at(-1)).not.toHaveProperty("baseline");
  });

  it("types nothing for an item without a TOTP", async () => {
    vi.useFakeTimers();
    const { h } = await watched(learned, undefined, false);
    appPage();
    await changed(h);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(codeFills()).toEqual([]);
    expect(status()![0]).toMatchObject({ state: "watching" });
  });

  it("ignores a change no ask is waiting for", async () => {
    vi.useFakeTimers();
    const { h } = await watched();
    appPage();
    await changed(h);
    await until(() => codeFills().length > 0);
    // A second report of the same ask reads nothing more.
    const asked = fake.state.messages.length;
    await changed(h);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(
      fake.state.messages
        .slice(asked)
        .filter((entry) => entry.type === "login.extract" || entry.type === "login.execute"),
    ).toEqual([]);
  });

  it("judges the authenticator app's page and types the code with the handler it learns", async () => {
    vi.useFakeTimers();
    const judge = vi.fn<LoginGeneration["judge"]>(async (...args) => {
      args[4]?.();
      return { verdict: "challenge", recipe: learned };
    });
    const generation = {
      available: vi.fn<LoginGeneration["available"]>(async () => true),
      generate: vi.fn<LoginGeneration["generate"]>(),
      generateEntry: vi.fn<LoginGeneration["generateEntry"]>(),
      judge,
      slotFields: vi.fn<LoginGeneration["slotFields"]>(async () => undefined),
    };
    const { h, report } = await watched(emailCode, generation);
    const judged = judge.mock.calls.length;
    appPage();
    const page = (near: string) => ({
      ok: true,
      observation: {
        version: 1,
        origin,
        path: "/signin",
        language: "en",
        complete: true,
        headings: ["Two-Factor Authentication"],
        nearCode: [near],
        candidates: [
          {
            id: "c1",
            role: "text",
            target: target("code"),
            label: "Verification code",
            autocomplete: "one-time-code",
            inputMode: "numeric",
          },
        ],
      },
    });
    fake.state.extracted = {
      "signed-in": page("Please enter the code generated by your authenticator app."),
    };
    await changed(h);
    await until(() => codeFills().length > 0);
    expect(judge).toHaveBeenCalledTimes(judged + 1);
    expect(codeFills()).toHaveLength(1);
    expect(handlerReports(report)).toContainEqual([0, "totp", "entered"]);
    expect(
      report.mock.calls.some(
        ([value]) => value.type === "judge" && value.watched === true && value.takenOver === true,
      ),
    ).toBe(true);
  });

  it("sends no page to the judge whose words do not name an authenticator app", async () => {
    vi.useFakeTimers();
    const judge = vi.fn<LoginGeneration["judge"]>(async () => ({ verdict: "challenge" }));
    const generation = {
      available: vi.fn<LoginGeneration["available"]>(async () => true),
      generate: vi.fn<LoginGeneration["generate"]>(),
      generateEntry: vi.fn<LoginGeneration["generateEntry"]>(),
      judge,
      slotFields: vi.fn<LoginGeneration["slotFields"]>(async () => undefined),
    };
    const { h, report } = await watched(emailCode, generation);
    const judged = judge.mock.calls.length;
    fake.state.codeDigest = "b2b2b2b2b2b2b2b2";
    fake.state.extracted = {
      "signed-in": {
        ok: true,
        observation: {
          version: 1,
          origin,
          path: "/signin",
          language: "en",
          complete: true,
          headings: ["Enter Code"],
          nearCode: ["Please enter the 6 digit code we sent to [email]."],
          candidates: [
            {
              id: "c1",
              role: "text",
              target: target("code"),
              autocomplete: "one-time-code",
              inputMode: "numeric",
            },
          ],
        },
      },
    };
    await changed(h);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(judge).toHaveBeenCalledTimes(judged);
    expect(codeFills()).toEqual([]);
    expect(report).toHaveBeenCalledWith(
      expect.objectContaining({ type: "judge", verdict: "not-sent", reason: "code-unnamed" }),
    );
  });
});
