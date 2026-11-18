import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { idpOrigin, selected, ssoHarness, type SsoHarness } from "./sso-choice-fixture";

// A broker page (ADR 0085 amendment of 2026-11-18): the provider button submits to the
// site, which sends the tab on to the IdP, so no entry's own destination is the mapped
// origin. The automatic choice presses the one entry the page's SSO layout learned.
const fixtures: SsoHarness[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_800_000_000_000);
});
afterEach(() => {
  for (const h of fixtures.splice(0)) h.controller.invalidateAll();
  vi.useRealTimers();
});
const entries = [
  { id: "provider", label: "Continue with the provider" },
  { id: "password", label: "Continue" },
];
const automatic = { automatic: true, native: { passkey: false, password: true } };
/** A URL-form method whose mapping the person saved earlier. */
async function mapped(save = true) {
  const h = ssoHarness([{ method: { number: 1 }, automatic: true, form: "url" }]);
  fixtures.push(h);
  if (save) {
    await h.request();
    expect(await h.choose()).toEqual({ ok: true });
  }
  return h;
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

describe("a broker page's learned entry", () => {
  it("is pressed automatically when no entry names the mapped origin", async () => {
    const h = await mapped();
    const entryLearned = vi.fn(async (id: string) => id === "provider");
    const pending = await h.request({
      ...automatic,
      entries,
      entryCurrent: async () => true,
      entryOrigin: async () => false,
      entryLearned,
    });
    expect(pending.waiting).toBeUndefined();
    const answer = await pending.result;
    if (!answer.ok) throw new Error(answer.reason);
    expect(await h.controller.consume(answer.choiceId)).toMatchObject({
      ok: true,
      selection: {
        kind: "sso",
        selected,
        entryId: "provider",
        label: "Continue with the provider",
      },
    });
  });

  it("leaves an exact-origin entry to the existing rule, without asking for learned ones", async () => {
    const h = await mapped();
    const entryLearned = vi.fn(async () => true);
    const pending = await h.request({
      ...automatic,
      entries,
      entryCurrent: async () => true,
      entryOrigin: async (id: string, origin: string) => id === "password" && origin === idpOrigin,
      entryLearned,
    });
    const answer = await pending.result;
    if (!answer.ok) throw new Error(answer.reason);
    expect(entryLearned).not.toHaveBeenCalled();
    expect(await h.controller.consume(answer.choiceId)).toMatchObject({
      selection: { entryId: "password" },
    });
  });

  it.each(["none", "both", "throw", "not-current"])(
    "waits for the person's entry choice when %s is learned",
    async (mode) => {
      const h = await mapped();
      const pending = await h.request({
        ...automatic,
        entries,
        entryCurrent: async () => mode !== "not-current",
        entryOrigin: async () => false,
        entryLearned: async (id: string) => {
          if (mode === "throw") throw new Error("recipes unavailable");
          return mode === "both" || (mode !== "none" && id === "provider");
        },
      });
      expect(pending.waiting).toBe(true);
      expect(await pendingOf(pending)).toBeUndefined();
      expect(await h.offer()).toMatchObject({ reason: "entry-required" });
    },
  );

  it("never guesses an IdP: without a saved mapping the person chooses", async () => {
    const h = await mapped(false);
    const entryLearned = vi.fn(async () => true);
    const pending = await h.request({
      ...automatic,
      entries: entries.slice(0, 1),
      entryCurrent: async () => true,
      entryOrigin: async () => false,
      entryLearned,
    });
    expect(pending.waiting).toBe(true);
    expect(await pendingOf(pending)).toBeUndefined();
    expect(entryLearned).not.toHaveBeenCalled();
    expect(await h.offer()).toMatchObject({ reason: "mapping-required" });
  });

  it("keeps the explicit chooser for the person's own request", async () => {
    const h = await mapped();
    const entryLearned = vi.fn(async () => true);
    const pending = await h.request({
      automatic: false,
      entries: entries.slice(0, 1),
      entryCurrent: async () => true,
      entryLearned,
    });
    expect(pending.waiting).toBe(true);
    expect(entryLearned).not.toHaveBeenCalled();
  });

  it("checks the learned entry again when the receipt is consumed", async () => {
    const h = await mapped();
    const entryLearned = vi.fn(async (id: string) => id === "provider");
    const pending = await h.request({
      ...automatic,
      entries,
      entryCurrent: async () => true,
      entryOrigin: async () => false,
      entryLearned,
    });
    const answer = await pending.result;
    if (!answer.ok) throw new Error(answer.reason);
    entryLearned.mockResolvedValue(false);
    expect(await h.controller.consume(answer.choiceId)).toEqual({
      ok: false,
      reason: "entry-changed",
    });
  });

  it("withdraws a request replaced while its layout evidence is read", async () => {
    const h = await mapped();
    const gate = Promise.withResolvers<boolean>();
    const entered = vi.fn(() => gate.promise);
    const request = h.request({
      ...automatic,
      entries: entries.slice(0, 1),
      entryCurrent: async () => true,
      entryOrigin: async () => false,
      entryLearned: entered,
    });
    await vi.waitFor(() => expect(entered).toHaveBeenCalled());
    const replacement = await h.request();
    gate.resolve(true);
    expect(await (await request).result).toEqual({ ok: false, reason: "replaced" });
    expect(await h.offer()).toMatchObject({ id: replacement.offerId });
  });
});

describe("Log in now presses by itself only an SSO entry the automatic order decides", () => {
  const manual = (hop = true, passkey = false) => ({
    automatic: "sso" as const,
    native: { passkey, password: true },
    hopAllowed: vi.fn(async () => hop),
    entries,
    entryCurrent: async () => true,
    entryOrigin: async () => false,
    entryLearned: vi.fn(async (id: string) => id === "provider"),
  });

  it("presses the learned entry for the mapped origin, with the hop allowed", async () => {
    const h = await mapped();
    const input = manual();
    const pending = await h.request(input);
    expect(pending.waiting).toBeUndefined();
    const answer = await pending.result;
    if (!answer.ok) throw new Error(answer.reason);
    expect(input.entryLearned).toHaveBeenCalledWith("provider", idpOrigin);
    expect(input.hopAllowed).toHaveBeenCalledWith(idpOrigin);
    const consumed = await h.controller.consume(answer.choiceId);
    expect(consumed).toMatchObject({ selection: { kind: "sso", entryId: "provider" } });
    // The automatic order decided it, so the login's record counts it as automatic, not
    // as the person's pick (ADR 0055, amended 2026-11-18).
    expect(consumed).not.toHaveProperty("picked");
  });

  it("names the person's own pick in Log in now's chooser as picked", async () => {
    const h = await mapped();
    const pending = await h.request(manual(false));
    expect(pending.waiting).toBe(true);
    expect(await h.choose("sso", 1, { entryId: "provider" })).toEqual({ ok: true });
    const answer = await pending.result;
    if (!answer.ok) throw new Error(answer.reason);
    expect(await h.controller.consume(answer.choiceId)).toMatchObject({
      ok: true,
      selection: { kind: "sso", entryId: "provider" },
      picked: true,
    });
  });

  it.each([
    ["the hop is not allowed", () => manual(false)],
    ["a passkey comes first in the order", () => manual(true, true)],
    ["nothing is learned", () => ({ ...manual(), entryLearned: async () => false })],
    [
      "no scope check is given",
      () => {
        const { hopAllowed: _, ...rest } = manual();
        return rest;
      },
    ],
  ])("keeps the explicit chooser when %s", async (_, input) => {
    const h = await mapped();
    const pending = await h.request(input());
    expect(pending.waiting).toBe(true);
    expect(await pendingOf(pending)).toBeUndefined();
    // The chooser shows no automatic refusal: the person picks any method there.
    expect(await h.offer()).not.toHaveProperty("reason");
  });

  it("keeps the explicit chooser beside a numbered method", async () => {
    const h = ssoHarness([
      { method: { number: 1 }, automatic: true, form: "bracket", label: "Provider" },
      { method: { number: 2 }, automatic: false, form: "bracket", label: "Other" },
    ]);
    fixtures.push(h);
    // The preferred method is mapped: only the numbered one beside it keeps the chooser.
    await h.request();
    expect(await h.choose()).toEqual({ ok: true });
    const pending = await h.request(manual());
    expect(pending.waiting).toBe(true);
    expect(await pendingOf(pending)).toBeUndefined();
  });

  it("leaves a refusal of the decided method to the chooser, which shows it", async () => {
    const h = await mapped();
    const valid = h.source.validate.getMockImplementation()!;
    h.source.validate
      .mockImplementationOnce(valid)
      .mockResolvedValueOnce({ ok: false, reason: "source-changed" });
    const pending = await h.request(manual());
    expect(pending.waiting).toBe(true);
    expect(await pendingOf(pending)).toBeUndefined();
  });

  it("keeps the explicit chooser where the order would take the password", async () => {
    const h = ssoHarness([
      { method: { number: 2 }, automatic: false, form: "bracket", label: "Other" },
    ]);
    fixtures.push(h);
    const pending = await h.request(manual());
    expect(pending.waiting).toBe(true);
    expect(await pendingOf(pending)).toBeUndefined();
  });

  it("keeps no offer, nor its timer, for a request already ended", async () => {
    const h = await mapped();
    const ended = new AbortController();
    ended.abort();
    const pending = await h.request({ ...manual(), signal: ended.signal });
    expect(await pending.result).toEqual({ ok: false, reason: "cancelled" });
    expect(await h.controller.get(7)).toEqual({ ok: true });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps the explicit chooser while the preferred method has no mapping", async () => {
    const h = await mapped(false);
    const pending = await h.request(manual());
    expect(pending.waiting).toBe(true);
  });
});
