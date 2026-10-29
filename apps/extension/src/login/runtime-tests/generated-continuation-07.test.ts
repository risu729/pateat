import type { CustomField } from "./harness";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  parseLoginRecipe,
  type LocalSettings,
  type LoginChooserRecipe,
  type LoginRecipe,
} from "@pateat/contracts";
import type { LiveUriMatcher } from "../../vault/site-candidates";
import type { LoginGeneration, LoginReport } from "../runtime";

const fake = await vi.hoisted(async () => (await import("./browser-fake")).createBrowserFake());
vi.mock("wxt/browser", () => ({ browser: fake.browser }));
vi.stubEnv("MODE", "production");
const { createRuntimeTestHarness } = await import("./harness");
const { origin, itemId, target, startsOf, userId, uriMatch, harness } =
  createRuntimeTestHarness(fake);

describe("continuing a generated recipe after its final advance (ADR 0018)", () => {
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

  void describedPage("/home", [
    { id: "c1", role: "button", target: target("logout"), label: "Sign out" },
  ]);

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

  void parseLoginRecipe({
    ...emailFirst,
    revision: 2,
    slots: ["username", "Customer number"],
    steps: [
      ...emailFirst.steps,
      {
        kind: "fill",
        path: "/signin",
        fields: [{ slot: "Customer number", target: target("customer") }],
      },
      { kind: "click", path: "/signin", target: target("login"), purpose: "submit" },
    ],
    maxSubmissions: 2,
  });
  describe("for an item without a password, with a passkey (ADR 0036)", () => {
    const passwordRead = (h: ReturnType<typeof harness>) =>
      h.fields.mock.calls.some(([read]) => read.fieldId === "login.password");

    function keyOnlyWith(
      service: ReturnType<typeof generation>,
      options: {
        recipe?: LoginRecipe;
        custom?: CustomField[];
        totp?: "held" | "empty";
        settings?: Partial<LocalSettings>;
        report?: LoginReport[];
      } = {},
    ) {
      const used = options.recipe ?? emailFirst;
      const reports = options.report;
      const h = harness(options.settings ?? { siteDefaults: [], bindings: [] }, {
        allowedOrigins: [],
        uris,
        username: true,
        custom: options.custom ?? [],
        generation: service,
        passkeys: vi.fn(async () => ({ passkey: true, discoverable: false })),
        ...(reports ? { report: (value: LoginReport) => reports.push(value) } : {}),
      });
      h.recipes.recipe.mockResolvedValue(used);
      h.recipes.starts.mockResolvedValue(startsOf([used.steps[0]!]));
      const original = h.store.handle.getMockImplementation()!;
      h.store.handle.mockImplementation(async () => {
        const response = await original();
        if (!response.ok) return response;
        const item = response.catalog.connections[0]!.items[0]!;
        for (const field of item.fields) if (field.id === "login.password") field.empty = true;
        if (options.totp)
          item.fields.push({
            id: "login.totp-code",
            label: "Verification code",
            name: null,
            kind: "otp",
            ...(options.totp === "empty" ? { empty: true as const } : {}),
          });
        return response;
      });
      h.fields.mockImplementation(async ({ fieldId }) =>
        fieldId === "login.totp-code" ? "012345" : "synthetic-secret",
      );
      return h;
    }

    const fillOn = (slot: string, value: string, path = "/password") => ({
      kind: "fill",
      path,
      fields: [{ slot, target: target(value) }],
    });
    const logIn = {
      kind: "click",
      path: "/password",
      target: target("login"),
      purpose: "submit",
    };

    describe("on a chooser's list (owner, 2026-10-13 06:32 UTC)", () => {
      const other = { by: "text" as const, value: "Sign in with another profile" };

      const listed: LoginChooserRecipe = {
        version: 1,
        id: "gen-synthetic-chooser",
        revision: 1,
        origin,
        layout: "1000",
        chooser: { path: "/signin", other },
      };
      const branchOf = (
        revision: number,
        slots: string[],
        steps: object[],
        maxSubmissions = 1,
      ): LoginRecipe =>
        parseLoginRecipe({
          version: 1,
          id: listed.id,
          revision,
          origin,
          layout: "1000",
          pageKind: "sign-in",
          slots,
          steps,
          maxSubmissions,
        });
      const passwordBranch = (revision = 1) =>
        branchOf(revision, ["password"], [fillOn("password", "password"), logIn]);

      const withBranch = (
        revision: number,
        branches: { afterAccount?: LoginRecipe; afterOther?: LoginRecipe },
      ): LoginChooserRecipe => ({
        ...listed,
        revision,
        chooser: { ...listed.chooser, ...branches },
      });
      const keyOnList = (
        service: ReturnType<typeof generation>,
        chooser: LoginChooserRecipe,
        options: Parameters<typeof keyOnlyWith>[1] = {},
      ) => {
        const h = keyOnlyWith(service, options);
        h.recipes.recipe.mockResolvedValue(undefined);
        h.recipes.chooser.mockImplementation(async (at?: string) =>
          at === undefined || at === origin ? chooser : undefined,
        );
        h.recipes.starts.mockImplementation(async (at: string) =>
          at === origin ? [{ path: "/signin", steps: [], list: [other] }] : [],
        );
        fake.state.present = new Set();
        return h;
      };

      const attemptReports = (reports: LoginReport[]) =>
        reports.flatMap((entry) => (entry.type === "attempt" ? [entry] : []));

      it("presses nothing on the list for a login that only fills after a rejected login", async () => {
        // The site rejected this tab's login (ADR 0021 D); the item is the site default.
        fake.state.session["pateat.login-rejected-asks.v1"] = [{ tabId: 1, origin }];
        const service = generation();
        const reports: LoginReport[] = [];
        const h = keyOnList(service, withBranch(1, { afterAccount: passwordBranch() }), {
          settings: {
            siteDefaults: [{ origin, provider: "bitwarden", server: "cloud-us", userId, itemId }],
            bindings: [],
          },
          report: reports,
        });
        expect(await h.hello()).toEqual({ ok: true });
        await vi.advanceTimersByTimeAsync(5_000);
        // It fills nothing there, ends, and the tab asks for an account.
        expect(reports.find((entry) => entry.type === "start")).toMatchObject({
          fillOnly: true,
        });
        expect(reports.find((entry) => entry.type === "start")).not.toHaveProperty("click");
        expect(attemptReports(reports).at(-1)).toMatchObject({
          state: "blocked",
          reason: "fill-only",
        });
        // Every line of the login carries the mark that keeps it on the device (ADR 0066).
        expect(attemptReports(reports).length).toBeGreaterThan(0);
        for (const entry of attemptReports(reports)) expect(entry).toHaveProperty("fillOnly", true);
        expect(reports.at(-1)).toMatchObject({
          type: "refused",
          reason: "account-asked",
          detail: "rejected",
        });
        expect(executed()).toEqual([]);
        expect(fake.state.messages.some((entry) => entry.type === "login.choose")).toBe(false);
        expect(service.generate).not.toHaveBeenCalled();
        expect(passwordRead(h)).toBe(false);
      });
    });
  });
});
