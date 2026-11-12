import { describe, expect, it, vi } from "vitest";
const fake = await vi.hoisted(async () => (await import("./browser-fake")).createBrowserFake());
vi.mock("wxt/browser", () => ({ browser: fake.browser }));
vi.stubEnv("MODE", "production");
const { bindingReviewFixture } = await import("./binding-review-fixture");
const { start, offer, pick, stale, records, executes, repairedRecipe, setPause } =
  bindingReviewFixture(fake);

describe("binding repair freshness across asynchronous boundaries", () => {
  it("rejects a recipe changed while the final queued guard awaits its last profile read", async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let guarded = false;
    let scopeReads = 0;
    const h = start({
      bindingScope: async () => {
        if (guarded && ++scopeReads === 2) {
          entered.resolve();
          await release.promise;
        }
        return "profile-a";
      },
    });
    const review = await offer(h);
    const original = h.store.update.getMockImplementation()!;
    h.store.update.mockImplementationOnce(async (...args) => {
      guarded = true;
      return original(...args);
    });
    fake.state.onReconnect = () => h.hello();
    expect(await pick(h, review)).toEqual({ ok: true });
    await entered.promise;
    h.recipes.recipe.mockResolvedValue({ ...repairedRecipe, revision: 2 });
    release.resolve();
    await vi.waitFor(() =>
      expect(fake.state.session["pateat.login-binding-reviews.v1"]).toEqual([]),
    );
    expect(h.settings.settings.bindings[0]).toEqual(stale);
  });
  it.each(["scope", "recipe"])(
    "rechecks a snapshot replaced during the awaited %s read",
    async (boundary) => {
      const scope = vi.fn(async () => "profile-a");
      const h = start({ bindingScope: scope });
      const review = await offer(h);
      const gate = Promise.withResolvers<void>();
      const entered = Promise.withResolvers<void>();
      if (boundary === "scope")
        scope.mockImplementationOnce(async () => {
          entered.resolve();
          await gate.promise;
          return "profile-a";
        });
      else
        h.recipes.recipe.mockImplementationOnce(async () => {
          entered.resolve();
          await gate.promise;
          return repairedRecipe;
        });
      const pending = pick(h, review);
      await entered.promise;
      h.snapshot.current = "60000000-0000-4000-8000-000000000002";
      gate.resolve();
      expect(await pending).toEqual({ ok: false, reason: "stale-review" });
      expect(h.fields).not.toHaveBeenCalled();
      expect(h.store.update).not.toHaveBeenCalled();
    },
  );

  it("rejects a hidden profile switch that occurs during the recipe read", async () => {
    let profile = "profile-a";
    const h = start({ bindingScope: async () => profile });
    const review = await offer(h);
    const gate = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    h.recipes.recipe.mockImplementationOnce(async () => {
      entered.resolve();
      await gate.promise;
      return repairedRecipe;
    });
    const pending = pick(h, review);
    await entered.promise;
    profile = "profile-b";
    gate.resolve();
    expect(await pending).toEqual({ ok: false, reason: "stale-review" });
    expect(h.fields).not.toHaveBeenCalled();
  });

  it("blocks a periodic announcement while the required session write is pending and fails", async () => {
    const h = start();
    const review = await offer(h);
    const gate = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const original = fake.browser.storage.session.set;
    vi.spyOn(fake.browser.storage.session, "set").mockImplementationOnce(async () => {
      entered.resolve();
      await gate.promise;
      throw new Error("session write failed");
    });
    fake.state.onReconnect = () => h.hello();
    const pending = pick(h, review);
    await entered.promise;
    await h.hello();
    expect(h.fields).not.toHaveBeenCalled();
    expect(executes()).toEqual([]);
    gate.resolve();
    expect(await pending).toEqual({ ok: false, reason: "unavailable" });
    vi.mocked(fake.browser.storage.session.set).mockImplementation(original);
    await h.hello();
    expect(h.fields).not.toHaveBeenCalled();
    expect(h.settings.settings.bindings[0]).toEqual(stale);
  });

  it("never restores an unacknowledged choice from a concurrent generic session write after cleanup also fails", async () => {
    const h = start();
    const review = await offer(h);
    const gate = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const original = fake.browser.storage.session.set;
    let first = true;
    let failCleanup = false;
    vi.spyOn(fake.browser.storage.session, "set").mockImplementation(async (value) => {
      if (first) {
        first = false;
        entered.resolve();
        await gate.promise;
        throw new Error("activation failed");
      }
      if (failCleanup) throw new Error("cleanup failed");
      await original(value);
    });
    const pending = pick(h, review);
    await entered.promise;
    await setPause(h, true);
    await setPause(h, false);
    expect(fake.state.session["pateat.login-binding-reviews.v1"]).toMatchObject([
      { id: review.reviewId },
    ]);
    expect(
      (fake.state.session["pateat.login-binding-reviews.v1"] as object[])[0],
    ).not.toHaveProperty("replacement");
    failCleanup = true;
    gate.resolve();
    expect(await pending).toEqual({ ok: false, reason: "unavailable" });
    vi.mocked(fake.browser.storage.session.set).mockImplementation(original);
    fake.state.openTabs = [1];
    fake.state.onReconnect = undefined;
    const restarted = start();
    await restarted.hello();
    expect(restarted.fields).not.toHaveBeenCalled();
    expect(executes()).toEqual([]);
    expect(restarted.settings.settings.bindings[0]).toEqual(stale);
  });

  it.each(["revision", "binding", "profile", "snapshot", "recipe"])(
    "keeps the saved binding when %s changes inside the queued settings mutation",
    async (change) => {
      let profile = "profile-a";
      const h = start({ bindingScope: async () => profile });
      const review = await offer(h);
      const queued = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const original = h.store.update.getMockImplementation()!;
      h.store.update.mockImplementationOnce(async (...args) => {
        queued.resolve();
        await release.promise;
        return original(...args);
      });
      fake.state.onReconnect = () => h.hello();
      expect(await pick(h, review)).toEqual({ ok: true });
      await queued.promise;
      if (change === "revision") h.settings.revision += 1;
      if (change === "binding")
        h.settings.settings.bindings[0]!.slots[0]!.field = { custom: "Another saved branch" };
      if (change === "profile") profile = "profile-b";
      if (change === "snapshot") h.snapshot.current = "60000000-0000-4000-8000-000000000002";
      if (change === "recipe")
        h.recipes.recipe.mockResolvedValue({ ...repairedRecipe, revision: 2 });
      release.resolve();
      await vi.waitFor(() =>
        expect(fake.state.session["pateat.login-binding-reviews.v1"]).toEqual([]),
      );
      expect(h.settings.settings.bindings[0]!.slots[0]!.field).toEqual({
        custom: change === "binding" ? "Another saved branch" : "Old branch",
      });
    },
  );

  it("continues the exact admitted attempt in a new document after a worker restart", async () => {
    const h = start();
    const review = await offer(h);
    fake.state.onExecute = async (message) => {
      if ((message["operation"] as { step: { kind: string } }).step.kind === "click")
        await new Promise(() => undefined);
    };
    fake.state.onReconnect = () => h.hello();
    expect(await pick(h, review)).toEqual({ ok: true });
    await vi.waitFor(() => expect(executes()).toHaveLength(2));
    expect(fake.state.session["pateat.login-binding-reviews.v1"]).toMatchObject([
      { attemptId: expect.any(String) },
    ]);
    const id = records()![0]!.id;
    expect(h.store.update).not.toHaveBeenCalled();
    fake.state.onExecute = undefined;
    fake.state.openTabs = [1];
    fake.state.onReconnect = undefined;
    const restarted = start();
    expect(await restarted.hello({ documentId: "after-submit" }, false)).toEqual({ ok: true });
    await vi.waitFor(() => expect(restarted.store.update).toHaveBeenCalledOnce());
    expect(records()).toMatchObject([{ id, state: "authenticated" }]);
    expect(restarted.fields).not.toHaveBeenCalled();
    expect(restarted.settings.settings.bindings[0]!.slots[0]!.field).toEqual({
      custom: "New branch",
    });
  });
});
