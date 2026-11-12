import { describe, expect, it, vi } from "vitest";
const fake = await vi.hoisted(async () => (await import("./browser-fake")).createBrowserFake());
vi.mock("wxt/browser", () => ({ browser: fake.browser }));
vi.stubEnv("MODE", "production");
const { bindingReviewFixture } = await import("./binding-review-fixture");
const {
  start,
  offer,
  get,
  pick,
  stale,
  records,
  executes,
  liveItemPolicy,
  itemId,
  liveReview,
  snapshotId,
  savedBinding,
  otherItemId,
  popup,
  sender,
  repairedRecipe,
} = bindingReviewFixture(fake);

describe("popup binding repair through the production runtime", () => {
  it("shows names without reading vault values, then saves only the repaired binding after authentication", async () => {
    const unrelated = { ...savedBinding, itemId: otherItemId };
    const h = start({}, { bindings: [stale, unrelated] });
    const review = await offer(h);
    expect(review.slots).toEqual([
      {
        slot: "branch",
        name: "Old branch",
        reason: "field-missing",
        candidates: [{ fieldId: `custom.${snapshotId}.0`, name: "New branch" }],
      },
    ]);
    expect(h.fields).not.toHaveBeenCalled();
    expect(executes()).toEqual([]);
    expect(h.settings.settings.bindings).toEqual([stale, unrelated]);
    fake.state.onReconnect = () => h.hello();
    expect(await pick(h, review)).toEqual({ ok: true });
    await vi.waitFor(() =>
      expect(h.settings.settings.bindings[0]!.slots[0]!.field).toEqual({ custom: "New branch" }),
    );
    expect(h.settings.settings.bindings[1]).toEqual(unrelated);
    expect(h.settings.settings.siteDefaults).toHaveLength(1);
    expect(h.store.update).toHaveBeenCalledOnce();
    expect(h.store.update.mock.calls[0]!.slice(0, 2)).toEqual([1, "account-choice"]);
    expect(records()).toMatchObject([{ state: "authenticated" }]);
    expect(h.fields.mock.calls.map(([request]) => request.fieldId)).toEqual([
      `custom.${snapshotId}.0`,
      "login.password",
    ]);
    expect(JSON.stringify(fake.state.session)).not.toContain("synthetic-secret");
  });

  it("survives a worker restart using storage.session and reconnects only its original document", async () => {
    const first = start();
    const review = await offer(first);
    expect(fake.state.session["pateat.login-binding-reviews.v1"]).toMatchObject([
      { id: review.reviewId },
    ]);
    const restarted = start();
    fake.state.onReconnect = () => restarted.hello();
    expect((await get(restarted)).repair?.reviewId).toBe(review.reviewId);
    expect(await pick(restarted, review)).toEqual({ ok: true });
    await vi.waitFor(() => expect(restarted.store.update).toHaveBeenCalledOnce());
    expect(fake.state.reconnects).toEqual([
      { tabId: 1, frameId: 0, documentId: "synthetic-document" },
      { tabId: 1, frameId: 0, documentId: "synthetic-document" },
    ]);
    expect(first.fields).not.toHaveBeenCalled();
  });

  it("serializes concurrent picks into one start and one authenticated update", async () => {
    const h = start();
    const review = await offer(h);
    fake.state.onReconnect = () => h.hello();
    const responses = await Promise.all([pick(h, review), pick(h, review)]);
    expect(responses.filter((response) => (response as { ok: boolean }).ok)).toHaveLength(1);
    await vi.waitFor(() => expect(h.store.update).toHaveBeenCalledOnce());
    expect(executes()).toHaveLength(2);
    expect(records()).toHaveLength(1);
  });

  it.each(["document", "settings", "snapshot", "recipe", "account", "locked"])(
    "rejects a pick after its %s changes",
    async (change) => {
      const h = start();
      const review = await offer(h);
      if (change === "document") await h.hello({ documentId: "another-document" }, false);
      if (change === "settings") h.settings.revision += 1;
      if (change === "snapshot") h.snapshot.current = "60000000-0000-4000-8000-000000000002";
      if (change === "recipe")
        h.recipes.recipe.mockResolvedValue({ ...repairedRecipe, revision: 2 });
      if (change === "account") h.settings.settings.bindings[0]!.itemId = otherItemId;
      if (change === "locked")
        h.store.handle.mockResolvedValue({
          version: 1,
          ok: false,
          reason: "vault-unavailable",
        } as never);
      expect(await pick(h, review)).toEqual({ ok: false, reason: "stale-review" });
      expect(h.fields).not.toHaveBeenCalled();
      expect(h.store.update).not.toHaveBeenCalled();
    },
  );

  it("rejects a hidden profile switch even at the same settings revision", async () => {
    let profile = "profile-a";
    const h = start({ bindingScope: async () => profile });
    const review = await offer(h);
    profile = "profile-b";
    expect(await pick(h, review)).toEqual({ ok: false, reason: "stale-review" });
    expect(h.fields).not.toHaveBeenCalled();
  });

  it("does not start or retain an override when its required session write fails", async () => {
    const h = start();
    const review = await offer(h);
    vi.spyOn(fake.browser.storage.session, "set").mockRejectedValueOnce(
      new Error("storage unavailable"),
    );
    fake.state.onReconnect = () => h.hello();
    expect(await pick(h, review)).toEqual({ ok: false, reason: "unavailable" });
    await h.hello();
    expect(h.fields).not.toHaveBeenCalled();
    expect(executes()).toEqual([]);
    expect(h.settings.settings.bindings[0]).toEqual(stale);
  });

  it("keeps a stale slot visible with no candidates and rejects arbitrary or excluded field IDs", async () => {
    const h = start(
      { custom: [{ name: "New branch", kind: "text" }] },
      {
        itemPolicies: [liveItemPolicy(itemId, { excludedFields: [{ custom: "New branch" }] })],
        customFieldReviews: [liveReview()],
      },
    );
    const review = await offer(h);
    expect(review.slots[0]!.candidates).toEqual([]);
    expect(await pick(h, review, [{ slot: "branch", fieldId: `custom.${snapshotId}.0` }])).toEqual({
      ok: false,
      reason: "not-a-candidate",
    });
    expect(h.fields).not.toHaveBeenCalled();
  });

  it("reports quarantined items separately without granting field review", async () => {
    const h = start({ quarantined: true });
    expect(await h.hello()).toMatchObject({ ok: false });
    expect(await get(h)).toEqual({
      ok: true,
      blocked: [
        { id: expect.any(String), item: "Synthetic item", connection: "Synthetic live vault" },
      ],
    });
    expect(h.store.update).not.toHaveBeenCalled();
    expect(h.fields).not.toHaveBeenCalled();
  });

  it("accepts binding-review messages only from the extension popup with strict request shapes", async () => {
    const h = start();
    const review = await offer(h);
    const request = {
      version: 1,
      type: "login.binding-review.pick",
      tabId: 1,
      reviewId: review.reviewId,
      picks: [{ slot: "branch", fieldId: `custom.${snapshotId}.0` }],
    };
    for (const from of [
      sender(),
      { id: "other-extension", url: "chrome-extension://synthetic-extension/popup.html" },
    ]) {
      expect(await h.login.handle(request, from as never)).toBeUndefined();
    }
    expect(await h.login.handle({ ...request, grant: true }, popup)).toBeUndefined();
    expect(await h.login.handle({ ...request, tabId: -1 }, popup)).toBeUndefined();
    expect(h.fields).not.toHaveBeenCalled();
  });
});
