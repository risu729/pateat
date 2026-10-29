import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  parseLoginRecipe,
  type ExcludedField,
  type LocalSettings,
  type SavedLoginBinding,
  type LoginRecipe,
  type LoginStep,
} from "@pateat/contracts";
import type { LoginGeneration } from "../runtime/deps";
import type { LoginReport } from "../runtime/report";
const fake = await vi.hoisted(async () => (await import("./browser-fake")).createBrowserFake());
vi.mock("wxt/browser", () => ({ browser: fake.browser }));
vi.stubEnv("MODE", "production");
const { createRuntimeTestHarness } = await import("./harness");
const {
  itemId,
  snapshotId,
  target,
  recipe,
  savedBinding,
  otherItemId,
  liveItemPolicy,
  excludingLive,
  liveDefault,
  harness,
  realTime,
} = createRuntimeTestHarness(fake);

describe("password route variants (ADR 0027)", () => {
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
    fake.state.present = undefined;
    fake.state.awaited = { ok: true };
    fake.state.onAwait = undefined;
    fake.state.executeReply = undefined;
    fake.state.switchReply = { ok: true };
    fake.state.chosen = { ok: true, click: "entry" };
    fake.state.gone = new Set();
    fake.state.extracted = {};
    fake.state.signs = undefined;
  });
  const set = (slots: string[]) => ({
    slots,
    steps: [
      {
        kind: "fill" as const,
        path: "/signin",
        fields: slots.map((slot) => ({ slot, target: target(slot) })),
      },
      recipe.steps[1]!,
    ],
  });
  const varied = parseLoginRecipe({
    ...recipe,
    id: "synthetic-variants",
    ...set(["branch", "password"]),
    alternatives: [set(["contract", "password"])],
  });
  const both = {
    custom: [
      { name: "Branch", kind: "text" as const },
      { name: "Contract", kind: "text" as const },
    ],
  };
  const branchField = `custom.${snapshotId}.0`;
  const contractField = `custom.${snapshotId}.1`;
  const referenceOf = (fieldId: string): ExcludedField =>
    fieldId === branchField
      ? { custom: "Branch", position: 1, count: 1 }
      : { custom: "Contract", position: 1, count: 1 };
  const bound = (slots: SavedLoginBinding["slots"]): SavedLoginBinding => ({
    ...savedBinding,
    recipeId: varied.id,
    slots,
  });
  const byContract = bound([
    { slot: "contract", field: { custom: "Contract" } },
    { slot: "password", field: "password" },
  ]);
  const everything = bound([
    { slot: "branch", field: { custom: "Branch" } },
    { slot: "contract", field: { custom: "Contract" } },
    { slot: "password", field: "password" },
  ]);
  const excluding = (fieldId: string): Partial<LocalSettings> =>
    excludingLive([referenceOf(fieldId)]);
  const status = () =>
    fake.state.storage["pateat.login-attempts.v5"] as Record<string, unknown>[] | undefined;
  const filled = () =>
    fake.state.messages
      .filter((entry) => entry.type === "login.execute")
      .map((entry) => (entry as unknown as { operation: { step: LoginStep } }).operation.step)
      .flatMap((step) =>
        step.kind === "fill" ? [step.fields.map((field) => field.target.value)] : [],
      );
  function start(
    overrides: Partial<LocalSettings>,
    live: Parameters<typeof harness>[1] = both,
    used: LoginRecipe = varied,
  ) {
    const report = vi.fn<(report: LoginReport) => void>();
    const passkeys = vi.fn(async () => ({ passkey: false, discoverable: false }));
    const h = harness(overrides, { ...live, report, passkeys });
    h.recipes.recipe.mockResolvedValue(used);
    return { h, report, passkeys };
  }
  const refusals = (report: ReturnType<typeof vi.fn>) =>
    report.mock.calls.map(([entry]) => entry).filter((entry) => entry.type === "refused");
  it("takes the first variant the item's saved binding fills", async () => {
    const { h, report, passkeys } = start({ bindings: [byContract] });
    expect(await h.hello()).toEqual({ ok: true });
    await vi.waitFor(() => expect(status()).toMatchObject([{ state: "authenticated" }]));
    expect(status()![0]).toMatchObject({ route: "password", variant: 1, stepCount: 2 });
    expect(filled()).toEqual([["contract", "password"]]);
    expect(h.fields.mock.calls.map(([read]) => read.fieldId)).toEqual([
      contractField,
      "login.password",
    ]);
    // The facts are read once, whatever number of variants was tried.
    expect(passkeys).toHaveBeenCalledTimes(1);
    expect(report.mock.calls.map(([entry]) => entry)).toContainEqual(
      expect.objectContaining({ type: "attempt", route: "password", variant: 1 }),
    );
  });
  it("takes variant 0 when the binding fills it, and ignores the binding's other slots", async () => {
    const { h } = start({ bindings: [everything] });
    expect(await h.hello()).toEqual({ ok: true });
    await vi.waitFor(() => expect(status()).toMatchObject([{ state: "authenticated" }]));
    expect(status()![0]).toMatchObject({ variant: 0 });
    expect(filled()).toEqual([["branch", "password"]]);
    // The contract field is never read for a login on the branch variant.
    expect(h.fields.mock.calls.map(([read]) => read.fieldId)).toEqual([
      branchField,
      "login.password",
    ]);
  });
  it("keeps the variant a saved binding fits as it is, though an earlier one could be filled", async () => {
    // A generated map could fill the branch variant's gap, but the item's own binding fits
    // the contract variant as it is (ADR 0027, amended 2026-10-19).
    const service = {
      available: vi.fn<LoginGeneration["available"]>(async () => "sent"),
      generate: vi.fn<LoginGeneration["generate"]>(async () => ({
        outcome: "skipped",
        reason: "sent",
      })),
      generateEntry: vi.fn<LoginGeneration["generateEntry"]>(),
      judge: vi.fn<LoginGeneration["judge"]>(async () => ({ verdict: "unclear" })),
      slotFields: vi.fn<LoginGeneration["slotFields"]>(async () => [
        { slot: "branch", field: { custom: "Branch" } },
      ]),
    };
    const { h } = start({ bindings: [byContract] }, { ...both, generation: service });
    expect(await h.hello()).toEqual({ ok: true });
    await vi.waitFor(() => expect(status()).toMatchObject([{ state: "authenticated" }]));
    expect(status()![0]).toMatchObject({ variant: 1 });
    expect(filled()).toEqual([["contract", "password"]]);
    expect(service.slotFields).not.toHaveBeenCalled();
    // Nothing was filled, so the binding stays as it was.
    expect(h.settings.settings.bindings).toEqual([byContract]);
  });
  it("fills the gaps of a saved binding that fits no variant as it is, in variant order", async () => {
    const slotFields = vi.fn<LoginGeneration["slotFields"]>(async () => [
      { slot: "branch", field: { custom: "Branch" } },
      { slot: "contract", field: { custom: "Contract" } },
    ]);
    const service = {
      available: vi.fn<LoginGeneration["available"]>(async () => "sent"),
      generate: vi.fn<LoginGeneration["generate"]>(async () => ({
        outcome: "skipped",
        reason: "sent",
      })),
      generateEntry: vi.fn<LoginGeneration["generateEntry"]>(),
      judge: vi.fn<LoginGeneration["judge"]>(async () => ({ verdict: "unclear" })),
      slotFields,
    };
    // A binding whose slot the recipe no longer has: its entries are kept, and the first
    // variant's gap is filled from the generated map.
    const stale = bound([
      { slot: "region", field: { custom: "Branch" } },
      { slot: "password", field: "password" },
    ]);
    const { h } = start({ bindings: [stale] }, { ...both, generation: service });
    expect(await h.hello()).toEqual({ ok: true });
    await vi.waitFor(() => expect(status()).toMatchObject([{ state: "authenticated" }]));
    expect(status()![0]).toMatchObject({ variant: 0 });
    expect(filled()).toEqual([["branch", "password"]]);
    expect(slotFields).toHaveBeenCalled();
    await vi.waitFor(() =>
      expect(h.settings.settings.bindings).toEqual([
        { ...stale, slots: [...stale.slots, { slot: "branch", field: { custom: "Branch" } }] },
      ]),
    );
    // Without a template for either gap, nothing fills it and the variants refuse as before.
    slotFields.mockResolvedValue(undefined);
    const refused = start({ bindings: [stale] }, { ...both, generation: service });
    expect(await refused.h.hello({ tab: { id: 2 }, documentId: "other-tab" })).toEqual({
      ok: false,
      reason: "no-route",
    });
    expect(refusals(refused.report)).toEqual([
      expect.objectContaining({ reason: "no-route", detail: "binding-slots-mismatch" }),
    ]);
    expect(refused.h.fields).not.toHaveBeenCalled();
  });
  describe("a saved binding that lacks a slot of the recipe (amended 2026-10-19)", () => {
    const signIn = parseLoginRecipe({
      ...varied,
      ...set(["username", "password"]),
      alternatives: undefined,
    });
    const branchFirst = parseLoginRecipe({ ...varied, alternatives: undefined });
    const narrow = bound([{ slot: "username", field: "username" }]);
    const service = (slotFields: LoginGeneration["slotFields"] = async () => undefined) => ({
      available: vi.fn<LoginGeneration["available"]>(async () => "sent"),
      generate: vi.fn<LoginGeneration["generate"]>(async () => ({
        outcome: "skipped",
        reason: "sent",
      })),
      generateEntry: vi.fn<LoginGeneration["generateEntry"]>(),
      judge: vi.fn<LoginGeneration["judge"]>(async () => ({ verdict: "unclear" })),
      slotFields: vi.fn<LoginGeneration["slotFields"]>(slotFields),
    });
    it("fills a built-in slot from the item and widens the binding after authenticated", async () => {
      const { h, report } = start({ bindings: [narrow] }, { ...both, username: true }, signIn);
      expect(await h.hello()).toEqual({ ok: true });
      await vi.waitFor(() => expect(status()).toMatchObject([{ state: "authenticated" }]));
      expect(filled()).toEqual([["username", "password"]]);
      expect(h.fields.mock.calls.map(([read]) => read.fieldId)).toEqual([
        "login.username",
        "login.password",
      ]);
      // The saved entry stays and the filled one follows; the saved default is kept.
      await vi.waitFor(() =>
        expect(h.settings.settings.bindings).toEqual([
          { ...narrow, slots: [...narrow.slots, { slot: "password", field: "password" }] },
        ]),
      );
      expect(h.settings.settings.siteDefaults).toEqual([liveDefault()]);
      expect(report.mock.calls.map(([entry]) => entry)).toContainEqual(
        expect.objectContaining({ type: "choice", outcome: "saved" }),
      );
    });
    it("widens nothing when the credential is rejected", async () => {
      fake.state.observed = ["missing", "unique"];
      const rejecting = parseLoginRecipe({ ...signIn, rejection: target("rejected") });
      const { h } = start({ bindings: [narrow] }, { ...both, username: true }, rejecting);
      expect(await h.hello()).toEqual({ ok: true });
      await vi.waitFor(() =>
        expect(JSON.stringify(fake.state.messages)).toContain("credential-rejected"),
      );
      // The gap was filled for the login, but the binding stays as it was.
      expect(filled()).toEqual([["username", "password"]]);
      expect(h.store.update).not.toHaveBeenCalled();
      expect(h.settings.settings.bindings).toEqual([narrow]);
    });
    it.each<[string, Partial<LocalSettings>, LoginGeneration["slotFields"] | undefined]>([
      ["the generated slot map", {}, async () => [{ slot: "branch", field: { custom: "Branch" } }]],
      [
        "another item's saved binding of the recipe",
        {
          bindings: [
            bound([{ slot: "password", field: "password" }]),
            {
              ...bound([{ slot: "branch", field: { custom: "Branch" } }]),
              itemId: otherItemId,
              itemName: "Other synthetic item",
            },
          ],
        },
        undefined,
      ],
    ])("fills a custom slot from %s", async (_label, overrides, slotFields) => {
      const own = bound([{ slot: "password", field: "password" }]);
      const generation = service(slotFields);
      const { h } = start({ bindings: [own], ...overrides }, { ...both, generation }, branchFirst);
      expect(await h.hello()).toEqual({ ok: true });
      await vi.waitFor(() => expect(status()).toMatchObject([{ state: "authenticated" }]));
      expect(filled()).toEqual([["branch", "password"]]);
      expect(h.fields.mock.calls.map(([read]) => read.fieldId)).toEqual([
        branchField,
        "login.password",
      ]);
      await vi.waitFor(() =>
        expect(h.settings.settings.bindings).toContainEqual({
          ...own,
          slots: [...own.slots, { slot: "branch", field: { custom: "Branch" } }],
        }),
      );
    });
    it.each<[string, LoginGeneration["slotFields"], string]>([
      [
        "names a field the item lacks",
        async () => [{ slot: "branch", field: { custom: "Region" } }],
        "field-missing",
      ],
      [
        "names a field the item has twice",
        async () => [{ slot: "branch", field: { custom: "Twice" } }],
        "field-ambiguous",
      ],
    ])("refuses when the only template %s", async (_label, slotFields, reason) => {
      const own = bound([{ slot: "password", field: "password" }]);
      const { h, report } = start(
        { bindings: [own] },
        {
          custom: [
            { name: "Branch", kind: "text" },
            { name: "Twice", kind: "text" },
            { name: "Twice", kind: "text" },
          ],
          generation: service(slotFields),
        },
        branchFirst,
      );
      expect(await h.hello()).toEqual({ ok: false, reason });
      expect(refusals(report)).toEqual([expect.objectContaining({ reason })]);
      expect(h.fields).not.toHaveBeenCalled();
      expect(h.settings.settings.bindings).toEqual([own]);
    });
    it("never fills a built-in slot with a field the binding reads under another slot", async () => {
      const elsewhere = bound([
        { slot: "username", field: "username" },
        { slot: "Web password", field: "password" },
      ]);
      const { h, report } = start({ bindings: [elsewhere] }, { ...both, username: true }, signIn);
      expect(await h.hello()).toEqual({ ok: false, reason: "binding-slots-mismatch" });
      expect(refusals(report)).toEqual([
        expect.objectContaining({ reason: "binding-slots-mismatch" }),
      ]);
      expect(h.fields).not.toHaveBeenCalled();
      expect(h.settings.settings.bindings).toEqual([elsewhere]);
    });
  });
  it("builds each variant's binding from the generated map when none is saved", async () => {
    const service = {
      available: vi.fn<LoginGeneration["available"]>(async () => "sent"),
      generate: vi.fn<LoginGeneration["generate"]>(async () => ({
        outcome: "skipped",
        reason: "sent",
      })),
      generateEntry: vi.fn<LoginGeneration["generateEntry"]>(),
      judge: vi.fn<LoginGeneration["judge"]>(async () => ({ verdict: "unclear" })),
      slotFields: vi.fn<LoginGeneration["slotFields"]>(async () => [
        { slot: "branch", field: { custom: "Gone" } },
        { slot: "contract", field: { custom: "Contract" } },
      ]),
    };
    const { h } = start({ bindings: [] }, { ...both, generation: service });
    expect(await h.hello()).toEqual({ ok: true });
    await vi.waitFor(() => expect(status()).toMatchObject([{ state: "authenticated" }]));
    expect(status()![0]).toMatchObject({ variant: 1 });
    // The binding saved after authenticated covers the variant that signed in.
    await vi.waitFor(() =>
      expect(h.settings.settings.bindings).toContainEqual(
        expect.objectContaining({
          recipeId: varied.id,
          slots: [
            { slot: "contract", field: { custom: "Contract" } },
            { slot: "password", field: "password" },
          ],
        }),
      ),
    );
  });
  it("moves to the next variant when a field of the first is excluded", async () => {
    const { h } = start({ bindings: [everything], ...excluding(branchField) });
    expect(await h.hello()).toEqual({ ok: true });
    await vi.waitFor(() => expect(status()).toMatchObject([{ state: "authenticated" }]));
    expect(status()![0]).toMatchObject({ variant: 1 });
    expect(filled()).toEqual([["contract", "password"]]);
  });
  it("moves past a variant whose bound TOTP field is empty, reading the facts once", async () => {
    const withCode = parseLoginRecipe({
      ...varied,
      ...set(["branch", "password", "totp"]),
    });
    const { h, passkeys } = start(
      { bindings: [bound([...everything.slots, { slot: "totp", field: "totp" }])] },
      both,
      withCode,
    );
    const original = h.store.handle.getMockImplementation()!;
    h.store.handle.mockImplementation(async () => {
      const response = await original();
      if (response.ok) {
        const item = response.catalog.connections[0]!.items[0]!;
        item.fields = [
          ...item.fields,
          { id: "login.totp-code", label: "Code", name: null, kind: "otp", empty: true },
        ] as never;
      }
      return response;
    });
    expect(await h.hello()).toEqual({ ok: true });
    await vi.waitFor(() => expect(status()).toMatchObject([{ state: "authenticated" }]));
    expect(status()![0]).toMatchObject({ variant: 1, facts: { password: true, totp: false } });
    expect(filled()).toEqual([["contract", "password"]]);
    expect(passkeys).toHaveBeenCalledTimes(1);
  });
  it("refuses no-route with the first variant's reason when no variant fits", async () => {
    const slotFields = vi.fn<LoginGeneration["slotFields"]>(async () => undefined);
    const service = {
      available: vi.fn<LoginGeneration["available"]>(async () => "sent"),
      generate: vi.fn<LoginGeneration["generate"]>(async () => ({
        outcome: "skipped",
        reason: "sent",
      })),
      generateEntry: vi.fn<LoginGeneration["generateEntry"]>(),
      judge: vi.fn<LoginGeneration["judge"]>(async () => ({ verdict: "unclear" })),
      slotFields,
    };
    const { h, report } = start({ bindings: [] }, { ...both, generation: service });
    expect(await h.hello()).toEqual({ ok: false, reason: "no-route" });
    // Both variants were tried with one read of the generated map.
    expect(slotFields).toHaveBeenCalledTimes(1);
    expect(refusals(report)).toEqual([
      expect.objectContaining({ reason: "no-route", detail: "binding-not-found" }),
    ]);
    expect(h.fields).not.toHaveBeenCalled();
    expect(status() ?? []).toEqual([]);
  });
  it.each<[string, Partial<LocalSettings>, Parameters<typeof harness>[1], string]>([
    [
      "a saved binding without the variant's slot",
      { bindings: [bound([{ slot: "password", field: "password" }])] },
      both,
      "binding-slots-mismatch",
    ],
    ["no binding", { bindings: [] }, both, "binding-not-found"],
    [
      "an excluded field",
      { bindings: [everything], ...excluding(branchField) },
      both,
      "binding-field-excluded",
    ],
    ["a missing field", { bindings: [everything] }, { custom: [] }, "field-missing"],
  ])(
    "keeps a single-variant recipe's own refusal for %s",
    async (_label, overrides, live, reason) => {
      const single = parseLoginRecipe({ ...varied, alternatives: undefined });
      const { h, report } = start(overrides, live, single);
      expect(await h.hello()).toEqual({ ok: false, reason });
      expect(refusals(report)).toEqual([
        expect.not.objectContaining({ detail: expect.anything() }),
      ]);
    },
  );
  it("takes no variant for an item without a password, as the password route needs one", async () => {
    const pinOnly = parseLoginRecipe({
      ...varied,
      alternatives: [{ slots: ["contract"], steps: set(["contract"]).steps }],
    });
    const { h, report } = start(
      { bindings: [bound([{ slot: "contract", field: { custom: "Contract" } }])] },
      both,
      pinOnly,
    );
    const original = h.store.handle.getMockImplementation()!;
    h.store.handle.mockImplementation(async () => {
      const response = await original();
      if (response.ok)
        response.catalog.connections[0]!.items[0]!.fields =
          response.catalog.connections[0]!.items[0]!.fields.map((field) =>
            field.id === "login.password" ? { ...field, empty: true as const } : field,
          );
      return response;
    });
    expect(await h.hello()).toEqual({ ok: false, reason: "no-route" });
    expect(refusals(report)).toEqual([
      expect.objectContaining({ reason: "no-route", detail: "binding-slots-mismatch" }),
    ]);
    expect(h.fields).not.toHaveBeenCalled();
  });
  it.each([
    ["an unused variant's field", branchField, "authenticated"],
    ["the running variant's field", contractField, "blocked"],
  ])(
    "checks only the running variant's fields when %s is excluded",
    async (_label, fieldId, state) => {
      const { h, report } = start({ bindings: [everything], ...excluding(branchField) });
      // After the fill, the next step's authorization sees the new exclusion; the settings
      // revision stays the same, so only the plan decides.
      fake.state.onExecute = async (message) => {
        if ((message["operation"] as { step: LoginStep }).step.kind !== "fill") return;
        Object.assign(h.settings.settings, excludingLive([referenceOf(fieldId)]));
      };
      expect(await h.hello()).toEqual({ ok: true });
      await vi.waitFor(() => expect(status()).toMatchObject([{ state }]));
      expect(status()![0]).toMatchObject({ variant: 1 });
      if (state === "blocked") {
        expect(status()![0]).toMatchObject({ outcome: "policy-changed" });
        expect(report.mock.calls.at(-1)![0]).toMatchObject({
          type: "attempt",
          cause: "plan",
          reason: "binding-field-excluded",
        });
      }
    },
  );
  it("resumes on the recorded variant without reading the facts again", async () => {
    realTime();
    // Only the contract variant fits when the login starts: the item has no branch field.
    const { h, passkeys } = start(
      { bindings: [everything] },
      { custom: [{ name: "Contract", kind: "text" }] },
    );
    fake.state.observed = ["missing", "missing"];
    let clicked = false;
    fake.state.onExecute = async (message) => {
      if ((message["operation"] as { step: LoginStep }).step.kind === "click") clicked = true;
    };
    expect(await h.hello()).toEqual({ ok: true });
    await vi.waitFor(() => expect(clicked).toBe(true));
    expect(status()![0]).toMatchObject({ variant: 1 });
    // A vault sync adds the branch field, so the first variant would fit a new login.
    const original = h.store.handle.getMockImplementation()!;
    h.store.handle.mockImplementation(async () => {
      const response = await original();
      if (response.ok)
        response.catalog.connections[0]!.items[0]!.fields.push({
          id: `custom.${snapshotId}.5`,
          label: "Branch",
          name: "Branch",
          kind: "text",
        });
      return response;
    });
    fake.state.observed = ["unique", "missing"];
    await h.hello({ documentId: "next-page" });
    await vi.waitFor(() => expect(status()).toMatchObject([{ state: "authenticated" }]));
    expect(status()![0]).toMatchObject({ variant: 1 });
    expect(passkeys).toHaveBeenCalledTimes(1);
  });
  it("watches every variant's first step and starts on any of them", async () => {
    const starts = [
      {
        path: "/signin",
        steps: [varied.steps[0]!, varied.alternatives![0]!.steps[0]!],
      },
    ];
    const { h } = start({ bindings: [byContract] });
    h.recipes.starts.mockResolvedValue(starts);
    const watched = await h.hello({}, false);
    expect(watched).toMatchObject({ ok: false, reason: "form-not-ready" });
    // Both variants' fields are watched on the one start path.
    expect(
      (watched as { starts: { targets: unknown[] }[] }).starts.map((entry) => entry.targets),
    ).toEqual([
      [target("branch"), target("password")],
      [target("contract"), target("password")],
    ]);
    expect(h.store.handle).not.toHaveBeenCalled();
    // Two recipes starting on one path still leave it out.
    h.recipes.starts.mockResolvedValue([...starts, { path: "/signin", steps: [recipe.steps[0]!] }]);
    expect(await h.hello({ documentId: "second-document" }, false)).toMatchObject({ starts: [] });
  });
  it("stops after its retries when only another variant's first step is ready", async () => {
    // The document reported the start path ready, as the branch variant's fields showed,
    // but the item fills only the contract variant, whose field never appears.
    fake.state.awaited = { ok: false, reason: "timeout" };
    const { h } = start({ bindings: [byContract] });
    expect(await h.hello()).toEqual({ ok: true });
    await vi.waitFor(() =>
      expect(status()).toMatchObject([
        { variant: 1, state: "blocked", outcome: "retry-limit", submissions: 0 },
      ]),
    );
    const awaited = fake.state.messages.find((entry) => entry.type === "login.await") as
      | { readiness: { targets: unknown[] } }
      | undefined;
    expect(awaited?.readiness.targets).toEqual([target("contract"), target("password")]);
    expect(h.fields).not.toHaveBeenCalled();
    expect(fake.state.messages.map((entry) => entry.type)).not.toContain("login.execute");
  });
  it.each<[string, Partial<LocalSettings>, Parameters<typeof harness>[1], string]>([
    [
      "an item awaiting review",
      { bindings: [byContract] },
      { ...both, quarantined: true },
      "vault-unavailable",
    ],
    [
      "an excluded item",
      {
        bindings: [byContract],
        itemPolicies: [liveItemPolicy(itemId, { excluded: true })],
      },
      both,
      "item-excluded",
    ],
  ])(
    "stops at once on %s, which no other variant could pass",
    async (_label, overrides, live, reason) => {
      // The refusal applies to every variant alike, so it is reported as itself.
      const { h, report } = start(overrides, live);
      expect(await h.hello()).toEqual({ ok: false, reason });
      expect(refusals(report)).toEqual([
        expect.not.objectContaining({ detail: expect.anything() }),
      ]);
      expect(h.fields).not.toHaveBeenCalled();
    },
  );
  it("starts on the path alone when an alternative's first step needs no element", async () => {
    const waiting = parseLoginRecipe({
      ...varied,
      alternatives: [
        {
          slots: ["contract", "password"],
          steps: [
            {
              kind: "wait",
              path: "/signin",
              target: target("contract"),
              present: true,
              timeoutMs: 1000,
            },
            ...set(["contract", "password"]).steps,
          ],
        },
      ],
    });
    const { h } = start({ bindings: [byContract] }, both, waiting);
    // The document has reported no ready first step, as for a recipe that starts with a wait.
    expect(await h.hello({}, false)).toEqual({ ok: true });
    await vi.waitFor(() => expect(status()).toMatchObject([{ state: "authenticated" }]));
    expect(status()![0]).toMatchObject({ variant: 1, stepCount: 3 });
    // Every variant of the recipe without alternatives needs an element, so it waits.
    const plain = start({ bindings: [byContract] });
    expect(await plain.h.hello({ tab: { id: 2 }, documentId: "other-tab" }, false)).toMatchObject({
      ok: false,
      reason: "form-not-ready",
    });
  });
  it("never reports the item's facts, only the route and variant", async () => {
    const report = vi.fn<(report: LoginReport) => void>();
    const passkeys = vi.fn(async () => ({ passkey: true, discoverable: true }));
    const h = harness({ bindings: [byContract] }, { ...both, report, passkeys });
    h.recipes.recipe.mockResolvedValue(varied);
    expect(await h.hello()).toEqual({ ok: true });
    await vi.waitFor(() => expect(status()).toMatchObject([{ state: "authenticated" }]));
    expect(status()![0]).toMatchObject({ facts: { passkey: true, discoverablePasskey: true } });
    const reports = report.mock.calls.map(([entry]) => entry);
    expect(reports.filter((entry) => entry.type === "attempt")).not.toEqual([]);
    for (const entry of reports.filter((value) => value.type === "attempt"))
      expect(entry).toMatchObject({ route: "password", variant: 1 });
    const serialized = JSON.stringify(reports);
    for (const key of ['"facts"', '"discoverablePasskey"', '"passkey"', '"totp"'])
      expect(serialized).not.toContain(key);
  });
});
