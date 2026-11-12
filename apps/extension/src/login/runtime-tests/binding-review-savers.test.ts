import { describe, expect, it, vi } from "vitest";
import type { SavedLoginBinding } from "@pateat/contracts";
import type { Execution } from "../runtime/types";
const fake = await vi.hoisted(async () => (await import("./browser-fake")).createBrowserFake());
vi.mock("wxt/browser", () => ({ browser: fake.browser }));
vi.stubEnv("MODE", "production");
const { bindingReviewFixture } = await import("./binding-review-fixture");
const { createRuntimeState } = await import("../runtime/state");
const { attachBindingReview } = await import("../runtime/binding-review");
const { remember } = await import("../runtime/choice-save");
const { start, offer, pick, stale, records, executes, connectionId, itemId, uriMatch } =
  bindingReviewFixture(fake);

const REVIEWS = "pateat.login-binding-reviews.v1";

describe("a repaired binding is saved only by its fenced save", () => {
  it("saves nothing when a fence refuses, even with an automatic account choice to save", async () => {
    // Without a saved default, the plan derives an unsaved choice naming the replacement.
    const h = start({ uris: async () => ({ ok: true, data: uriMatch() }) }, { siteDefaults: [] });
    const review = await offer(h);
    h.recipes.fence.mockResolvedValue(undefined);
    fake.state.onReconnect = () => h.hello();
    expect(await pick(h, review)).toEqual({ ok: true });
    await vi.waitFor(() => expect(records()).toMatchObject([{ state: "authenticated" }]));
    await vi.waitFor(() => expect(fake.state.session[REVIEWS]).toEqual([]));
    expect(h.fields).toHaveBeenCalled();
    expect(h.settings.settings.bindings).toEqual([stale]);
    expect(h.settings.settings.siteDefaults).toEqual([]);
    expect(fake.state.storage["binding-review.synthetic-settings"]).toBeUndefined();
    // The only update asked for was the repair's own, which its guard refused.
    expect(h.store.update.mock.calls.map((call) => call.length)).toEqual([4]);
  });

  it("marks an attached run, so a choice derived again for it is never saved", async () => {
    const update = vi.fn();
    const rt = createRuntimeState(
      { handle: vi.fn(), update } as never,
      {
        fields: vi.fn(),
      } as never,
    );
    const replacement: SavedLoginBinding = {
      ...stale,
      slots: [
        { slot: "branch", field: { custom: "New branch" } },
        { slot: "password", field: "password" },
      ],
    };
    const document = {
      tabId: 1,
      frameId: 0,
      documentId: "synthetic-document",
      origin: stale.origin,
    };
    rt.bindingReviews.set(1, {
      id: "synthetic-review",
      document,
      path: "/signin",
      url: "https://login.example/signin",
      connectionId,
      snapshotId: "synthetic-snapshot",
      policyRevision: 1,
      scope: "local",
      recipeId: stale.recipeId,
      recipeRevision: 1,
      recipeMark: "{}",
      binding: stale,
      slots: ["branch", "password"],
      replacement,
    });
    const choice = { binding: replacement, connectionId };
    const run = {
      metadata: {
        id: "synthetic-attempt",
        state: "authenticated",
        account: { origin: stale.origin, connectionId, itemId },
        document,
      },
      recipe: { id: stale.recipeId, revision: 1 },
      live: { document },
      running: false,
      choice,
    } as unknown as Execution;
    // An activation still being written, or a plan of another binding, attaches nothing.
    rt.bindingActivating.add(1);
    expect(attachBindingReview(rt, run, replacement)).toBe(false);
    rt.bindingActivating.delete(1);
    expect(attachBindingReview(rt, run, stale)).toBe(false);
    expect(run.choice).toBe(choice);
    expect(attachBindingReview(rt, run, replacement)).toBe(true);
    expect(run).toMatchObject({ bindingRepair: true });
    expect(run.choice).toBeUndefined();
    // A later document of the same attempt is marked too, without a second attach.
    const later = { ...run, choice } as Execution;
    delete later.bindingRepair;
    expect(attachBindingReview(rt, later, replacement)).toBe(false);
    expect(later).toMatchObject({ bindingRepair: true });
    // A choice set on the marked run again is dropped by the normal account saver.
    run.choice = choice;
    await remember(rt, run);
    expect(update).not.toHaveBeenCalled();
    expect(run.choice).toBeUndefined();
  });
});

describe("a repair attempt whose session record cannot be written", () => {
  it("drops the repair without rejecting the admission, and fills nothing", async () => {
    const h = start();
    const review = await offer(h);
    const session = fake.browser.storage.session;
    const write = session.set.bind(session);
    // Only the write that names the attempt taking the override fails.
    vi.spyOn(session, "set").mockImplementation(async (values: Record<string, unknown>) => {
      const reviews = values[REVIEWS] as { attemptId?: string }[] | undefined;
      if (reviews?.some((entry) => entry.attemptId)) throw new Error("synthetic session failure");
      return write(values);
    });
    let started: unknown;
    fake.state.onReconnect = async () => (started = await h.hello());
    expect(await pick(h, review)).toEqual({ ok: false, reason: "unavailable" });
    expect(started).toEqual({ ok: true });
    // Its first step plans without the dropped override and stops before filling.
    await vi.waitFor(() =>
      expect(records()).toMatchObject([{ state: "blocked", outcome: "policy-changed" }]),
    );
    expect(executes()).toEqual([]);
    expect(h.fields).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(fake.state.session[REVIEWS]).toEqual([]));
    expect(h.store.update).not.toHaveBeenCalled();
    expect(h.settings.settings.bindings).toEqual([stale]);
  });
});
