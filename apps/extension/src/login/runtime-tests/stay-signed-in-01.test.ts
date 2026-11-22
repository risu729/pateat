import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseLoginRecipe, type LoginStep } from "@pateat/contracts";
import type { LoginGeneration } from "../runtime/deps";
import type { LoginReport } from "../runtime/report";
import type { ConditionalDecision } from "../../passkeys/runtime";
const fake = await vi.hoisted(async () => (await import("./browser-fake")).createBrowserFake());
vi.mock("wxt/browser", () => ({ browser: fake.browser }));
vi.stubEnv("MODE", "production");
const { createRuntimeTestHarness } = await import("./harness");
const { origin, sender, target, harness } = createRuntimeTestHarness(fake);

// A native login answers Yes on a stay-signed-in question after its password went, as the
// SSO flow does on an IdP's, instead of leaving it to the person as the judge's `challenge`
// (ADR 0065 amendment of 2026-11-22; UNSW Connect, 2026-11-21).
describe("a stay-signed-in question after a native login's submit", () => {
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
    fake.state.present = new Set(["user", "password", "login"]);
    fake.state.unusable = new Set();
    fake.state.unobservable = new Set();
    fake.state.awaited = { ok: true };
    fake.state.executeReply = undefined;
    fake.state.gone = new Set();
    fake.state.extracted = {};
    fake.state.signs = undefined;
    fake.state.stay = undefined;
    // The submit leads to the question in the same document.
    fake.state.onExecute = async (message) => {
      const step = (message["operation"] as { step: LoginStep }).step;
      if (step.kind !== "click") return;
      fake.state.present = new Set();
      fake.state.observedPath = "/kmsi";
      fake.state.extracted = { "signed-in": page("/kmsi", "Yes") };
    };
  });
  const recipe = parseLoginRecipe({
    version: 1,
    id: "synthetic-stay",
    revision: 1,
    origin,
    pageKind: "sign-in",
    slots: ["username", "password"],
    steps: [
      {
        kind: "fill",
        path: "/signin",
        fields: [
          { slot: "username", target: target("user") },
          { slot: "password", target: target("password") },
        ],
      },
      { kind: "click", path: "/signin", target: target("login"), purpose: "submit" },
    ],
    maxSubmissions: 1,
  });
  const emailFirst = parseLoginRecipe({
    version: 1,
    id: "synthetic-stay-email-first",
    revision: 1,
    origin,
    pageKind: "sign-in",
    slots: ["username", "password"],
    steps: [
      { kind: "fill", path: "/signin", fields: [{ slot: "username", target: target("user") }] },
      { kind: "click", path: "/signin", target: target("next"), purpose: "advance" },
      {
        kind: "fill",
        path: "/password",
        fields: [{ slot: "password", target: target("password") }],
      },
      { kind: "click", path: "/password", target: target("login"), purpose: "submit" },
    ],
    maxSubmissions: 2,
  });
  const page = (path: string, label: string) => ({
    ok: true,
    observation: {
      version: 1,
      origin,
      path,
      language: "en",
      complete: true,
      candidates: [{ id: "c1", role: "button", target: target("button"), label }],
    },
  });
  const quiet = { password: false, code: false, captcha: false, invalid: false, alert: false };
  /** The runtime of the test, which the document asks to authorize its press. */
  let login: ReturnType<typeof harness>["login"] | undefined;
  /**
   * The document's answers: a reading that is `reading`, and a press, authorized by the
   * worker before the pointer events and the click, that `pressed` follows. With `lost`,
   * the document goes away after authorizing up to that phase, taking the answer with it.
   */
  const answers =
    (
      reading: "stay-signed-in" | "unknown",
      pressed?: () => void,
      {
        destination = `${origin}/kmsi`,
        lost,
      }: { destination?: string; lost?: "pointer" | "click" } = {},
    ) =>
    async (message: Record<string, unknown>) => {
      if (message["type"] === "login.stay.prepare")
        return reading === "stay-signed-in"
          ? {
              ok: true,
              url: fake.state.pageUrl,
              destinations: [destination],
              handle: "synthetic-handle",
            }
          : { ok: false, reason: "idp-unknown" };
      for (const phase of ["pointer", "click"] as const) {
        const { attemptId, operationId, handle, token } = message;
        // eslint-disable-next-line no-await-in-loop
        const answer = await login!.handle(
          {
            version: 1,
            type: "login.stay.authorize",
            phase,
            attemptId,
            operationId,
            handle,
            token,
          },
          sender(),
        );
        if (!(answer as { ok: boolean }).ok) return { ok: false, reason: "not-authorized" };
        if (lost === phase) throw new Error("Receiving end does not exist.");
      }
      pressed?.();
      return { ok: true };
    };
  const status = () =>
    fake.state.storage["pateat.login-attempts.v5"] as Record<string, unknown>[] | undefined;
  const sent = (type: string) =>
    fake.state.messages.filter((entry) => entry.type === type) as unknown as Record<
      string,
      unknown
    >[];
  function start(verdicts: Awaited<ReturnType<LoginGeneration["judge"]>>["verdict"][]) {
    const judge = vi.fn<LoginGeneration["judge"]>(async (...args) => {
      args[4]?.();
      return { verdict: verdicts.shift() ?? "unclear" };
    });
    const report = vi.fn<(report: LoginReport) => void>();
    const h = harness(
      {},
      {
        username: true,
        report,
        passkeys: vi.fn(async () => ({ passkey: true, discoverable: false })),
        generation: {
          available: vi.fn<LoginGeneration["available"]>(async () => true),
          generate: vi.fn<LoginGeneration["generate"]>(),
          generateEntry: vi.fn<LoginGeneration["generateEntry"]>(),
          judge,
          slotFields: vi.fn<LoginGeneration["slotFields"]>(async () => undefined),
        },
      },
    );
    h.recipes.recipe.mockResolvedValue(recipe);
    login = h.login;
    const judged = () => judge.mock.calls.map((call) => call[3].path);
    const notSent = () =>
      report.mock.calls.flatMap(([entry]) =>
        entry.type === "judge" && entry.verdict === "not-sent" ? [entry.reason] : [],
      );
    return { h, judged, notSent };
  }
  async function until(check: () => boolean, maxMs = 60_000) {
    for (let spent = 0; !check(); spent += 100) {
      if (spent > maxMs) throw new Error("Condition not reached in fake time");
      // eslint-disable-next-line no-await-in-loop
      await vi.advanceTimersByTimeAsync(100);
    }
  }

  it("presses Yes without a judge call, and the page after it completes as usual", async () => {
    vi.useFakeTimers();
    const { h, judged, notSent } = start(["signed-in"]);
    fake.state.stay = answers("stay-signed-in", () => {
      fake.state.observedPath = "/home";
      fake.state.extracted = { "signed-in": page("/home", "Sign out") };
    });
    expect(await h.hello()).toEqual({ ok: true });
    await until(() => status()?.[0]?.["state"] === "authenticated");
    // Read with the login's own username, which goes nowhere else, and pressed once.
    expect(sent("login.stay.prepare")).toEqual([
      expect.objectContaining({ username: "synthetic-secret", attemptId: status()![0]!["id"] }),
    ]);
    expect(sent("login.stay.commit")).toEqual([
      expect.objectContaining({ handle: "synthetic-handle" }),
    ]);
    // Only the page after the question went to the judge.
    expect(judged()).toEqual(["/home"]);
    expect(notSent()).toEqual(["stay-signed-in"]);
  });

  it("judges the question as before when the document reads no stay-signed-in step", async () => {
    vi.useFakeTimers();
    const { h, judged, notSent } = start(["challenge"]);
    fake.state.stay = answers("unknown");
    expect(await h.hello()).toEqual({ ok: true });
    await until(() => status()?.[0]?.["state"] === "watching");
    expect(status()![0]).toMatchObject({ outcome: "challenge" });
    expect(sent("login.stay.prepare")).toHaveLength(1);
    expect(sent("login.stay.commit")).toEqual([]);
    expect(judged()).toEqual(["/kmsi"]);
    expect(notSent()).toEqual([]);
  });

  it("judges the question when the button submits off the login's site", async () => {
    vi.useFakeTimers();
    const { h, judged } = start(["challenge"]);
    fake.state.stay = answers("stay-signed-in", undefined, {
      destination: "https://elsewhere.example/kmsi",
    });
    expect(await h.hello()).toEqual({ ok: true });
    await until(() => status()?.[0]?.["state"] === "watching");
    expect(sent("login.stay.commit")).toEqual([]);
    expect(judged()).toEqual(["/kmsi"]);
  });

  it("judges the question when the press fails, and presses at most once in the document", async () => {
    vi.useFakeTimers();
    const { h, judged } = start(["challenge"]);
    fake.state.stay = (message) =>
      message["type"] === "login.stay.commit"
        ? { ok: false, reason: "target-changed" }
        : answers("stay-signed-in")(message);
    expect(await h.hello()).toEqual({ ok: true });
    await until(() => status()?.[0]?.["state"] === "watching");
    expect(sent("login.stay.commit")).toHaveLength(1);
    expect(judged()).toEqual(["/kmsi"]);
  });

  it("judges a question shown again in the next document after the press", async () => {
    vi.useFakeTimers();
    const { h, judged, notSent } = start(["challenge"]);
    // As a site whose sign-in loops, the question comes back in a new document.
    fake.state.stay = answers("stay-signed-in", () => fake.state.gone.add("synthetic-document"));
    expect(await h.hello()).toEqual({ ok: true });
    await until(() => sent("login.stay.commit").length === 1);
    await h.hello({ documentId: "document-2" }, false);
    await until(() => status()?.[0]?.["state"] === "watching");
    expect(status()![0]).toMatchObject({ outcome: "challenge" });
    expect(sent("login.stay.prepare")).toHaveLength(1);
    expect(sent("login.stay.commit")).toHaveLength(1);
    expect(judged()).toEqual(["/kmsi"]);
    expect(notSent()).toEqual(["stay-signed-in"]);
  });

  it("judges the question still shown after a press, without pressing it again", async () => {
    vi.useFakeTimers();
    const { h, judged } = start(["challenge"]);
    fake.state.stay = answers("stay-signed-in");
    expect(await h.hello()).toEqual({ ok: true });
    await until(() => status()?.[0]?.["state"] === "watching");
    expect(sent("login.stay.prepare")).toHaveLength(1);
    expect(sent("login.stay.commit")).toHaveLength(1);
    expect(judged()).toEqual(["/kmsi"]);
  });

  it("counts a press whose answer went with the document once its click was authorized", async () => {
    vi.useFakeTimers();
    const { h, judged, notSent } = start(["signed-in"]);
    // The form posts back to the same URL: the document goes, the tab's URL stays.
    fake.state.stay = answers("stay-signed-in", undefined, { lost: "click" });
    expect(await h.hello()).toEqual({ ok: true });
    await until(() => sent("login.stay.commit").length === 1);
    await vi.advanceTimersByTimeAsync(0);
    expect(notSent()).toEqual(["stay-signed-in"]);
    fake.state.gone.add("synthetic-document");
    fake.state.observedPath = "/home";
    fake.state.extracted = { "signed-in": page("/home", "Sign out") };
    await h.hello({ documentId: "document-2" }, false);
    await until(() => status()?.[0]?.["state"] === "authenticated");
    expect(judged()).toEqual(["/home"]);
  });

  it("judges the question when the answer went before the click was authorized", async () => {
    vi.useFakeTimers();
    const { h, judged, notSent } = start(["challenge"]);
    fake.state.stay = answers("stay-signed-in", undefined, { lost: "pointer" });
    expect(await h.hello()).toEqual({ ok: true });
    await until(() => status()?.[0]?.["state"] === "watching");
    expect(sent("login.stay.commit")).toHaveLength(1);
    expect(judged()).toEqual(["/kmsi"]);
    expect(notSent()).toEqual([]);
  });

  it("judges the question after a passkey answered at a login's stop", async () => {
    vi.useFakeTimers();
    const { h, judged } = start(["challenge"]);
    fake.state.stay = answers("stay-signed-in");
    // An item without a password stops before it, and the page's passkey request is
    // answered once Next was pressed (ADR 0036).
    const original = h.store.handle.getMockImplementation()!;
    h.store.handle.mockImplementation(async () => {
      const response = await original();
      if (response.ok)
        for (const field of response.catalog.connections[0]!.items[0]!.fields)
          if (field.id === "login.password") field.empty = true;
      return response;
    });
    h.recipes.recipe.mockResolvedValue(emailFirst);
    fake.state.present = new Set(["user", "next"]);
    let decided: ConditionalDecision | undefined;
    fake.state.onExecute = async (message) => {
      const step = (message["operation"] as { step: LoginStep }).step;
      if (step.kind !== "click") return;
      fake.state.observedPath = "/password";
      fake.state.present = new Set(["password", "login"]);
      void h.login
        .conditionalRequest({
          tabId: 1,
          origin,
          documentId: "synthetic-document",
          signal: new AbortController().signal,
        })
        .then((value) => (decided = value));
    };
    expect(await h.hello()).toEqual({ ok: true });
    await until(() => decided !== undefined);
    expect(decided).toMatchObject({ kind: "answer" });
    (decided as Extract<ConditionalDecision, { kind: "answer" }>).answered(true);
    h.login.passkeyAnswered(1, origin, "login.example");
    // The answer leads to the question in the same document.
    fake.state.present = new Set();
    fake.state.observedPath = "/kmsi";
    fake.state.extracted = { "signed-in": page("/kmsi", "Yes") };
    await until(() => judged().length === 1);
    expect(status()![0]).toMatchObject({ stopAt: 2, submissions: 2 });
    expect(sent("login.stay.prepare")).toEqual([]);
    expect(judged()).toEqual(["/kmsi"]);
  });

  it("only reads the question on a watched login's later page", async () => {
    vi.useFakeTimers();
    const { h, judged } = start(["challenge", "challenge"]);
    // The first page after the submit is no question; the login is then watched.
    fake.state.stay = answers("unknown");
    expect(await h.hello()).toEqual({ ok: true });
    await until(() => status()?.[0]?.["state"] === "watching");
    expect(sent("login.stay.prepare")).toHaveLength(1);
    // The tab's next page asks to stay signed in.
    fake.state.stay = answers("stay-signed-in");
    fake.state.signs = quiet;
    fake.state.gone.add("synthetic-document");
    await h.hello({ documentId: "document-2" }, false);
    await until(() => judged().length === 2);
    expect(sent("login.stay.prepare")).toHaveLength(1);
    expect(sent("login.stay.commit")).toEqual([]);
  });
});
