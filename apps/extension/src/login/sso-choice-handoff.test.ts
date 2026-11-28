import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  evidence,
  idpOrigin,
  otherItem,
  selected,
  snapshotId,
  ssoHarness,
  type SsoHarness,
} from "./sso-choice-fixture";

// A hand-off (owner, 2026-11-28 07:42 UTC, ADR 0085 amendment of that day, #1847): on a page
// that asks for an identifier alone, a mapped URL-form method that finds no entry resolves
// the native `password` route marked `handoff`, after the method's own validation.
const fixtures: SsoHarness[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_800_000_000_000);
});
afterEach(() => {
  for (const h of fixtures.splice(0)) h.controller.invalidateAll();
  vi.useRealTimers();
});
const native = { passkey: false, password: false, handoff: true };
/** The IdP's side allows the hop: its sign-in is `auto` and it is not paused. */
const auto = { automatic: true as const, native, hopAllowed: async () => true };
const handoff = { kind: "native", route: "password", handoff: true };
/** A URL-form method whose one IdP item discovery found is used without a mapping. */
function urlForm(form: "url" | "bracket" = "url") {
  const h = ssoHarness([
    {
      method: { number: 1 },
      automatic: true,
      form,
      ...(form === "bracket" ? { label: "Synthetic provider" } : {}),
    },
  ]);
  fixtures.push(h);
  return h;
}
const entry = [{ id: "provider", label: "Continue with the provider" }];
const pendingOf = async (pending: { result: Promise<unknown> }) => {
  let answer: unknown;
  void pending.result.then((value) => {
    answer = value;
    return undefined;
  });
  await Promise.resolve();
  return answer;
};

