import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../storage", () => ({
  trustedRecord: () => {
    throw new Error("Use synthetic storage");
  },
}));
import { ssoResponseSchema } from "./sso-wire";
import * as v from "valibot";
import {
  account,
  document,
  evidence,
  idpOrigin,
  selected,
  snapshotId,
  targetItem,
  sourceRef,
  connection,
  ssoHarness,
  type SsoHarness,
} from "./sso-choice-fixture";
const fixtures: SsoHarness[] = [];
const start = (...args: Parameters<typeof ssoHarness>) => {
  const h = ssoHarness(...args);
  fixtures.push(h);
  return h;
};
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_800_000_000_000);
});
afterEach(() => {
  for (const h of fixtures.splice(0)) h.controller.invalidateAll();
  vi.useRealTimers();
});
async function result(h: SsoHarness, selection: "sso" | "passkey" | "password" = "sso") {
  const pending = await h.request();
  await h.choose();
  if (selection === "sso") expect(await h.choose("sso")).toEqual({ ok: true });
  else
    expect(
      await h.controller.choose({
        tabId: 7,
        offerId: pending.offerId,
        selection: { kind: "native", route: selection },
      }),
    ).toEqual({ ok: true });
  const answer = await pending.result;
  if (!answer.ok) throw new Error(answer.reason);
  return answer.choiceId;
}
describe("local SSO method chooser", () => {
  it("chooses a provider for the already selected account and consumes one exact receipt once", async () => {
    const h = start();
    const before = structuredClone(h.saved);
    const id = await result(h);
    expect(await h.controller.consume(id)).toEqual({
      ok: true,
      document,
      account,
      selection: { kind: "sso", source: sourceRef(), selected, label: "Synthetic provider" },
    });
    expect(await h.controller.consume(id)).toEqual({ ok: false, reason: "choice-gone" });
    expect(h.saved).toEqual(before);
    expect(h.source.validate).toHaveBeenCalledWith(sourceRef(), selected);
    const stored = h.records();
    expect(stored).toHaveLength(1);
    expect(JSON.stringify(stored)).not.toMatch(/Synthetic provider|username|proof|fieldId/u);
  });
  it("exposes opaque candidate IDs, fixed safe descriptors and local item labels only", async () => {
    const h = start();
    await h.request();
    const shown = await h.offer();
    expect(v.safeParse(ssoResponseSchema, { ok: true, offer: shown }).success).toBe(true);
    expect(shown.accountLabel).toBe("Synthetic site item");
    expect(shown.methods[0]!.candidates[0]!.id).not.toBe(targetItem);
    expect(JSON.stringify(shown)).not.toMatch(
      /sourceEvidence|usernameProof|fieldId|userId|snapshotId/u,
    );
  });
  it.each(["passkey", "sso", "password"] as const)(
    "automatically prefers %s with all enabled mappings validated",
    async (route) => {
      const h = start(route === "password" ? [] : undefined);
      if (route !== "password") {
        await h.request();
        await h.choose();
      }
      const pending = await h.request({
        automatic: true,
        native: { passkey: route === "passkey", password: true },
      });
      const answer = await pending.result;
      expect(answer.ok).toBe(true);
      if (!answer.ok) return;
      expect(await h.controller.consume(answer.choiceId)).toMatchObject({
        ok: true,
        selection: route === "sso" ? { kind: "sso" } : { kind: "native", route },
      });
    },
  );
  it("keeps a numbered alternative explicit and never silently chooses it", async () => {
    const h = start([
      { method: { number: 2 }, automatic: false, form: "bracket", label: "Alternative" },
    ]);
    await h.request();
    await h.choose("mapping", 2);
    const pending = await h.request({
      automatic: true,
      native: { passkey: false, password: false },
    });
    let settled = false;
    void pending.result.then(() => {
      settled = true;
      return undefined;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect((await h.offer()).methods.map((entry) => entry.method.number)).toEqual([2]);
    expect(await h.choose("sso", 2)).toEqual({ ok: true });
    expect((await pending.result).ok).toBe(true);
  });
  it("does not fallback to native routes while a configured method is unresolved", async () => {
    const h = start();
    const pending = await h.request({ automatic: true });
    expect((await h.offer()).reason).toBe("mapping-required");
    expect(
      await h.controller.choose({
        tabId: 7,
        offerId: pending.offerId,
        selection: { kind: "native", route: "passkey" },
      }),
    ).toEqual({ ok: false, reason: "mapping-required" });
    expect(h.source.validate).not.toHaveBeenCalled();
  });
  it("a malformed configured source blocks the whole choice without a native fallback or secret in the error", async () => {
    const h = start();
    h.source.describe.mockResolvedValue({ ok: false, reason: "invalid-value", field: "SSO 2" });
    const pending = await h.request({ automatic: true });
    expect(await pending.result).toEqual({ ok: false, reason: "invalid-value" });
    expect(await h.offer()).toMatchObject({
      blocked: true,
      field: "SSO 2",
      reason: "invalid-value",
    });
    expect(h.source.candidates).not.toHaveBeenCalled();
  });
  it("IdP mode offers native routes and never discovers or executes a nested provider", async () => {
    const h = start();
    const pending = await h.request({ asIdentityProvider: true });
    expect((await h.offer()).methods).toEqual([]);
    expect(h.source.candidates).not.toHaveBeenCalled();
    expect(
      await h.controller.choose({
        tabId: 7,
        offerId: pending.offerId,
        selection: { kind: "native", route: "password" },
      }),
    ).toEqual({ ok: true });
    const answer = await pending.result;
    if (!answer.ok) throw new Error(answer.reason);
    expect(await h.controller.consume(answer.choiceId)).toMatchObject({
      ok: true,
      selection: { kind: "native", route: "password" },
    });
  });
  it("URL form needs a real observed entry, never a guessed provider label", async () => {
    const h = start([{ method: { number: 1 }, automatic: true, form: "url" }]);
    const entryCurrent = vi.fn(async () => true);
    const pending = await h.request({
      entries: [{ id: "observed-entry", label: "Continue with local provider" }],
      entryCurrent,
    });
    await h.choose();
    expect((await h.offer()).password).toBe(false);
    expect(await h.choose("sso")).toEqual({ ok: false, reason: "entry-required" });
    expect(await h.choose("sso", 1, { entryId: "guessed-domain" })).toEqual({
      ok: false,
      reason: "entry-required",
    });
    expect(await h.choose("sso", 1, { entryId: "observed-entry" })).toEqual({ ok: true });
    const answer = await pending.result;
    if (!answer.ok) throw new Error(answer.reason);
    entryCurrent.mockResolvedValue(false);
    expect(await h.controller.consume(answer.choiceId)).toEqual({
      ok: false,
      reason: "entry-changed",
    });
    expect(await h.controller.consume(answer.choiceId)).toEqual({
      ok: false,
      reason: "choice-gone",
    });
  });
  it("refuses duplicate IdP identities even through two connection IDs and origins", async () => {
    const h = start([
      { method: { number: 1 }, automatic: true, form: "bracket", label: "One" },
      { method: { number: 2 }, automatic: false, form: "bracket", label: "Two" },
    ]);
    const duplicate = connection("duplicate", targetItem);
    Object.assign(duplicate, { provider: "bitwarden", server: "cloud-us", userId: targetItem });
    h.saved.catalog.connections.push(duplicate);
    h.candidateLists.set(2, [
      {
        account: { connectionId: "duplicate", itemId: targetItem.toUpperCase() },
        snapshotId,
        origins: ["https://another-idp.example.test"],
      },
    ]);
    const pending = await h.request();
    await h.choose("mapping", 1);
    await h.choose("mapping", 2);
    expect(await h.choose("sso")).toEqual({ ok: false, reason: "duplicate-idp" });
    expect(
      await h.controller.choose({
        tabId: 7,
        offerId: pending.offerId,
        selection: { kind: "native", route: "password" },
      }),
    ).toEqual({ ok: false, reason: "duplicate-idp" });
  });
  it("supports explicit mapping replacement and removal without modifying settings/defaults", async () => {
    const h = start();
    h.candidateLists.get(1)![0]!.origins.push("https://alternate-idp.example.test");
    await h.request();
    const before = structuredClone(h.saved);
    let shown = await h.offer();
    await h.choose();
    expect(h.records()[0]!.selected.origin).toBe(idpOrigin);
    shown = await h.offer();
    const alternate = shown.methods[0]!.candidates[1]!;
    expect(
      await h.controller.choose({
        tabId: 7,
        offerId: shown.id,
        selection: { kind: "mapping", method: { number: 1 }, candidateId: alternate.id },
      }),
    ).toEqual({ ok: true });
    expect(h.records()).toHaveLength(1);
    expect(h.records()[0]!.selected.origin).toBe(alternate.origin);
    expect(
      await h.controller.choose({
        tabId: 7,
        offerId: shown.id,
        selection: { kind: "unmap", method: { number: 1 } },
      }),
    ).toEqual({ ok: true });
    expect(h.records()).toEqual([]);
    expect((await h.offer()).methods[0]!.selectedId).toBeUndefined();
    expect(h.saved).toEqual(before);
  });
  it.each(["settings", "catalog", "document", "excluded", "locked", "source", "signal"] as const)(
    "refuses a receipt after %s changes",
    async (change) => {
      const h = start();
      const abort = new AbortController();
      h.input.signal = abort.signal;
      const id = await result(h);
      if (change === "settings") h.saved.snapshot.revision += 1;
      if (change === "catalog")
        h.saved.catalog.connections[1]!.snapshotId = "b0000000-0000-4000-8000-000000000002";
      if (change === "document") h.setCurrent(false);
      if (change === "excluded")
        h.saved.snapshot.settings.excludedSites.push({
          hostname: "site.example.test",
          includeSubdomains: false,
        });
      if (change === "locked") h.saved.catalog.connections[1]!.state = "locked";
      if (change === "source")
        h.source.validate.mockResolvedValue({ ok: false, reason: "source-changed" });
      if (change === "signal") abort.abort();
      expect((await h.controller.consume(id)).ok).toBe(false);
      expect(await h.controller.consume(id)).toEqual({ ok: false, reason: "choice-gone" });
    },
  );
  it("withdraws on expiry, explicit cancellation, replacement, and worker recreation", async () => {
    const h = start();
    const first = await h.request();
    expect(h.controller.cancel(7, "wrong-offer")).toEqual({ ok: false, reason: "offer-gone" });
    expect(h.controller.cancel(7, first.offerId)).toEqual({ ok: true });
    expect(await first.result).toEqual({ ok: false, reason: "cancelled" });
    const replaced = await h.request();
    const latest = await h.request();
    expect(await replaced.result).toEqual({ ok: false, reason: "replaced" });
    await vi.advanceTimersByTimeAsync(600_000);
    expect(await latest.result).toEqual({ ok: false, reason: "expired" });
    const id = await result(h);
    const restarted = start();
    expect(await restarted.controller.consume(id)).toEqual({ ok: false, reason: "choice-gone" });
  });
  it("a receipt is one-use even when consumption overlaps an awaited validation", async () => {
    const h = start();
    const id = await result(h);
    const held = Promise.withResolvers<Awaited<ReturnType<typeof h.source.validate>>>();
    h.source.validate.mockClear().mockReturnValueOnce(held.promise);
    const first = h.controller.consume(id);
    await vi.waitFor(() => expect(h.source.validate).toHaveBeenCalled());
    expect(await h.controller.consume(id)).toEqual({ ok: false, reason: "choice-gone" });
    held.resolve({
      ok: true,
      data: { sourceEvidence: evidence, policyRevision: 7, candidates: [] },
    });
    expect((await first).ok).toBe(true);
  });
  it("a replacement during source discovery cannot re-publish or resolve an old offer", async () => {
    const h = start();
    const held = Promise.withResolvers<Awaited<ReturnType<typeof h.source.describe>>>();
    h.source.describe.mockReturnValueOnce(held.promise);
    const stale = h.request();
    await vi.waitFor(() => expect(h.source.describe).toHaveBeenCalledTimes(1));
    const fresh = await h.request();
    held.resolve({ ok: true, data: { sourceEvidence: evidence, policyRevision: 7, methods: [] } });
    const old = await stale;
    expect((await old.result).ok).toBe(false);
    expect((await h.offer()).id).toBe(fresh.offerId);
  });
});

it("a stale popup read cannot withdraw a newer offer created while it awaited settings", async () => {
  const h = start();
  await h.request();
  const held = Promise.withResolvers<Awaited<ReturnType<typeof h.readSettings>>>();
  h.readSettings.mockReturnValueOnce(held.promise);
  const stale = h.controller.get(7);
  const replacement = await h.request();
  held.resolve(structuredClone(h.saved));
  await stale;
  expect((await h.offer()).id).toBe(replacement.offerId);
  let settled = false;
  void replacement.result.then(() => {
    settled = true;
    return undefined;
  });
  await Promise.resolve();
  expect(settled).toBe(false);
});

it("a replacement queued after final validation cannot be consumed as old authority", async () => {
  const h = start();
  const id = await result(h);
  let checks = 0;
  let replacement: ReturnType<typeof h.request> | undefined;
  h.currentDocument.mockImplementation(() => {
    checks += 1;
    // The fifth check is the final retained check inside validateAll's last settings read.
    // Two queued jobs place replacement after that helper resolves and before its caller resumes.
    if (checks === 5)
      queueMicrotask(() =>
        queueMicrotask(() => {
          replacement = h.request();
        }),
      );
    return true;
  });
  expect((await h.controller.consume(id)).ok).toBe(false);
  expect(replacement).toBeDefined();
  const fresh = await replacement!;
  expect((await h.offer()).id).toBe(fresh.offerId);
});

it("saving the missing mapping clears its obsolete mapping-required explanation", async () => {
  const h = start();
  await h.request({ automatic: true });
  expect((await h.offer()).reason).toBe("mapping-required");
  expect(await h.choose()).toEqual({ ok: true });
  expect((await h.offer()).reason).toBeUndefined();
});

it("a failed offer expires from memory without a popup read having to clean it up", async () => {
  const h = start();
  h.source.describe.mockResolvedValue({ ok: false, reason: "invalid-value", field: "SSO" });
  const pending = await h.request();
  expect(await pending.result).toEqual({ ok: false, reason: "invalid-value" });
  expect((await h.offer()).blocked).toBe(true);
  await vi.advanceTimersByTimeAsync(600_000);
  expect(await h.controller.get(7)).toEqual({ ok: true });
});

it("concurrent popup choices cannot race two resolutions through one provider validation", async () => {
  const h = start();
  const pending = await h.request();
  await h.choose();
  const shown = await h.offer();
  const held = Promise.withResolvers<Awaited<ReturnType<typeof h.source.validate>>>();
  h.source.validate.mockClear().mockReturnValueOnce(held.promise);
  const first = h.controller.choose({
    tabId: 7,
    offerId: shown.id,
    selection: {
      kind: "sso",
      method: { number: 1 },
      candidateId: shown.methods[0]!.candidates[0]!.id,
    },
  });
  await vi.waitFor(() => expect(h.source.validate).toHaveBeenCalledTimes(1));
  expect(
    await h.controller.choose({
      tabId: 7,
      offerId: shown.id,
      selection: { kind: "native", route: "password" },
    }),
  ).toEqual({ ok: false, reason: "offer-gone" });
  held.resolve({ ok: true, data: { sourceEvidence: evidence, policyRevision: 7, candidates: [] } });
  expect(await first).toEqual({ ok: true });
  const answer = await pending.result;
  if (!answer.ok) throw new Error(answer.reason);
  expect((await h.controller.consume(answer.choiceId)).ok).toBe(true);
});

it("stale offer and candidate IDs cannot select a method in another tab or replacement", async () => {
  const h = start();
  const first = await h.request();
  const original = await h.offer();
  const candidateId = original.methods[0]!.candidates[0]!.id;
  const replacement = await h.request();
  expect(
    await h.controller.choose({
      tabId: 7,
      offerId: first.offerId,
      selection: { kind: "native", route: "password" },
    }),
  ).toEqual({ ok: false, reason: "offer-gone" });
  expect(
    await h.controller.choose({
      tabId: 8,
      offerId: replacement.offerId,
      selection: { kind: "native", route: "password" },
    }),
  ).toEqual({ ok: false, reason: "offer-gone" });
  expect(
    await h.controller.choose({
      tabId: 7,
      offerId: replacement.offerId,
      selection: { kind: "mapping", method: { number: 1 }, candidateId },
    }),
  ).toEqual({ ok: false, reason: "not-a-candidate" });
  expect(h.record.write).not.toHaveBeenCalled();
});

it("a URL entry that changed before explicit choice produces no executable receipt", async () => {
  const h = start([{ method: { number: 1 }, automatic: true, form: "url" }]);
  const pending = await h.request({
    entries: [{ id: "entry", label: "Observed provider" }],
    entryCurrent: async () => false,
  });
  await h.choose();
  expect(await h.choose("sso", 1, { entryId: "entry" })).toEqual({
    ok: false,
    reason: "entry-changed",
  });
  let completed = false;
  void pending.result.then(() => {
    completed = true;
    return undefined;
  });
  await Promise.resolve();
  expect(completed).toBe(false);
});

it("policy invalidation during an awaited consume permanently withdraws that receipt", async () => {
  const h = start();
  const id = await result(h);
  const held = Promise.withResolvers<Awaited<ReturnType<typeof h.source.validate>>>();
  h.source.validate.mockClear().mockReturnValueOnce(held.promise);
  const consuming = h.controller.consume(id);
  await vi.waitFor(() => expect(h.source.validate).toHaveBeenCalled());
  h.controller.invalidateAll("settings-changed");
  held.resolve({ ok: true, data: { sourceEvidence: evidence, policyRevision: 7, candidates: [] } });
  expect((await consuming).ok).toBe(false);
  expect(await h.controller.consume(id)).toEqual({ ok: false, reason: "choice-gone" });
});
