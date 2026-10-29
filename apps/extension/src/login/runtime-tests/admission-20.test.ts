import * as v from "valibot";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  parseLoginRecipe,
  type LocalSettings,
  type SavedLoginBinding,
  type LoginEntryRecipe,
  type LoginRecipe,
} from "@pateat/contracts";
import type { UriCandidates } from "../../crypto/wire";
import { createLoginGeneration } from "../../service/generation";
import type { ServiceTransport } from "../../service/transport";
import { acceptsSecret, type SecretInput } from "../inputs";
import { statusResponseSchema } from "../choice-wire";
import { createLoginBadge, memoryBadgeStorage } from "../badge";
import type { LoginGeneration } from "../runtime/deps";
import type { LoginReport } from "../runtime/report";
import { laterReadiness } from "../wire";
const fake = await vi.hoisted(async () => (await import("./browser-fake")).createBrowserFake());
vi.mock("wxt/browser", () => ({ browser: fake.browser }));
vi.stubEnv("MODE", "production");
const { createRuntimeTestHarness } = await import("./harness");
const {
  origin,
  itemId,
  snapshotId,
  trusted,
  sender,
  target,
  startsOf,
  recipe,
  savedBinding,
  otherItemId,
  uriMatch,
  liveItemPolicy,
  excludingLive,
  harness,
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

  const branchRecipe = parseLoginRecipe({
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
  const branchBinding: SavedLoginBinding = {
    ...savedBinding,
    slots: [
      { slot: "branch", field: { custom: "Branch" } },
      { slot: "password", field: "password" },
    ],
  };
  describe("on a page without a recipe", () => {
    const unsaved = { siteDefaults: [], bindings: [] };
    const generated = parseLoginRecipe({
      version: 1,
      id: "gen-synthetic",
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
    const page = (path: string, candidates: unknown[]) => ({
      ok: true,
      observation: { version: 1, origin, path, language: "en", complete: true, candidates },
    });
    const loginPage = page("/signin", [
      { id: "c1", role: "email", target: target("user"), autocomplete: "username" },
      { id: "c2", role: "password", target: target("password") },
      { id: "c3", role: "button", target: target("login"), label: "Sign in" },
    ]);
    const homePage = page("/home", [
      { id: "c1", role: "button", target: target("logout"), label: "Sign out" },
    ]);
    function generation(implementation: Partial<LoginGeneration> = {}) {
      return {
        available: vi.fn<LoginGeneration["available"]>(
          implementation.available ?? (async () => true),
        ),
        // Like the service, each says just before the request leaves the device.
        generate: vi.fn<LoginGeneration["generate"]>(async (request, sent) => {
          sent?.();
          return (
            implementation.generate ??
            (async () => ({ outcome: "abstained", reason: "ambiguous" }) as const)
          )(request);
        }),
        generateEntry: vi.fn<LoginGeneration["generateEntry"]>(async (request, sent) => {
          sent?.();
          return (
            implementation.generateEntry ??
            (async () => ({ outcome: "abstained", reason: "ambiguous" }) as const)
          )(request);
        }),
        judge: vi.fn<LoginGeneration["judge"]>(async (...args) => {
          args[4]?.();
          return (implementation.judge ?? (async () => ({ verdict: "unclear" }) as const))(...args);
        }),
        slotFields: vi.fn<LoginGeneration["slotFields"]>(
          implementation.slotFields ?? (async () => undefined),
        ),
      };
    }
    const uris = async () => ({ ok: true as const, data: uriMatch() });
    const status = () => fake.state.storage["pateat.login-attempts.v5"];

    describe("signed-in page samples (ADR 0029, owner 2026-10-18 08:05 UTC)", () => {
      const marked = parseLoginRecipe({ ...generated, completion: [{ target: target("logout") }] });
      const signedInPage = {
        ...homePage,
        observation: { ...homePage.observation, headerText: "Signed in as my2@example.com" },
      };
      type Sample = NonNullable<LoginGeneration["samplePage"]>;
      function sampling(before?: () => void, answer?: Sample, afterDescribed?: () => void) {
        const descriptions: unknown[] = [];
        const samplePage = vi.fn<Sample>(
          answer ??
            (async (_sample, describePage, sending) => {
              before?.();
              const described = await describePage();
              descriptions.push(described);
              if ("unsent" in described) return { outcome: "not-sent", reason: described.unsent };
              afterDescribed?.();
              const stop = await sending?.();
              if (stop) return { outcome: "not-sent", reason: stop };
              return { outcome: "kept" };
            }),
        );
        const service = { ...generation(), samplePage };
        return { service, samplePage, descriptions };
      }
      async function signIn(
        service: LoginGeneration,
        login: LoginRecipe = marked,
        shown = ["logout"],
        created?: (h: ReturnType<typeof harness>) => void,
      ) {
        fake.state.extracted = { "signed-in": signedInPage };
        fake.state.observedPath = "/signin";
        const report = vi.fn<(report: LoginReport) => void>();
        const h = harness(unsaved, {
          allowedOrigins: [],
          uris,
          username: true,
          generation: service,
          report,
        });
        created?.(h);
        h.fields.mockImplementation(async ({ fieldId }) =>
          fieldId === "login.username" ? "my2@example.com" : "synthetic-secret",
        );
        h.recipes.recipe.mockResolvedValue(login);
        h.recipes.starts.mockResolvedValue(startsOf([login.steps[0]!]));
        fake.state.present = new Set(["user", "password", "login"]);
        fake.state.onExecute = async (message) => {
          if ((message["operation"] as { step: { kind: string } }).step.kind !== "click") return;
          fake.state.present = new Set(shown);
          fake.state.observedPath = "/home";
        };
        expect(await h.hello()).toEqual({ ok: true });
        await vi.waitFor(() => expect(status()).toMatchObject([{ state: "authenticated" }]), {
          timeout: 8_000,
        });
        const samples = () =>
          report.mock.calls.flatMap(([value]) => (value.type === "sample" ? [value] : []));
        return { h, report, samples };
      }
      it("leaves the login, its record and its badge as they are when the sample fails", async () => {
        const baseline = sampling(undefined, async () => ({ outcome: "not-due" }));
        const quiet = await signIn(baseline.service);
        await vi.waitFor(() => expect(baseline.samplePage).toHaveBeenCalled(), { timeout: 5_000 });
        /**
         * The record without its IDs and times, and the badge. Its timing keeps only which
         * sums it has: they are wall-clock milliseconds, so a slow runner can count one more.
         */
        const outcome = () => ({
          status: (status() as Record<string, unknown>[]).map(
            ({
              id: _id,
              changedAt: _at,
              operationId: _op,
              usedOperationIds: _used,
              timing,
              ...rest
            }) => {
              const { since: _since, ...sums } = (timing ?? {}) as Record<string, unknown>;
              return {
                ...rest,
                timing: Object.fromEntries(Object.keys(sums).map((key) => [key, typeof sums[key]])),
              };
            },
          ),
          badge: fake.state.badges[1],
        });
        const expected = outcome();
        expect(quiet.samples()).toEqual([]);
        // A second runtime logs in again on a fresh tab record.
        for (const listener of fake.state.removed.splice(0)) listener(1);
        fake.state.storage = {};
        fake.state.badges = {};
        fake.state.messages = [];
        const failing = sampling(undefined, async () => {
          throw new Error("synthetic sample failure");
        });
        const { report, samples } = await signIn(failing.service);
        await vi.waitFor(() => expect(failing.samplePage).toHaveBeenCalled(), { timeout: 5_000 });
        await new Promise((resolve) => setTimeout(resolve, 200));
        expect(outcome()).toEqual(expected);
        expect(samples()).toEqual([]);
        expect(report).not.toHaveBeenCalledWith(expect.objectContaining({ type: "exception" }));
      }, 20_000);
      it("never asks for the page when no service is paired", async () => {
        const samplePage = vi.fn<ServiceTransport["samplePage"]>();
        const sampleStorage = { read: vi.fn(async () => undefined), write: vi.fn() };
        const real = createLoginGeneration({
          service: { connection: async () => undefined },
          transport: {
            generateRecipe: vi.fn(),
            generateEntry: vi.fn(),
            judgeCompletion: vi.fn(),
            samplePage,
          },
          storage: { read: async () => undefined, write: async () => undefined },
          slotStorage: { read: async () => undefined, write: async () => undefined },
          sampleStorage,
          sync: async () => "synced",
          refresh: async () => "synced",
        });
        const wrapped = vi.fn<Sample>((...args) => real.samplePage!(...args));
        const { samples } = await signIn({ ...generation(), samplePage: wrapped });
        await vi.waitFor(() => expect(wrapped).toHaveBeenCalled(), { timeout: 5_000 });
        await expect(wrapped.mock.results[0]!.value).resolves.toEqual({
          outcome: "not-due",
          reason: "not-connected",
        });
        expect(samplePage).not.toHaveBeenCalled();
        expect(sampleStorage.write).not.toHaveBeenCalled();
        expect(fake.state.messages.map((entry) => entry.type)).not.toContain("login.extract");
        expect(samples()).toEqual([]);
      }, 12_000);
    });
    describe("custom-field offers and their shapes (ADR 0027)", () => {
      const thirdItemId = "80000000-0000-4000-8000-000000000003";
      const matched =
        (ids: string[], extra: Partial<UriCandidates> = {}) =>
        async () => ({
          ok: true as const,
          data: uriMatch({
            candidates: ids.map((id) => ({ itemId: id, matches: [{ uriIndex: 0, match: 0 }] })),
            ...extra,
          }),
        });
      const field = (index: number) => `custom.${snapshotId}.${index}`;
      const digits = (length: number) => ({ length, classes: ["ascii-digit"], email: false });
      async function sendPage(
        values: Record<string, string | undefined>,
        live: Parameters<typeof harness>[1],
        overrides: Partial<LocalSettings> = {},
      ) {
        fake.state.extracted = { login: loginPage };
        const service = generation();
        const h = harness(
          { ...unsaved, ...overrides },
          {
            allowedOrigins: [],
            uris: matched([itemId, otherItemId]),
            generation: service,
            ...live,
          },
        );
        h.fields.mockImplementation(
          async ({ account, fieldId }) =>
            // Synthetic values only; a missing key is a read that gives nothing.
            values[`${account.itemId} ${fieldId}`],
        );
        h.recipes.recipe.mockResolvedValue(undefined);
        h.recipes.starts.mockResolvedValue(startsOf([]));
        expect(await h.signIn()).toEqual({ ok: false, reason: "generating" });
        await vi.waitFor(() => expect(service.generate).toHaveBeenCalled());
        const request = service.generate.mock.calls[0]![0];
        return {
          request,
          custom: request.slots.filter((slot) => slot.fieldName !== undefined),
          reads: h.fields.mock.calls.map(([read]) => `${read.account.itemId} ${read.fieldId}`),
        };
      }
      const twoItems = {
        custom: [
          { name: "Branch", kind: "text" as const },
          { name: "PIN", kind: "hidden" as const },
        ],
        otherCustom: [{ name: "Branch", kind: "text" as const }],
      };
      it("offers the matching items' fields by name and shapes a Text field they agree on", async () => {
        const sent = await sendPage(
          { [`${itemId} ${field(0)}`]: "123", [`${otherItemId} ${field(0)}`]: "456" },
          twoItems,
        );
        expect(sent.custom).toEqual([
          {
            id: "custom-1",
            kind: "identifier",
            description: "value of the user's vault field named in fieldName",
            fieldName: "Branch",
            valueShape: digits(3),
          },
          {
            id: "custom-2",
            kind: "hidden",
            description:
              "concealed value of the user's vault field named in fieldName, such as a PIN",
            fieldName: "PIN",
          },
        ]);
        // A Hidden value is never read for a shape, and no value is sent.
        expect(sent.reads).toEqual([`${itemId} ${field(0)}`, `${otherItemId} ${field(0)}`]);
        expect(JSON.stringify(sent.request)).not.toMatch(/123|456|Synthetic item/u);
      });
      it.each<[string, string | undefined, object | undefined]>([
        ["another length", "4567", undefined],
        ["other characters", "4b6", undefined],
        ["an unreadable value", undefined, undefined],
        ["a value too long to shape", "1".repeat(1025), undefined],
        ["an empty value, which does not count", "", digits(3)],
      ])("sends a Text shape only when the items agree: %s", async (_label, other, shape) => {
        const sent = await sendPage(
          { [`${itemId} ${field(0)}`]: "123", [`${otherItemId} ${field(0)}`]: other },
          twoItems,
        );
        expect(sent.custom[0]!.valueShape).toEqual(shape);
        expect(sent.custom.map((slot) => slot.fieldName)).toEqual(["Branch", "PIN"]);
      });
      it("offers a field an item excludes only from the items that allow it", async () => {
        const settings = (excluded: Partial<LocalSettings["itemPolicies"][number]>) =>
          "excludedFields" in excluded
            ? excludingLive(excluded.excludedFields!)
            : { itemPolicies: [liveItemPolicy(otherItemId, excluded)] };
        const values = { [`${itemId} ${field(0)}`]: "1", [`${otherItemId} ${field(0)}`]: "4567" };
        const field0 = await sendPage(
          values,
          twoItems,
          settings({ excludedFields: [{ custom: "Branch", position: 1, count: 1 }] }),
        );
        // Offers are numbered in the order the items' fields are found.
        expect(field0.custom.map((slot) => [slot.id, slot.fieldName, slot.valueShape])).toEqual([
          ["custom-1", "PIN", undefined],
          ["custom-2", "Branch", digits(4)],
        ]);
        expect(field0.reads).toEqual([`${otherItemId} ${field(0)}`]);
        // An excluded item offers no field and is never read.
        const item = await sendPage(values, twoItems, settings({ excluded: true }));
        expect(item.custom.map((slot) => [slot.fieldName, slot.valueShape])).toEqual([
          ["Branch", digits(1)],
          ["PIN", undefined],
        ]);
        expect(item.reads).toEqual([`${itemId} ${field(0)}`]);
      });
      it("offers nothing from an item awaiting review and reads none of its values", async () => {
        const sent = await sendPage(
          { [`${itemId} ${field(0)}`]: "123", [`${otherItemId} ${field(0)}`]: "4567" },
          { ...twoItems, quarantined: true },
        );
        // Only the other item's field is offered and shaped; the reviewed item's PIN is not.
        expect(sent.custom.map((slot) => [slot.fieldName, slot.valueShape])).toEqual([
          ["Branch", digits(4)],
        ]);
        expect(sent.reads).toEqual([`${otherItemId} ${field(0)}`]);
      });
      it("offers names without shapes when an item could not be checked", async () => {
        const sent = await sendPage(
          { [`${itemId} ${field(0)}`]: "123" },
          {
            ...twoItems,
            uris: matched([itemId], { unavailableItemIds: [otherItemId] }),
          },
        );
        expect(sent.custom.map((slot) => [slot.fieldName, slot.valueShape])).toEqual([
          ["Branch", undefined],
          ["PIN", undefined],
        ]);
        expect(sent.reads).toEqual([]);
      });
      it("reads at most 32 values for shapes and sends the rest without one", async () => {
        const sixteen = Array.from({ length: 16 }, (_, index) => ({
          name: `Field ${index + 1}`,
          kind: "text" as const,
        }));
        const values = Object.fromEntries(
          [itemId, otherItemId, thirdItemId].flatMap((id) =>
            sixteen.map((_, index) => [`${id} ${field(index)}`, "12"]),
          ),
        );
        const sent = await sendPage(values, {
          custom: sixteen,
          otherCustom: sixteen,
          extraItems: [{ id: thirdItemId, custom: sixteen }],
          uris: matched([itemId, otherItemId, thirdItemId]),
        });
        expect(sent.custom).toHaveLength(16);
        // Each offer reads three values: ten fit in 32, and no offer is shaped in part.
        expect(sent.custom.map((slot) => slot.valueShape !== undefined)).toEqual([
          ...Array.from({ length: 10 }, () => true),
          ...Array.from({ length: 6 }, () => false),
        ]);
        expect(sent.reads).toHaveLength(30);
        expect(new Set(sent.reads).size).toBe(30);
      });
    });
    describe("a custom-slot binding built before the first login (ADR 0027)", () => {
      const executes = () => fake.state.messages.filter((entry) => entry.type === "login.execute");
      const sibling = (field: { custom: string }, extra: Partial<SavedLoginBinding> = {}) => ({
        ...branchBinding,
        itemId: otherItemId,
        itemName: "Other synthetic item",
        slots: [
          { slot: "branch", field },
          { slot: "password", field: "password" as const },
        ],
        ...extra,
      });
      const regionAndBranch = {
        custom: [
          { name: "Branch", kind: "text" as const },
          { name: "Region", kind: "text" as const },
        ],
      };
      async function login(
        bindings: SavedLoginBinding[],
        map: Awaited<ReturnType<LoginGeneration["slotFields"]>> | Error,
        live: Parameters<typeof harness>[1] = regionAndBranch,
        overrides: Partial<LocalSettings> = {},
      ) {
        const service = generation({
          available: async () => "sent" as const,
          slotFields: async () => {
            if (map instanceof Error) throw map;
            return map;
          },
        });
        const h = harness({ bindings, ...overrides }, { ...live, generation: service });
        h.recipes.recipe.mockResolvedValue(branchRecipe);
        return { h, service, answer: await h.hello() };
      }
      it("takes another item's saved binding first and saves the result after authenticated", async () => {
        const { h, service, answer } = await login(
          [sibling({ custom: "Branch" })],
          [{ slot: "branch", field: { custom: "Region" } }],
        );
        expect(answer).toEqual({ ok: true });
        await vi.waitFor(() => expect(h.fields).toHaveBeenCalledTimes(2));
        expect(h.fields.mock.calls.map(([read]) => read.fieldId)).toEqual([
          `custom.${snapshotId}.0`,
          "login.password",
        ]);
        expect(service.slotFields).toHaveBeenCalledWith(branchRecipe.id);
        await vi.waitFor(() => expect(h.store.update).toHaveBeenCalled());
        expect(h.settings.settings.bindings).toContainEqual(
          expect.objectContaining({
            recipeId: branchRecipe.id,
            itemId,
            slots: [
              { slot: "branch", field: { custom: "Branch" } },
              { slot: "password", field: "password" },
            ],
          }),
        );
      });
      it("falls back to the generated map when no sibling binding resolves on the item", async () => {
        const { h, answer } = await login(
          [sibling({ custom: "Gone" })],
          [{ slot: "branch", field: { custom: "Region" } }],
        );
        expect(answer).toEqual({ ok: true });
        await vi.waitFor(() => expect(h.fields).toHaveBeenCalledTimes(2));
        expect(h.fields.mock.calls[0]![0].fieldId).toBe(`custom.${snapshotId}.1`);
      });
      it("ignores a sibling binding of another origin or recipe", async () => {
        const { answer } = await login(
          [
            sibling({ custom: "Branch" }, { origin: "https://other.example" }),
            sibling({ custom: "Branch" }, { recipeId: "another-recipe" }),
          ],
          undefined,
        );
        expect(answer).toEqual({ ok: false, reason: "binding-not-found" });
      });
      it.each<[string, Awaited<ReturnType<LoginGeneration["slotFields"]>> | Error, string]>([
        ["no map", undefined, "binding-not-found"],
        ["an unreadable map", new Error("synthetic storage failure"), "binding-not-found"],
        [
          "a map without the slot",
          [{ slot: "region", field: { custom: "Region" } }],
          "binding-not-found",
        ],
        [
          "a map naming a missing field",
          [{ slot: "branch", field: { custom: "Gone" } }],
          "field-missing",
        ],
        [
          "a map whose same-name count changed",
          [{ slot: "branch", field: { custom: "Branch", position: 1, count: 3 } }],
          "field-count-changed",
        ],
      ])("stops before any read with %s", async (_label, map, reason) => {
        const { h, answer } = await login([], map);
        expect(answer).toEqual({ ok: false, reason });
        expect(h.fields).not.toHaveBeenCalled();
        expect(executes()).toEqual([]);
        expect(h.store.update).not.toHaveBeenCalled();
      });
      it.each<[string, SavedLoginBinding[], Awaited<ReturnType<LoginGeneration["slotFields"]>>]>([
        ["a generated map", [], [{ slot: "branch", field: { custom: "PIN" } }]],
        ["another item's binding", [sibling({ custom: "PIN" })], undefined],
      ])(
        "marks a Hidden field bound from %s, so a plain text input refuses it",
        async (_label, bindings, map) => {
          // The content script's input rule, for the step's synthetic inputs: the branch
          // target is a plain text input and the password target a password input.
          const inputs: Record<"branch" | "password", SecretInput> = {
            branch: { type: "text", inputMode: "", maxLength: -1, getAttribute: () => null },
            password: { type: "password", inputMode: "", maxLength: -1, getAttribute: () => null },
          };
          fake.state.onExecute = async (message) => {
            const values = message["values"] as {
              slot: keyof typeof inputs;
              secret?: "password" | "otp" | "hidden";
            }[];
            if (values.some(({ slot, secret }) => !acceptsSecret(inputs[slot], secret)))
              fake.state.executeReply = { ok: false, reason: "structural-mismatch" };
          };
          const { h, answer } = await login(bindings, map, {
            custom: [{ name: "PIN", kind: "hidden" }],
          });
          expect(answer).toEqual({ ok: true });
          await vi.waitFor(() =>
            expect(fake.state.storage["pateat.login-attempts.v5"]).toMatchObject([
              { state: "blocked", outcome: "retry-limit", retries: 2, submissions: 0 },
            ]),
          );
          // The step is tried again twice, and the page refuses the same values each time.
          expect(executes()).toHaveLength(3);
          expect(executes()[2]!.values).toEqual([
            { slot: "branch", value: "synthetic-secret", secret: "hidden" },
            { slot: "password", value: "synthetic-secret", secret: "password" },
          ]);
          // A login that never filled is not authenticated, so nothing is saved.
          expect(h.store.update).not.toHaveBeenCalled();
        },
      );
    });
  });
  describe("when the popup asks what Pateat did on the tab's page (ADR 0038)", () => {
    const popup = {
      id: "synthetic-extension",
      url: "chrome-extension://synthetic-extension/popup.html",
    } as never;
    const ask = (h: ReturnType<typeof harness>, tabId = 1, from: never = popup) =>
      h.login.handle({ version: 1, type: "login.status.get", tabId }, from);
    const badge = () =>
      createLoginBadge({ setBadge: vi.fn(async () => undefined), storage: memoryBadgeStorage() });
    it("answers for an HTTP page as for an HTTPS one (ADR 0050)", async () => {
      fake.state.tabUrls[1] = "http://login.example/signin";
      const h = harness();
      expect(await ask(h)).toMatchObject({ ok: true, origin: "http://login.example" });
    });
    it.each([
      ["an FTP page", "ftp://login.example/signin"],
      ["a browser page", "chrome://settings/"],
      ["a malformed URL", "not a url"],
      ["an empty URL", ""],
    ])("answers no-page for %s", async (_name, url) => {
      fake.state.tabUrls[1] = url;
      const h = harness();
      expect(await ask(h)).toEqual({ ok: false, reason: "no-page" });
    });
    it("reads the top document's URL when the tab's is not given", async () => {
      const h = harness();
      expect(await h.hello()).toEqual({ ok: true });
      // Chrome leaves out a tab's URL without host access, and refuses a closed tab.
      const get = vi
        .spyOn(fake.browser.tabs, "get")
        .mockImplementation(async (id: number) => ({ id, url: undefined }) as never);
      try {
        expect(await ask(h)).toMatchObject({ ok: true, origin, recipe: "page" });
        get.mockRejectedValue(new Error("No tab with id"));
        expect(await ask(h)).toMatchObject({ ok: true, origin, recipe: "page" });
        // A tab without a document of its own has no page.
        expect(await ask(h, 2)).toEqual({ ok: false, reason: "no-page" });
      } finally {
        get.mockRestore();
      }
    });
    it("tells whether a recipe starts on the page, only elsewhere, or not at all", async () => {
      const h = harness();
      expect(await ask(h)).toEqual({ ok: true, origin, recipe: "page" });
      fake.state.tabUrls[1] = `${origin}/home?next=%2Fsignin#signin`;
      expect(await ask(h)).toEqual({ ok: true, origin, recipe: "other-paths" });
      fake.state.tabUrls[1] = "https://other.example/signin";
      expect(await ask(h)).toEqual({ ok: true, origin: "https://other.example", recipe: "none" });
      // A recipe store that cannot be read counts as no recipe.
      fake.state.tabUrls[1] = `${origin}/signin`;
      h.recipes.starts.mockRejectedValueOnce(new Error("idb"));
      expect(await ask(h)).toEqual({ ok: true, origin, recipe: "none" });
    });
    it("counts the path of a later step a login may start at as a recipe on the page", async () => {
      const h = harness();
      h.recipes.starts.mockResolvedValue([
        {
          path: "/signin",
          steps: [recipe.steps[0]!],
          later: [
            laterReadiness({
              step: {
                kind: "fill",
                path: "/signin/password",
                fields: [{ slot: "password", target: { by: "id", value: "password" } }],
                effect: "prepare",
              },
            }),
          ],
        },
      ]);
      fake.state.tabUrls[1] = `${origin}/signin/password?state=synthetic`;
      expect(await ask(h)).toEqual({ ok: true, origin, recipe: "page" });
      fake.state.tabUrls[1] = `${origin}/home`;
      expect(await ask(h)).toEqual({ ok: true, origin, recipe: "other-paths" });
    });
    it("counts a sign-in entry's path as a recipe on the page", async () => {
      const entry: LoginEntryRecipe = {
        version: 1,
        id: "synthetic-entry",
        revision: 1,
        origin,
        entry: { path: "/", target: { by: "text", value: "Login" } },
      };
      const h = harness({}, { entries: [entry] });
      h.recipes.starts.mockResolvedValue([]);
      fake.state.tabUrls[1] = `${origin}/?return_to=%2Fbookmarks`;
      expect(await ask(h)).toEqual({ ok: true, origin, recipe: "page" });
      fake.state.tabUrls[1] = `${origin}/signin`;
      expect(await ask(h)).toEqual({ ok: true, origin, recipe: "other-paths" });
    });
    it("gives the top document's state only while the tab shows its path", async () => {
      const h = harness();
      expect(await h.hello()).toEqual({ ok: true });
      const answer = await ask(h);
      expect(answer).toMatchObject({ ok: true, origin, recipe: "page", page: expect.any(Object) });
      // Never a value, recipe step or query.
      expect(JSON.stringify(answer)).not.toContain("synthetic-secret");
      expect(JSON.stringify(answer)).not.toContain("password");
      // The tab moved on before its new page announced.
      fake.state.tabUrls[1] = `${origin}/home`;
      expect(await ask(h)).toEqual({ ok: true, origin, recipe: "other-paths" });
      fake.state.tabUrls[1] = "https://other.example/signin";
      expect(await ask(h)).toEqual({ ok: true, origin: "https://other.example", recipe: "none" });
    });
    it("gives the tab's last login, refusal and model request only for the page's origin", async () => {
      const tabBadge = badge();
      const h = harness({}, { badge: tabBadge });
      tabBadge.observe({ type: "generation", tabId: 1, origin, outcome: "recipe", page: "entry" });
      tabBadge.observe({
        type: "attempt",
        tabId: 1,
        origin,
        recipeId: recipe.id,
        recipeRevision: 1,
        route: "password",
        state: "blocked",
        outcome: "credential-rejected",
        cause: "elements-timeout",
        stepIndex: 1,
        stepCount: 2,
      });
      tabBadge.observe({
        type: "refused",
        tabId: 1,
        origin,
        reason: "no-route",
        detail: "password-empty:no-passkey",
      });
      expect(await ask(h)).toEqual({
        ok: true,
        origin,
        recipe: "page",
        login: { state: "blocked", outcome: "credential-rejected", cause: "elements-timeout" },
        refused: { reason: "no-route", detail: "password-empty:no-passkey" },
        generation: { outcome: "recipe", page: "entry" },
      });
      // Another tab, or the tab on another origin before its badge heard of it, gets none.
      fake.state.tabUrls[2] = `${origin}/signin`;
      expect(await ask(h, 2)).toEqual({ ok: true, origin, recipe: "page" });
      fake.state.tabUrls[1] = "https://other.example/signin";
      expect(await ask(h)).toEqual({ ok: true, origin: "https://other.example", recipe: "none" });
      fake.state.tabUrls[1] = `${origin}/signin`;
      expect(await ask(h)).toMatchObject({ login: { state: "blocked" } });
      // The badge drops it when the tab's top page changes origin.
      tabBadge.loaded(1, `${origin}/signin`);
      tabBadge.loaded(1, "https://other.example/");
      expect(await ask(h)).toEqual({ ok: true, origin, recipe: "page" });
    });
    it("says a model request is in flight while the tab's badge spins", async () => {
      const tabBadge = badge();
      const h = harness({}, { badge: tabBadge });
      expect(await ask(h)).toEqual({ ok: true, origin, recipe: "page" });
      const stop = tabBadge.spin(1);
      try {
        expect(await ask(h)).toEqual({ ok: true, origin, recipe: "page", asking: true });
        // Only that tab's.
        fake.state.tabUrls[2] = `${origin}/signin`;
        expect(await ask(h, 2)).toEqual({ ok: true, origin, recipe: "page" });
      } finally {
        stop();
      }
      expect(await ask(h)).toEqual({ ok: true, origin, recipe: "page" });
    });
    it("clips the badge's codes to the popup's limit", async () => {
      const tabBadge = badge();
      const h = harness({}, { badge: tabBadge });
      const detail = `password-empty:${"y".repeat(250)}`;
      tabBadge.observe({ type: "refused", tabId: 1, origin, reason: "no-route", detail });
      const parsed = v.parse(statusResponseSchema, await ask(h));
      expect(parsed).toMatchObject({
        ok: true,
        refused: { reason: "no-route", detail: detail.slice(0, 200) },
      });
    });
    it("answers only the popup page, and only a well-formed request", async () => {
      const tabBadge = badge();
      const h = harness({}, { badge: tabBadge });
      tabBadge.observe({ type: "generation", tabId: 1, origin, outcome: "sent" });
      expect(await ask(h, 1, trusted)).toBeUndefined();
      expect(await ask(h, 1, sender())).toBeUndefined();
      expect(
        await h.login.handle(
          { version: 1, type: "login.status.get", tabId: 1, origin } as never,
          popup,
        ),
      ).toBeUndefined();
      expect(
        await h.login.handle({ version: 1, type: "login.status.get", tabId: -1 }, popup),
      ).toBeUndefined();
      expect(await ask(h)).toMatchObject({ ok: true, generation: { outcome: "sent" } });
    });
  });
  it("does not answer probe controls outside the probe build", async () => {
    const h = harness();
    expect(
      await h.login.handle(
        { version: 1, type: "login.probe.configure", origin: "http://127.0.0.1:3847" },
        trusted,
      ),
    ).toBeUndefined();
    expect(
      await h.login.handle({ version: 1, type: "login.probe.status" }, trusted),
    ).toBeUndefined();
  });
});
