import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SsoCandidate } from "./sso-vault";
import {
  evidence,
  idpOrigin,
  otherItem,
  selected,
  snapshotId,
  ssoHarness,
  type SsoHarness,
} from "./sso-choice-fixture";

// A URL-form method without a saved mapping (ADR 0085 amendment of 2026-11-18, owner:
// SSO starts automatically on the login page): where discovery finds exactly one IdP item,
// whose own concrete URIs hold the method's origin and whose username is the site item's,
// that item is used for this sign-in, unsaved. Discovery itself compares the usernames
// and reads only concrete URIs (`sso-vault.ts`, `crypto/sso.ts`).
const fixtures: SsoHarness[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_800_000_000_000);
});
afterEach(() => {
  for (const h of fixtures.splice(0)) h.controller.invalidateAll();
  vi.useRealTimers();
});
const automatic = { automatic: true, native: { passkey: false, password: true } };
// The one entry whose own destination is the IdP origin, pressed by the exact rule.
const pressable = {
  ...automatic,
  entries: [{ id: "provider", label: "Continue" }],
  entryCurrent: async () => true,
  entryOrigin: async (_id: string, origin: string) => origin === idpOrigin,
};
const other = { account: { connectionId: "other", itemId: otherItem }, snapshotId };
function setup(form: "url" | "bracket" = "url") {
  const h = ssoHarness([
    { method: { number: 1 }, automatic: true, form, ...(form === "url" ? {} : { label: "P" }) },
  ]);
  fixtures.push(h);
  const found = (candidates: SsoCandidate[]) =>
    h.source.candidates.mockResolvedValue({
      ok: true,
      data: { sourceEvidence: evidence, policyRevision: h.saved.snapshot.revision, candidates },
    });
  return { h, found };
}
const pendingOf = async (pending: { result: Promise<unknown> }) => {
  let answer: unknown;
  void pending.result.then((value) => {
    answer = value;
    return undefined;
  });
  await Promise.resolve();
  return answer;
};

