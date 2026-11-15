import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../storage", () => ({
  trustedRecord: () => {
    throw new Error("Use synthetic storage");
  },
}));
import {
  evidence,
  idpOrigin,
  selected,
  sourceItem,
  sourceRef,
  ssoHarness,
  targetItem,
  type SsoHarness,
} from "./sso-choice-fixture";
import type { SsoMapping } from "./sso-mapping-store";

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
const account = (userId: string, itemId: string) => ({
  provider: "bitwarden",
  server: "cloud-us",
  userId,
  itemId,
});
/** A saved mapping of the fixture's site account's method to the fixture's IdP item. */
const saved = (number = 1, itemId = targetItem): SsoMapping => ({
  source: { ...account(sourceItem, sourceItem), method: { number }, sourceEvidence: evidence },
  selected: { ...account(targetItem, itemId), origin: idpOrigin },
});
const two = [
  { method: { number: 1 }, automatic: true, form: "bracket" as const, label: "One" },
  { method: { number: 2 }, automatic: false, form: "bracket" as const, label: "Two" },
];
const native = (h: SsoHarness, offerId: string, route: "passkey" | "password") =>
  h.controller.choose({ tabId: 7, offerId, selection: { kind: "native", route } });

describe("saved SSO mappings", () => {
  it("validates a saved mapping directly, so discovery another item holds back cannot block it", async () => {
    const h = start();
    h.setRecords([saved()]);
    h.source.candidates.mockResolvedValue({ ok: false, reason: "vault-unavailable" });
    const pending = await h.request();
    const shown = await h.offer();
    expect(shown.blocked).toBeUndefined();
    expect(shown.methods[0]!.selectedId).toBeDefined();
    expect(shown.methods[0]!.reason).toBeUndefined();
    expect(h.source.candidates).not.toHaveBeenCalled();
    expect(h.source.validate).toHaveBeenCalledWith(sourceRef(), selected, undefined);
    // Listing other accounts fails, but the saved mapping stays usable.
    expect(
      await h.controller.choose({
        tabId: 7,
        offerId: pending.offerId,
        selection: { kind: "discover", method: { number: 1 } },
      }),
    ).toEqual({ ok: false, reason: "vault-unavailable" });
    expect((await h.offer()).methods[0]!.selectedId).toBe(shown.methods[0]!.selectedId);
    expect(await h.choose("sso")).toEqual({ ok: true });
    expect((await pending.result).ok).toBe(true);
  });
  it("lists other accounts beside the saved one when the person asks", async () => {
    const h = start();
    h.setRecords([saved()]);
    h.candidateLists.get(1)![0]!.origins.push("https://alternate-idp.example.test");
    const pending = await h.request();
    expect((await h.offer()).methods[0]!.candidates).toHaveLength(1);
    expect(
      await h.controller.choose({
        tabId: 7,
        offerId: pending.offerId,
        selection: { kind: "discover", method: { number: 1 } },
      }),
    ).toEqual({ ok: true });
    const listed = (await h.offer()).methods[0]!;
    expect(listed.candidates.map((entry) => entry.origin)).toEqual([
      idpOrigin,
      "https://alternate-idp.example.test",
    ]);
    expect(listed.selectedId).toBe(listed.candidates[0]!.id);
  });
  it("finds a saved IdP account through whichever connection now holds it", async () => {
    const h = start();
    h.setRecords([saved()]);
    h.saved.catalog.connections[1]!.id = "idp-reconnected";
    await h.request();
    expect((await h.offer()).methods[0]!.selectedId).toBeDefined();
    expect(h.source.validate).toHaveBeenCalledWith(
      sourceRef(),
      { account: { connectionId: "idp-reconnected", itemId: targetItem }, origin: idpOrigin },
      undefined,
    );
  });
  it("finds a saved IdP item whatever its ID's letter case", async () => {
    const h = start();
    h.setRecords([saved(1, targetItem.toUpperCase())]);
    await h.request();
    expect((await h.offer()).methods[0]!.selectedId).toBeDefined();
    expect(h.source.validate).toHaveBeenCalledWith(sourceRef(), selected, undefined);
  });
  it("says the mappings cannot be read, and leaves the native routes", async () => {
    const h = start();
    h.record.read.mockRejectedValueOnce(new Error("synthetic storage failure"));
    const pending = await h.request();
    const shown = await h.offer();
    expect(shown.blocked).toBeUndefined();
    expect(shown.methods[0]).toMatchObject({ reason: "mapping-store-unavailable" });
    expect(await native(h, pending.offerId, "password")).toEqual({ ok: true });
  });
  it("says why a saved IdP no longer qualifies, with its canonical field", async () => {
    const h = start();
    h.setRecords([saved()]);
    h.source.validate.mockResolvedValueOnce({ ok: false, reason: "signs-in-with-sso" });
    await h.request();
    expect((await h.offer()).methods[0]).toMatchObject({ reason: "signs-in-with-sso" });
    h.source.validate.mockResolvedValueOnce({
      ok: false,
      reason: "field-unreadable",
      field: "SSO",
    });
    await h.request();
    expect((await h.offer()).methods[0]).toMatchObject({
      reason: "field-unreadable",
      field: "SSO",
    });
  });
  it("a deleted IdP item leaves the native routes to the person", async () => {
    const h = start();
    h.setRecords([saved(1, "a0000000-0000-4000-8000-000000000099")]);
    const pending = await h.request();
    const shown = await h.offer();
    expect(shown.blocked).toBeUndefined();
    expect(shown.methods[0]).toMatchObject({ reason: "mapping-unresolved" });
    expect(await native(h, pending.offerId, "password")).toEqual({ ok: true });
  });
  it("gives a full store its own reason", async () => {
    const h = start();
    h.setRecords(
      Array.from({ length: 1000 }, (_, index) => saved(index + 2)).map((entry) => ({
        ...entry,
        source: { ...entry.source, sourceEvidence: "F".repeat(43) },
      })),
    );
    await h.request();
    expect(await h.choose("mapping")).toEqual({ ok: false, reason: "mapping-limit" });
  });
  it("drops the mappings of deleted items when the vaults change", async () => {
    const h = start();
    h.setRecords([saved(1), saved(2, "a0000000-0000-4000-8000-000000000099")]);
    await h.controller.vaultStateMayChange();
    expect(h.records()).toEqual([saved(1)]);
  });
  it("drops the mappings to a deleted connection, but keeps them while it is unknown", async () => {
    const h = start();
    h.setRecords([saved(1)]);
    const idp = h.saved.catalog.connections[1]!;
    const { userId } = idp;
    delete idp.userId;
    await h.controller.vaultStateMayChange();
    expect(h.records()).toEqual([saved(1)]);
    idp.userId = userId;
    h.saved.catalog.connections.splice(1, 1);
    await h.controller.vaultStateMayChange();
    expect(h.records()).toEqual([]);
  });
});