describe("the automatic order's hand-off", () => {
  it("resolves the native password route as a hand-off when no entry is found", async () => {
    const h = urlForm();
    const pending = await h.request(auto);
    expect(pending.waiting).toBeUndefined();
    const answer = await pending.result;
    if (!answer.ok) throw new Error(answer.reason);
    const validated = h.source.validate.mock.calls.length;
    expect(await h.controller.consume(answer.choiceId)).toMatchObject({
      ok: true,
      selection: handoff,
    });
    // The mapping is validated again when the receipt is consumed.
    expect(h.source.validate.mock.calls.length).toBeGreaterThan(validated);
    expect(h.records()).toEqual([]);
  });

  it("waits for the entry, as before, without the page's hand-off", async () => {
    const h = urlForm();
    const pending = await h.request({
      automatic: true,
      native: { passkey: false, password: false },
    });
    expect(pending.waiting).toBe(true);
    expect(await pendingOf(pending)).toBeUndefined();
    expect(await h.offer()).toMatchObject({ reason: "entry-required" });
  });

  it("presses an entry whose destination is the mapped origin instead", async () => {
    const h = urlForm();
    const pending = await h.request({
      ...auto,
      entries: entry,
      entryCurrent: async () => true,
      entryOrigin: async (_id: string, origin: string) => origin === idpOrigin,
    });
    const answer = await pending.result;
    if (!answer.ok) throw new Error(answer.reason);
    expect(await h.controller.consume(answer.choiceId)).toMatchObject({
      selection: { kind: "sso", selected, entryId: "provider" },
    });
  });

  it("presses the learned or labeled entry instead", async () => {
    const h = urlForm();
    const pending = await h.request({
      ...auto,
      entries: entry,
      entryCurrent: async () => true,
      entryOrigin: async (): Promise<boolean> => false,
      entryLearned: async (): Promise<boolean> => true,
    });
    const answer = await pending.result;
    if (!answer.ok) throw new Error(answer.reason);
    expect(await h.controller.consume(answer.choiceId)).toMatchObject({
      selection: { kind: "sso", entryId: "provider" },
    });
  });

  it("waits for the person's mapping when two IdP items qualify, typing nothing", async () => {
    const h = urlForm();
    h.candidateLists.set(1, [
      { account: selected.account, snapshotId, origins: [idpOrigin] },
      { account: { connectionId: "other", itemId: otherItem }, snapshotId, origins: [idpOrigin] },
    ]);
    const pending = await h.request(auto);
    expect(pending.waiting).toBe(true);
    expect(await pendingOf(pending)).toBeUndefined();
    expect(await h.offer()).toMatchObject({ reason: "mapping-required" });
  });

  it("is refused when the vault refuses the method's IdP", async () => {
    const h = urlForm();
    // Discovery's own check passes; the hand-off's validation is refused.
    h.source.validate
      .mockResolvedValueOnce({
        ok: true,
        data: { sourceEvidence: evidence, policyRevision: 7, candidates: [] },
      })
      .mockResolvedValueOnce({ ok: false, reason: "idp-unavailable" });
    const pending = await h.request(auto);
    expect(await pending.result).toEqual({ ok: false, reason: "idp-unavailable" });
  });

  it("is withdrawn when the vault refuses the IdP once the receipt is consumed", async () => {
    const h = urlForm();
    const answer = await (await h.request(auto)).result;
    if (!answer.ok) throw new Error(answer.reason);
    h.source.validate.mockResolvedValueOnce({ ok: false, reason: "idp-unavailable" });
    expect(await h.controller.consume(answer.choiceId)).toEqual({
      ok: false,
      reason: "idp-unavailable",
    });
  });

  it("leaves a bracket-form method's route as it is", async () => {
    const h = urlForm("bracket");
    h.setRecords([
      {
        provider: "bitwarden",
        server: "cloud-us",
        userId: h.saved.catalog.connections[0]!.userId!,
        itemId: h.input.account.itemId,
        method: 1,
        idp: {
          provider: "bitwarden",
          server: "cloud-us",
          userId: h.saved.catalog.connections[1]!.userId!,
          itemId: selected.account.itemId,
          origin: idpOrigin,
        },
      },
    ]);
    const answer = await (await h.request(auto)).result;
    if (!answer.ok) throw new Error(answer.reason);
    expect(await h.controller.consume(answer.choiceId)).toMatchObject({
      selection: { kind: "sso", selected, label: "Synthetic provider" },
    });
  });

  it.each([
    [
      "two entries reach the mapped origin",
      {
        entries: [...entry, { id: "again", label: "More" }],
        entryOrigin: async (_id: string, origin: string) => origin === idpOrigin,
      },
    ],
    [
      "two entries were learned for it",
      {
        entries: [...entry, { id: "again", label: "More" }],
        entryOrigin: async (): Promise<boolean> => false,
        entryLearned: async (): Promise<boolean> => true,
      },
    ],
    [
      "the entry its label names may not be pressed",
      {
        entries: [{ id: "provider", label: "Sign in with Synthetic idp item" }],
        entryOrigin: async (): Promise<boolean> => false,
        entryLearned: async (): Promise<boolean> => false,
        entryLabeled: async (): Promise<boolean> => false,
      },
    ],
    [
      "a link the flow never presses names the IdP",
      {
        entries: [],
        otherLabels: ["Sign in with Synthetic idp item"],
        entryOrigin: async (): Promise<boolean> => false,
        entryLearned: async (): Promise<boolean> => false,
        entryLabeled: async (): Promise<boolean> => true,
      },
    ],
  ])("waits for the person's entry choice, handing nothing off, when %s", async (_, page) => {
    const h = urlForm();
    const pending = await h.request({ ...auto, entryCurrent: async () => true, ...page });
    expect(pending.waiting).toBe(true);
    expect(await pendingOf(pending)).toBeUndefined();
    expect(await h.offer()).toMatchObject({ reason: "entry-required" });
  });

  it.each([
    ["the IdP's side refuses the hop", { hopAllowed: async () => false }],
    ["its check fails", { hopAllowed: async () => Promise.reject(new Error("gone")) }],
    ["no check is given", {}],
  ])("waits, its line naming the IdP's scope, when %s", async (_, overrides) => {
    const h = urlForm();
    const pending = await h.request({ automatic: true, native, ...overrides });
    expect(pending.waiting).toBe(true);
    expect(await pendingOf(pending)).toBeUndefined();
    expect(await h.offer()).toMatchObject({ reason: "entry-required" });
    h.controller.documentChanged({ tabId: 7, frameId: 0 }, "page-changed");
    expect(await pending.result).toEqual({
      ok: false,
      reason: "page-changed",
      waited: "entry-required",
      handoff: "idp-scope",
    });
  });

  it("never shows the hand-off on the popup's wire", async () => {
    const h = urlForm();
    h.candidateLists.set(1, []);
    await h.request(auto);
    const shown = await h.offer();
    expect(shown).not.toHaveProperty("handoff");
    expect(shown).toMatchObject({ passkey: false, password: false });
  });
});

describe("Log in now's hand-off", () => {
  it("hands off where the hop to the mapped IdP is allowed", async () => {
    const h = urlForm();
    const hopAllowed = vi.fn(async () => true);
    const answer = await (await h.request({ automatic: "sso", native, hopAllowed })).result;
    if (!answer.ok) throw new Error(answer.reason);
    expect(hopAllowed).toHaveBeenCalledWith(idpOrigin);
    expect(await h.controller.consume(answer.choiceId)).toMatchObject({ selection: handoff });
  });

  it("leaves the chooser open where it is not", async () => {
    const h = urlForm();
    const pending = await h.request({ automatic: "sso", native, hopAllowed: async () => false });
    expect(pending.waiting).toBe(true);
    expect(await pendingOf(pending)).toBeUndefined();
  });
});
