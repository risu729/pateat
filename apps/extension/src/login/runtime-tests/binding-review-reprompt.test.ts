import { describe, expect, it, vi } from "vitest";
const fake = await vi.hoisted(async () => (await import("./browser-fake")).createBrowserFake());
vi.mock("wxt/browser", () => ({ browser: fake.browser }));
vi.stubEnv("MODE", "production");
const { bindingReviewFixture } = await import("./binding-review-fixture");
const { start, offer, get, pick, stale, records, executes } = bindingReviewFixture(fake);

const REVIEWS = "pateat.login-binding-reviews.v1";
type Answer = "verified" | "closed" | "unavailable";

/** A re-prompt item on the page's site, with a master password window the test answers. */
function reprompting() {
  const answers: ((value: Answer) => void)[] = [];
  const askMasterPassword = vi.fn(
    (_input: unknown) => new Promise<Answer>((resolve) => answers.push(resolve)),
  );
  const h = start({ reprompt: true, askMasterPassword }, {
    repromptSites: [{ hostname: "login.example", includeSubdomains: false }],
  } as never);
  return { h, askMasterPassword, answer: (value: Answer) => answers.shift()!(value) };
}

describe("a popup binding repair of an item with Bitwarden's master password re-prompt", () => {
  it("keeps the choice while the window asks and saves it after the password, without a second pick", async () => {
    const { h, askMasterPassword, answer } = reprompting();
    const review = await offer(h);
    fake.state.onReconnect = () => h.hello();
    expect(await pick(h, review)).toEqual({ ok: true, waiting: "master-password" });
    expect(askMasterPassword).toHaveBeenCalledOnce();
    expect(h.fields).not.toHaveBeenCalled();
    expect(executes()).toEqual([]);
    // The override is recorded for the document, but no attempt has taken it yet.
    const kept = fake.state.session[REVIEWS] as { id: string; replacement?: unknown }[];
    expect(kept).toMatchObject([
      {
        id: review.reviewId,
        replacement: {
          slots: [
            { slot: "branch", field: { custom: "New branch" } },
            { slot: "password", field: "password" },
          ],
        },
      },
    ]);
    expect(kept[0]).not.toHaveProperty("attemptId");
    // The popup offers no second pick while the window decides.
    expect((await get(h, true)).repair).toBeUndefined();
    answer("verified");
    await vi.waitFor(() =>
      expect(h.settings.settings.bindings[0]!.slots[0]!.field).toEqual({ custom: "New branch" }),
    );
    expect(askMasterPassword).toHaveBeenCalledOnce();
    expect(h.store.update).toHaveBeenCalledOnce();
    expect(records()).toMatchObject([{ state: "authenticated" }]);
    await vi.waitFor(() => expect(fake.state.session[REVIEWS]).toEqual([]));
  });

  it.each(["closed", "unavailable"] as const)(
    "drops the kept choice when the window ends %s",
    async (ending) => {
      const { h, answer } = reprompting();
      const review = await offer(h);
      fake.state.onReconnect = () => h.hello();
      expect(await pick(h, review)).toEqual({ ok: true, waiting: "master-password" });
      answer(ending);
      await vi.waitFor(() => expect(fake.state.session[REVIEWS]).toEqual([]));
      expect(h.fields).not.toHaveBeenCalled();
      expect(h.store.update).not.toHaveBeenCalled();
      expect(h.settings.settings.bindings[0]).toEqual(stale);
      // The page's next announcement stops on the stale field again and offers a new review.
      expect(await h.hello()).toEqual({ ok: false, reason: "field-missing" });
      expect((await get(h)).repair?.reviewId).not.toBe(review.reviewId);
    },
  );

  it("drops the kept choice when another document replaces the page, and never fills it", async () => {
    const { h, answer } = reprompting();
    const review = await offer(h);
    fake.state.onReconnect = () => h.hello();
    expect(await pick(h, review)).toEqual({ ok: true, waiting: "master-password" });
    await h.hello({ documentId: "another-document" }, false);
    await vi.waitFor(() => expect(fake.state.session[REVIEWS]).toEqual([]));
    // The password typed for the gone document restarts nothing.
    answer("verified");
    expect(await h.hello({ documentId: "another-document" }, false)).toMatchObject({ ok: false });
    expect(fake.state.reconnects).toHaveLength(1);
    expect(h.fields).not.toHaveBeenCalled();
    expect(h.store.update).not.toHaveBeenCalled();
    expect(h.settings.settings.bindings[0]).toEqual(stale);
  });

  it("drops the kept choice when its tab closes", async () => {
    const { h } = reprompting();
    const review = await offer(h);
    fake.state.onReconnect = () => h.hello();
    expect(await pick(h, review)).toEqual({ ok: true, waiting: "master-password" });
    for (const listener of fake.state.removed) listener(1);
    await vi.waitFor(() => expect(fake.state.session[REVIEWS]).toEqual([]));
    expect(h.store.update).not.toHaveBeenCalled();
  });
});
