import type { CustomField } from "./harness";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseLoginRecipe, type LocalSettings, type LoginRecipe } from "@pateat/contracts";
import type { LiveUriMatcher } from "../../vault/site-candidates";
import type { LoginGeneration } from "../runtime/deps";
import type { LoginReport } from "../runtime/report";
const fake = await vi.hoisted(async () => (await import("./browser-fake")).createBrowserFake());
vi.mock("wxt/browser", () => ({ browser: fake.browser }));
vi.stubEnv("MODE", "production");
const { createRuntimeTestHarness } = await import("./harness");
const { origin, target, startsOf, uriMatch, harness } = createRuntimeTestHarness(fake);

describe("replacing a disabled final advance by its page (ADR 0018 amendment of 2026-11-03)", () => {
  afterEach(() => {
    vi.useRealTimers();
    fake.state.signIn = false;
    for (const listener of fake.state.removed.splice(0))
      for (const tabId of [1, 2]) listener(tabId);
  });
  beforeEach(() => {
    vi.useFakeTimers();
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
    // The email page: its field and Next show, and no password input yet.
    fake.state.present = new Set(["email", "next"]);
    fake.state.unusable = new Set();
    fake.state.signIn = false;
    fake.state.awaited = { ok: true };
    fake.state.onAwait = undefined;
    fake.state.executeReply = undefined;
    fake.state.switchReply = { ok: true };
    fake.state.chosen = { ok: true, click: "entry" };
    fake.state.gone = new Set();
    fake.state.extracted = {};
    fake.state.signs = undefined;
  });
  const emailFirst = parseLoginRecipe({
    version: 1,
    id: "gen-synthetic-continued",
    revision: 1,
    origin,
    pageKind: "sign-in",
    slots: ["username"],
    steps: [
      { kind: "fill", path: "/signin", fields: [{ slot: "username", target: target("email") }] },
      { kind: "click", path: "/signin", target: target("next"), purpose: "advance" },
    ],
    maxSubmissions: 1,
  });
  const describedPage = (path: string, candidates: unknown[], complete = true) => ({
    ok: true,
    observation: { version: 1, origin, path, language: "en", complete, candidates },
  });
  const homePage = describedPage("/home", [
    { id: "c1", role: "button", target: target("logout"), label: "Sign out" },
  ]);
  const status = () =>
    fake.state.storage["pateat.login-attempts.v5"] as Record<string, unknown>[] | undefined;
  const executed = () =>
    fake.state.messages
      .filter((entry) => entry.type === "login.execute")
      .map((entry) => {
        const { step } = (
          entry as unknown as {
            operation: {
              step: {
                kind: string;
                target?: { value: string };
                fields?: { target: { value: string } }[];
              };
            };
          }
        ).operation;
        return `${step.kind}:${step.target?.value ?? step.fields?.map((field) => field.target.value).join(",")}`;
      });
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
  const uris = vi.fn<LiveUriMatcher>(async () => ({ ok: true as const, data: uriMatch() }));
  function generation(
    generate: LoginGeneration["generate"] = async () => ({
      outcome: "abstained",
      reason: "ambiguous",
    }),
    judge: LoginGeneration["judge"] = async () => ({ verdict: "signed-in" }),
  ) {
    return {
      available: vi.fn<LoginGeneration["available"]>(async () => "sent"),
      generate: vi.fn<LoginGeneration["generate"]>(generate),
      // Like the service, it says just before the request leaves the device.
      generateEntry: vi.fn<LoginGeneration["generateEntry"]>(),
      judge: vi.fn<LoginGeneration["judge"]>(async (...args) => {
        args[4]?.();
        return judge(...args);
      }),
      slotFields: vi.fn<LoginGeneration["slotFields"]>(async () => undefined),
    };
  }
  function start(
    service: ReturnType<typeof generation>,
    options: {
      recipe?: LoginRecipe;
      settings?: Partial<LocalSettings>;
      report?: LoginReport[];
      custom?: CustomField[];
      /** The item's passkey facts (ADR 0027); none by default. */
      passkeys?: () => Promise<{ passkey: boolean; discoverable: boolean }>;
    } = {},
  ) {
    const reports = options.report;
    const h = harness(options.settings ?? { siteDefaults: [], bindings: [] }, {
      allowedOrigins: [],
      uris,
      username: true,
      custom: options.custom ?? [],
      generation: service,
      ...(options.passkeys ? { passkeys: options.passkeys } : {}),
      ...(reports ? { report: (value: LoginReport) => reports.push(value) } : {}),
    });
    const first = options.recipe ?? emailFirst;
    h.recipes.recipe.mockResolvedValue(first);
    h.recipes.starts.mockResolvedValue(startsOf([first.steps[0]!]));
    return h;
  }
  const answering = (h: () => ReturnType<typeof harness>, next: LoginRecipe) =>
    (async () => {
      h().recipes.recipe.mockResolvedValue(next);
      return { outcome: "recipe" as const, recipe: next };
    }) satisfies LoginGeneration["generate"];
  // The email typed, a password input opens beside Next, which stays disabled.
  const opened = describedPage("/signin", [
    { id: "c1", role: "email", target: target("email"), label: "Email" },
    { id: "c2", role: "password", target: target("password"), label: "Password" },
    { id: "c3", role: "button", target: target("next"), label: "Next" },
  ]);
  const replaced = parseLoginRecipe({
    ...emailFirst,
    revision: 2,
    slots: ["username", "password"],
    steps: [
      emailFirst.steps[0]!,
      { kind: "fill", path: "/signin", fields: [{ slot: "password", target: target("password") }] },
      { kind: "click", path: "/signin", target: target("next"), purpose: "submit" },
    ],
    maxSubmissions: 1,
  });
  /** The readiness of each wait, in order. */
  const waits = () =>
    fake.state.messages
      .filter((entry) => entry.type === "login.await")
      .map((entry) => (entry as unknown as { readiness: Record<string, unknown> }).readiness);
  /** The page reveals its password input while the final advance click waits, once. */
  function revealing(afterwards: { ok: boolean; reason?: string; miss?: string } = { ok: true }) {
    let revealed = false;
    fake.state.awaitReply = (readiness) => {
      if (!(readiness as { revealed?: boolean }).revealed) return undefined;
      if (revealed) return afterwards;
      revealed = true;
      fake.state.signIn = true;
      fake.state.present = new Set(["email", "password", "next"]);
      fake.state.extracted = { login: opened };
      return { ok: false, reason: "revealed" };
    };
    fake.state.onExecute = async (message) => {
      const step = (message["operation"] as { step: { kind: string; target?: { value: string } } })
        .step;
      if (step.kind !== "click" || step.target?.value !== "next") return;
      fake.state.observedPath = "/home";
      fake.state.present = new Set(["logout"]);
      fake.state.signIn = false;
      fake.state.extracted = { "signed-in": homePage };
    };
  }
  afterEach(() => {
    fake.state.awaitReply = undefined;
  });

  it("sends the page once and runs its password and the same click in place of Next", async () => {
    revealing();
    const reports: LoginReport[] = [];
    let h!: ReturnType<typeof harness>;
    const service = generation(answering(() => h, replaced));
    h = start(service, { report: reports });
    expect(await h.hello()).toEqual({ ok: true });
    await until(settled("authenticated"));
    // Next never ran disabled: the email, then the page's password and Next.
    expect(executed()).toEqual(["fill:email", "fill:password", "click:next"]);
    expect(service.generate).toHaveBeenCalledTimes(1);
    const request = service.generate.mock.calls[0]![0];
    expect(request).toMatchObject({
      base: { recipeId: emailFirst.id, revision: 1, replacesLast: true },
      observation: opened.observation,
    });
    // The recipe fills the username already, so only the password is offered.
    expect(request.slots.map((slot) => slot.id)).toEqual(["password"]);
    expect(JSON.stringify(service.generate.mock.calls)).not.toContain("synthetic-secret");
    // Only the final advance click watched for the input; the page's click is a submit.
    expect(waits().map((readiness) => readiness["revealed"] === true)).toEqual([
      false,
      true,
      false,
      false,
    ]);
    expect(status()![0]).toMatchObject({
      state: "authenticated",
      recipeRevision: 2,
      stepIndex: 2,
      stepCount: 3,
      submissions: 1,
      maxSubmissions: 1,
    });
    expect(h.settings.settings.bindings).toEqual([
      expect.objectContaining({
        recipeId: emailFirst.id,
        slots: [
          { slot: "username", field: "username" },
          { slot: "password", field: "password" },
        ],
      }),
    ]);
    expect(reports.filter((entry) => entry.type === "generation")).toEqual([
      expect.objectContaining({ outcome: "recipe", baseRevision: 1, takenOver: true }),
    ]);
  });

  it("waits for the click again, without asking twice, when the answer cannot be used", async () => {
    revealing({ ok: false, reason: "timeout", miss: "not-clickable" });
    fake.state.awaited = { ok: false, reason: "timeout", miss: "not-clickable" };
    fake.state.awaitReply = ((reply) => (readiness: { accounts?: boolean }) => {
      // The email's own wait is ready; the click's waits are answered as above.
      if (waits().length === 1) return { ok: true };
      return reply?.(readiness);
    })(fake.state.awaitReply);
    const service = generation();
    const h = start(service);
    expect(await h.hello()).toEqual({ ok: true });
    // The click times out as before (`not-clickable`, #1139), and its retries too.
    await until(settled("blocked", "retry-limit"));
    expect(executed()).toEqual(["fill:email"]);
    expect(service.generate).toHaveBeenCalledTimes(1);
    // Only the click's first wait watched for the input; the document never asks again.
    expect(waits().map((readiness) => readiness["revealed"] === true)).toEqual([
      false,
      true,
      false,
      false,
      false,
    ]);
    expect(status()![0]).toMatchObject({ recipeRevision: 1, stepIndex: 1, stepCount: 2 });
    expect(status()![0]!["continuation"]).toEqual({ before: 1 });
  });

  it("does not watch a final advance click of a recipe that fills the password", async () => {
    const together = parseLoginRecipe({
      ...emailFirst,
      slots: ["username", "password"],
      steps: [
        {
          kind: "fill",
          path: "/signin",
          fields: [
            { slot: "username", target: target("email") },
            { slot: "password", target: target("password") },
          ],
        },
        emailFirst.steps[1]!,
      ],
    });
    fake.state.present = new Set(["email", "password", "next"]);
    const service = generation();
    const h = start(service, { recipe: together });
    expect(await h.hello()).toEqual({ ok: true });
    await until(() => executed().length === 2);
    expect(waits().some((readiness) => readiness["revealed"] === true)).toBe(false);
  });
});