describe("a URL-form method's only IdP item", () => {
  it("is used by itself, validated as a saved mapping is, and never saved", async () => {
    const { h } = setup();
    const pending = await h.request(pressable);
    const answer = await pending.result;
    if (!answer.ok) throw new Error(answer.reason);
    expect(h.source.validate).toHaveBeenCalledWith(
      expect.objectContaining({ method: { number: 1 } }),
      selected,
      undefined,
    );
    expect(await h.controller.consume(answer.choiceId)).toMatchObject({
      ok: true,
      selection: { kind: "sso", selected, entryId: "provider" },
    });
    expect(h.updateSettings).not.toHaveBeenCalled();
    expect(h.saved.snapshot.settings.ssoMappings ?? []).toEqual([]);
  });

  it("is decided again on the next offer, as after a vault change adds a second item", async () => {
    const { h, found } = setup();
    expect((await (await h.request(pressable)).result).ok).toBe(true);
    found([
      { account: selected.account, snapshotId, origins: [idpOrigin] },
      { ...other, origins: [idpOrigin] },
    ]);
    const pending = await h.request(automatic);
    expect(pending.waiting).toBe(true);
    expect(await h.offer()).toMatchObject({ reason: "mapping-required" });
  });

  it.each([
    [
      "two IdP items hold the origin",
      [
        { account: selected.account, snapshotId, origins: [idpOrigin] },
        { ...other, origins: [idpOrigin] },
      ],
    ],
    // Discovery leaves out an item whose username is not the site item's.
    ["no item has the site item's username", []],
  ])("leaves the mapping to the person when %s", async (_, candidates) => {
    const { h, found } = setup();
    found(candidates);
    const pending = await h.request(automatic);
    expect(pending.waiting).toBe(true);
    expect(await pendingOf(pending)).toBeUndefined();
    const shown = await h.offer();
    expect(shown).toMatchObject({ reason: "mapping-required" });
    // The popup's explicit mapping chooser lists them, none chosen.
    expect(shown.methods[0]).not.toHaveProperty("selectedId");
    expect(shown.methods[0]!.candidates).toHaveLength(candidates.length);
    expect(h.source.validate).not.toHaveBeenCalled();
  });

  it("keeps discovery's refusal, as for an item that holds the origin only by a Regex rule", async () => {
    const { h } = setup();
    h.source.candidates.mockResolvedValue({ ok: false, reason: "uri-unavailable" });
    const pending = await h.request(automatic);
    expect(pending.waiting).toBe(true);
    expect(await h.offer()).toMatchObject({ reason: "uri-unavailable" });
    expect(h.source.validate).not.toHaveBeenCalled();
  });

  it("is not used when its validation refuses", async () => {
    const { h } = setup();
    h.source.validate.mockResolvedValue({ ok: false, reason: "field-unreadable" });
    const pending = await h.request(automatic);
    expect(pending.waiting).toBe(true);
    expect(await h.offer()).toMatchObject({ reason: "mapping-required" });
  });

  it("is not used for a bracket-form method, whose label never selects an account", async () => {
    const { h } = setup("bracket");
    const pending = await h.request(automatic);
    expect(pending.waiting).toBe(true);
    expect(await h.offer()).toMatchObject({ reason: "mapping-required" });
    expect(h.source.validate).not.toHaveBeenCalled();
  });

  it("is never used over a saved mapping that no longer qualifies", async () => {
    const { h, found } = setup();
    await h.request();
    expect(await h.choose()).toEqual({ ok: true });
    // The saved IdP item is refused; discovery now finds another one alone.
    h.source.validate.mockResolvedValueOnce({ ok: false, reason: "item-inactive" });
    found([{ ...other, origins: [idpOrigin] }]);
    const pending = await h.request(pressable);
    expect(pending.waiting).toBe(true);
    expect(await h.offer()).toMatchObject({ reason: "item-inactive" });
    expect(h.source.validate).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ account: other.account }),
      undefined,
    );
  });

  it("is not used when its account is not in the vault catalog", async () => {
    const { h, found } = setup();
    found([
      { account: { connectionId: "gone", itemId: otherItem }, snapshotId, origins: [idpOrigin] },
    ]);
    const pending = await h.request(pressable);
    expect(pending.waiting).toBe(true);
    expect(await h.offer()).toMatchObject({ reason: "mapping-required" });
    expect(h.source.validate).not.toHaveBeenCalled();
  });

  it("is not used once the offer is withdrawn while it is validated", async () => {
    const { h } = setup();
    h.source.validate.mockImplementation(async () => {
      h.controller.invalidateAll();
      return { ok: true, data: { sourceEvidence: evidence, policyRevision: 7, candidates: [] } };
    });
    const pending = await h.request(pressable);
    expect(await pending.result).toMatchObject({ ok: false });
    const after = await h.controller.get(7);
    expect(after.ok && after.offer).toBeFalsy();
  });

  it("tells the popup it is inferred, and has no mapping to remove", async () => {
    const { h } = setup();
    // No entry is decided, so the offer waits for the person, with the IdP inferred.
    const pending = await h.request(automatic);
    expect(pending.waiting).toBe(true);
    const shown = await h.offer();
    expect(shown.methods[0]).toMatchObject({ inferred: true, selectedId: expect.any(String) });
    expect(shown.methods[0]).not.toHaveProperty("mapped");
    expect(
      await h.controller.choose({
        tabId: 7,
        offerId: shown.id,
        selection: { kind: "unmap", method: { number: 1 } },
      }),
    ).toEqual({ ok: false, reason: "mapping-not-saved" });
    expect(h.updateSettings).not.toHaveBeenCalled();
    expect((await h.offer()).methods[0]).toMatchObject({ inferred: true });
  });

  it("is saved only when the person maps it in the chooser", async () => {
    const { h } = setup();
    await h.request();
    expect(await h.choose()).toEqual({ ok: true });
    expect(h.updateSettings).toHaveBeenCalledTimes(1);
  });
});
