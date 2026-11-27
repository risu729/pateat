import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { idpOrigin, selected, ssoHarness, type SsoHarness } from "./sso-choice-fixture";

// A broker page's first visit (ADR 0085 amendment of 2026-11-18, owner: SSO starts
// automatically on the login page): no entry names the mapped origin and the page learned
// none, so the one entry whose label names the mapped IdP is pressed. The mapped origin
// shares the page's registrable label, so only the IdP item's name names it here.
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
  { id: "provider", label: "Sign in with Synthetic idp item" },
  { id: "sso", label: "Sign in with SSO" },
  { id: "password", label: "Continue" },
];
async function mapped() {
  const h = ssoHarness([{ method: { number: 1 }, automatic: true, form: "url" }]);
  fixtures.push(h);
  await h.request();
  expect(await h.choose()).toEqual({ ok: true });
  return h;
}
const firstVisit = (overrides: Record<string, unknown> = {}) => ({
  automatic: true,
  native: { passkey: false, password: true },
  entries,
  entryCurrent: vi.fn(async () => true),
  entryOrigin: vi.fn(async () => false),
  entryLearned: vi.fn(async () => false),
  entryLabeled: vi.fn(async () => true),
  ...overrides,
});
const pendingOf = async (pending: { result: Promise<unknown> }) => {
  let answer: unknown;
  void pending.result.then((value) => {
    answer = value;
    return undefined;
  });
  await Promise.resolve();
  return answer;
};

describe("a first visit's entry named by the mapped IdP", () => {
  it("is pressed automatically, and only that entry is checked", async () => {
    const h = await mapped();
    const input = firstVisit();
    const pending = await h.request(input);
    expect(pending.waiting).toBeUndefined();
    const answer = await pending.result;
    if (!answer.ok) throw new Error(answer.reason);
    expect(input.entryLabeled).toHaveBeenCalledTimes(1);
    expect(input.entryLabeled).toHaveBeenCalledWith("provider", idpOrigin);
    const consumed = await h.controller.consume(answer.choiceId);
    expect(consumed).toMatchObject({
      ok: true,
      selection: {
        kind: "sso",
        selected,
        entryId: "provider",
        label: "Sign in with Synthetic idp item",
      },
      // The flow learns and completes it only once the tab was seen at the IdP.
      labeled: true,
    });
    expect(consumed).not.toHaveProperty("picked");
  });

  it.each([
    [
      "the entry was learned for another IdP, or goes to another origin",
      { entryLabeled: async () => false },
    ],
    ["no entry names the IdP", { entries: entries.slice(1) }],
    [
      "two entries name the IdP",
      { entries: [...entries, { id: "again", label: "Synthetic idp item workforce" }] },
    ],
    ["the entry is gone", { entryCurrent: async () => false }],
    [
      "a link the flow never presses names the IdP too",
      { otherLabels: ["Synthetic idp item help"] },
    ],
    ["the guard throws", { entryLabeled: async () => Promise.reject(new Error("gone")) }],
    ["no guard is given", { entryLabeled: undefined }],
  ])("waits for the person's entry choice when %s", async (_, overrides) => {
    const h = await mapped();
    const pending = await h.request(firstVisit(overrides));
    expect(pending.waiting).toBe(true);
    expect(await pendingOf(pending)).toBeUndefined();
    expect(await h.offer()).toMatchObject({ reason: "entry-required" });
  });

  it("ends unanswered naming why it waited, so its log line says why nothing was pressed", async () => {
    const h = await mapped();
    const input = firstVisit({ entryLabeled: vi.fn(async () => false) });
    const pending = await h.request(input);
    expect(pending.waiting).toBe(true);
    h.controller.documentChanged({ tabId: 7, frameId: 0 }, "page-changed");
    expect(await pending.result).toEqual({
      ok: false,
      reason: "page-changed",
      waited: "entry-required",
    });
  });

  it("comes after an entry whose own destination is the mapped origin", async () => {
    const h = await mapped();
    const input = firstVisit({
      entryOrigin: vi.fn(async (id: string) => id === "password"),
    });
    const answer = await (await h.request(input)).result;
    if (!answer.ok) throw new Error(answer.reason);
    expect(input.entryLabeled).not.toHaveBeenCalled();
    const consumed = await h.controller.consume(answer.choiceId);
    expect(consumed).toMatchObject({ selection: { entryId: "password" } });
    expect(consumed).not.toHaveProperty("labeled");
  });

  it("comes after a learned entry, which wins over the label", async () => {
    const h = await mapped();
    const input = firstVisit({ entryLearned: vi.fn(async (id: string) => id === "sso") });
    const answer = await (await h.request(input)).result;
    if (!answer.ok) throw new Error(answer.reason);
    expect(input.entryLabeled).not.toHaveBeenCalled();
    expect(await h.controller.consume(answer.choiceId)).toMatchObject({
      selection: { entryId: "sso" },
    });
  });

  it("checks the entry again when the receipt is consumed", async () => {
    const h = await mapped();
    const input = firstVisit();
    const answer = await (await h.request(input)).result;
    if (!answer.ok) throw new Error(answer.reason);
    input.entryLabeled.mockResolvedValue(false);
    expect(await h.controller.consume(answer.choiceId)).toEqual({
      ok: false,
      reason: "entry-changed",
    });
  });

  it("is pressed by Log in now too, with the hop allowed", async () => {
    const h = await mapped();
    const hopAllowed = vi.fn(async () => true);
    const pending = await h.request(firstVisit({ automatic: "sso", hopAllowed }));
    expect(pending.waiting).toBeUndefined();
    const answer = await pending.result;
    if (!answer.ok) throw new Error(answer.reason);
    expect(hopAllowed).toHaveBeenCalledWith(idpOrigin);
    expect(await h.controller.consume(answer.choiceId)).toMatchObject({
      selection: { entryId: "provider" },
    });
  });

  it("leaves Log in now's chooser open where the hop is not allowed", async () => {
    const h = await mapped();
    const pending = await h.request(
      firstVisit({ automatic: "sso", hopAllowed: vi.fn(async () => false) }),
    );
    expect(pending.waiting).toBe(true);
  });
});
