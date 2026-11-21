// An SSO flow keeps its SSO mapping, read from the vault once for the settings and vault
// snapshots it depends on (ADR 0026, amendment of 2026-11-22): each read is two vault jobs,
// one at a time, and the IdP login's checks waited seconds for them on every step.
import { describe, expect, it, vi } from "vitest";
const fake = await vi.hoisted(async () => (await import("./browser-fake")).createBrowserFake());
const io = vi.hoisted(() => ({
  getItem: vi.fn(),
  setItem: vi.fn(),
  getItems: vi.fn(),
  setItems: vi.fn(),
}));
vi.mock("wxt/browser", () => ({ browser: fake.browser }));
vi.mock("wxt/utils/storage", () => ({ storage: io }));
const { ssoAdmit, ssoVaultChanged } = await import("../runtime/sso/flow");
const { allowed } = await import("../runtime/plan-2");
const { ssoScope } = await import("../runtime/sso-scope");
const { settingsChanged } = await import("../runtime/messages");
const { ssoReturnFixture } = await import("./sso-return-fixture");
const { idp, idpReadings, harness, idpChild, step, click, fill } = ssoReturnFixture(fake, io);

/** The IdP's own login on its password step, its flow's mapping not read yet. */
async function atPasswordStep() {
  const h = await harness();
  const form = h.page(idp, "idp-form", "/authsvc", "?PolicyId=synthetic");
  idpReadings.set("idp-form", { kind: "native" });
  const run = idpChild(h, form.live);
  expect(await ssoAdmit(h.rt, form.ctx)).toBeUndefined();
  step(run, [...fill("username"), ...click("next"), { type: "OBSERVED", result: "continue" }]);
  expect(run.metadata).toMatchObject({ state: "ready", stepIndex: 2 });
  const validate = vi.mocked(h.rt.options.sso!.validate);
  const mapped = await validate.getMockImplementation()!(undefined as never, undefined as never);
  if (!mapped.ok) throw new Error("The synthetic mapping is refused");
  const settings = vi.mocked(h.rt.settings.handle);
  const before = await settings.getMockImplementation()!({ version: 1, type: "settings.get" });
  if (!before.ok) throw new Error("The synthetic settings are unavailable");
  // A vault notice drops what the admission kept, so each test counts from none.
  await ssoVaultChanged(h.rt);
  expect(h.work.ended).toBe(false);
  validate.mockClear();
  return { h, run, validate, mapped, settings, before };
}