describe("native routes need no SSO method", () => {
  it("an unmapped numbered method holds back neither the automatic passkey nor an explicit password", async () => {
    const h = start(two);
    h.setRecords([saved(1)]);
    const automatic = await h.request({ automatic: true });
    const answer = await automatic.result;
    expect(answer.ok).toBe(true);
    if (answer.ok)
      expect(await h.controller.consume(answer.choiceId)).toMatchObject({
        ok: true,
        selection: { kind: "native", route: "passkey" },
      });
    const pending = await h.request();
    expect((await h.offer()).methods[1]).toMatchObject({ reason: "mapping-required" });
    expect(await native(h, pending.offerId, "password")).toEqual({ ok: true });
    // The automatic SSO route of method 1 needs only its own mapping.
    const sso = await h.request({ automatic: true, native: { passkey: false, password: true } });
    const chosen = await sso.result;
    expect(chosen.ok).toBe(true);
    if (chosen.ok)
      expect(await h.controller.consume(chosen.choiceId)).toMatchObject({
        ok: true,
        selection: { kind: "sso" },
      });
  });
  it("an automatic choice never takes a password the URL form withheld", async () => {
    const h = start([{ method: { number: 2 }, automatic: false, form: "url" }]);
    const pending = await h.request({
      automatic: true,
      native: { passkey: false, password: true },
    });
    expect((await h.offer()).password).toBe(false);
    expect((await h.offer()).reason).toBe("method-unavailable");
    let settled = false;
    void pending.result.finally(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
  });
});

describe("offer scope", () => {
  it("withdraws a top-frame offer only for its own frame's or the top page's change", async () => {
    const h = start();
    const pending = await h.request();
    h.controller.documentChanged({ tabId: 7, frameId: 3 }, "page-changed");
    expect((await h.offer()).id).toBe(pending.offerId);
    h.controller.documentChanged({ tabId: 7, frameId: 0 }, "page-changed");
    expect(await pending.result).toEqual({ ok: false, reason: "page-changed" });
  });
  it("shows a framed offer as framed, and withdraws it for its frame or the top page", async () => {
    const h = start();
    const framed = { ...h.input.document, frameId: 2, origin: h.input.document.origin };
    const pending = await h.request({ document: framed });
    expect((await h.offer()).frame).toBe(true);
    h.controller.documentChanged({ tabId: 7, frameId: 3 }, "document-gone");
    expect((await h.offer()).id).toBe(pending.offerId);
    h.controller.documentChanged({ tabId: 7, frameId: 2 }, "document-gone");
    expect(await pending.result).toEqual({ ok: false, reason: "document-gone" });
    const again = await h.request({ document: framed });
    h.controller.documentChanged({ tabId: 7, frameId: 0 }, "page-changed");
    expect(await again.result).toEqual({ ok: false, reason: "page-changed" });
  });
  it("a receipt is not consumed on another path of its document", async () => {
    const h = start();
    const pending = await h.request();
    expect(await native(h, pending.offerId, "password")).toEqual({ ok: true });
    const answer = await pending.result;
    if (!answer.ok) throw new Error(answer.reason);
    h.setPath("/other");
    expect(await h.controller.consume(answer.choiceId)).toEqual({
      ok: false,
      reason: "scope-changed",
    });
  });
  it("a request ended by a settings change while it read settings says so", async () => {
    const h = start();
    const held = Promise.withResolvers<Awaited<ReturnType<typeof h.readSettings>>>();
    h.readSettings.mockReturnValueOnce(held.promise);
    const requesting = h.request();
    h.controller.invalidateAll("settings-changed");
    held.resolve(structuredClone(h.saved));
    const pending = await requesting;
    expect(await pending.result).toEqual({ ok: false, reason: "settings-changed" });
  });
  it("no popup choice runs before the automatic decision settles", async () => {
    const h = start();
    h.setRecords([saved()]);
    const held = Promise.withResolvers<Awaited<ReturnType<typeof h.source.validate>>>();
    h.source.validate
      .mockResolvedValueOnce({
        ok: true,
        data: { sourceEvidence: evidence, policyRevision: 7, candidates: [] },
      })
      .mockReturnValueOnce(held.promise);
    const requesting = h.request({ automatic: true, native: { passkey: false, password: true } });
    await vi.waitFor(() => expect(h.source.validate).toHaveBeenCalledTimes(2));
    expect(await h.controller.get(7)).toEqual({ ok: true });
    held.resolve({
      ok: true,
      data: { sourceEvidence: evidence, policyRevision: 7, candidates: [] },
    });
    const pending = await requesting;
    expect((await pending.result).ok).toBe(true);
  });
  it("a bracket method's SSO choice takes no observed entry", async () => {
    const h = start();
    await h.request({ entries: [{ id: "observed-entry", label: "Synthetic entry" }] });
    await h.choose();
    expect(await h.choose("sso", 1, { entryId: "observed-entry" })).toEqual({
      ok: false,
      reason: "entry-unexpected",
    });
  });
  it.each([
    [
      "too many entries",
      Array.from({ length: 101 }, (_, index) => ({ id: `e${index}`, label: "E" })),
    ],
    ["a label over 200 characters", [{ id: "long", label: "L".repeat(201) }]],
    [
      "two entries with one ID",
      [
        { id: "same", label: "A" },
        { id: "same", label: "B" },
      ],
    ],
  ])("refuses %s before making an offer", async (_name, entries) => {
    const h = start();
    const pending = await h.request({ entries });
    expect(await pending.result).toEqual({ ok: false, reason: "entry-invalid" });
    expect(await h.controller.get(7)).toEqual({ ok: true });
    expect(h.source.describe).not.toHaveBeenCalled();
  });
  it("a failure while preparing ends the offer instead of leaving it waiting", async () => {
    const h = start();
    h.source.describe.mockRejectedValueOnce(new Error("synthetic failure"));
    const pending = await h.request();
    expect(await pending.result).toEqual({ ok: false, reason: "unavailable" });
    expect(await h.offer()).toMatchObject({ blocked: true, reason: "unavailable" });
  });
  it("an IdP account in a connection the catalog does not know is not called the site's own", async () => {
    const h = start();
    h.candidateLists.set(1, [
      {
        account: { connectionId: "missing", itemId: targetItem },
        snapshotId: "x",
        origins: [idpOrigin],
      },
    ]);
    await h.request();
    expect(await h.choose("mapping")).toEqual({ ok: false, reason: "vault-unavailable" });
  });
});