describe("an SSO flow's kept mapping", () => {
  it("is read from the vault once for repeated checks", async () => {
    const { h, run, validate } = await atPasswordStep();
    expect(await allowed(h.rt, run)).toBeDefined();
    expect(await allowed(h.rt, run)).toBeDefined();
    expect(await allowed(h.rt, run)).toBeDefined();
    expect(validate).toHaveBeenCalledTimes(1);
  });
  it("is not used once a vault sync gave an account another snapshot", async () => {
    const { h, run, validate, settings, before } = await atPasswordStep();
    expect(await allowed(h.rt, run)).toBeDefined();
    const synced = structuredClone(before);
    synced.catalog.connections = synced.catalog.connections.map((connection) =>
      connection.id === "idp-vault"
        ? { ...connection, snapshotId: "b0000000-0000-4000-8000-000000000002" }
        : connection,
    );
    settings.mockImplementation(async () => structuredClone(synced));
    // The flow depends on that snapshot: the check refuses, as it did with no kept mapping.
    expect(await allowed(h.rt, run)).toBeUndefined();
    expect(validate).toHaveBeenCalledTimes(1);
  });
  it("does not keep a login going past a settings save that stops it", async () => {
    const { h, run } = await atPasswordStep();
    expect(await allowed(h.rt, run)).toBeDefined();
    // A save that writes more than a choice stops every running login, as before.
    settingsChanged(h.rt, "saved");
    expect(await allowed(h.rt, run)).toBeUndefined();
  });
  it("is read again after a choice-only save, and kept under its revision", async () => {
    const { h, run, validate, mapped, settings, before } = await atPasswordStep();
    expect(await allowed(h.rt, run)).toBeDefined();
    // Its notice alone drops the mapping, whatever the revision.
    settingsChanged(h.rt, "saved", "sso-mapping");
    expect(await allowed(h.rt, run)).toBeDefined();
    expect(validate).toHaveBeenCalledTimes(2);
    // A choice of SSO method saved in another tab: a new revision that writes only a choice.
    const chosen = {
      ...before,
      snapshot: {
        ...before.snapshot,
        revision: 4,
        changes: [{ revision: 4, cause: "sso-mapping" as const }],
      },
    };
    settings.mockImplementation(async () => structuredClone(chosen));
    validate.mockImplementation(async () => ({
      ...mapped,
      data: { ...mapped.data, policyRevision: 4 },
    }));
    expect(await allowed(h.rt, run)).toBeDefined();
    expect(validate).toHaveBeenCalledTimes(3);
    expect(await allowed(h.rt, run)).toBeDefined();
    expect(validate).toHaveBeenCalledTimes(3);
  });
  it("is read again under the newer revision when a choice-only save lands between two scope checks", async () => {
    const { h, run, validate, mapped, settings, before } = await atPasswordStep();
    const chosen = {
      ...before,
      snapshot: {
        ...before.snapshot,
        revision: 4,
        changes: [{ revision: 4, cause: "sso-mapping" as const }],
      },
    };
    // The save lands once the first scope check read the mapping, before any notice of it.
    validate.mockImplementationOnce(async () => {
      settings.mockImplementation(async () => structuredClone(chosen));
      validate.mockImplementation(async () => ({
        ...mapped,
        data: { ...mapped.data, policyRevision: 4 },
      }));
      return mapped;
    });
    expect(await allowed(h.rt, run)).toBeDefined();
    expect(validate).toHaveBeenCalledTimes(2);
  });
  it("is not used while its vault is locked, and is read again once it is unlocked", async () => {
    const { h, run, validate } = await atPasswordStep();
    expect(await allowed(h.rt, run)).toBeDefined();
    let unlocked = false;
    h.rt.options.bindingSnapshotCurrent = () => unlocked;
    await ssoVaultChanged(h.rt);
    expect(await allowed(h.rt, run)).toBeUndefined();
    unlocked = true;
    expect(await allowed(h.rt, run)).toBeDefined();
    expect(validate).toHaveBeenCalledTimes(2);
  });
  it("never serves a mapping the vault revoked", async () => {
    const { h, run, validate, mapped } = await atPasswordStep();
    expect(await allowed(h.rt, run)).toBeDefined();
    // The vault no longer maps the method, and says so in a notice.
    validate.mockResolvedValue({ ok: false, reason: "mapping-unresolved" } as never);
    await ssoVaultChanged(h.rt);
    expect(await allowed(h.rt, run)).toBeUndefined();
    expect(validate).toHaveBeenCalledTimes(2);
    // A refusal is never kept: the next check asks the vault again.
    expect(await allowed(h.rt, run)).toBeUndefined();
    expect(validate).toHaveBeenCalledTimes(3);
    // A read under way when the vault revoked the mapping is not used by its scope check.
    validate.mockReset();
    let answer: (value: typeof mapped) => void = () => undefined;
    validate.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)));
    validate.mockResolvedValue({ ok: false, reason: "mapping-unresolved" } as never);
    const checked = ssoScope(h.rt, h.work, run.live);
    await vi.waitFor(() => expect(validate).toHaveBeenCalledTimes(1));
    await ssoVaultChanged(h.rt);
    answer(mapped);
    expect(await checked).toBeUndefined();
    expect(validate).toHaveBeenCalledTimes(2);
  });
});
