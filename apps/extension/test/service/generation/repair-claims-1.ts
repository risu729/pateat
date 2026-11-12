import { expect, it } from "vitest";
import {
  MAX_RECIPE_REPLACEMENTS,
  RECIPE_REPLACE_INTERVAL_MS,
} from "../../../src/service/generation";
import type { RepairClaims1Context } from "./context";

export function registerRepairClaims1(context: RepairClaims1Context) {
  const { connection, recipeId, shared, claimSetup, entries } = context;

  it("claims a recipe once in 3 days per missing route, across worker restarts, by recipe ID", async () => {
    const store = shared();
    const clock = { value: 5_000_000_000 };
    const first = claimSetup({ store, now: clock });
    expect(await first.generation.claimRepair!(recipeId, "passkey")).toMatchObject({
      outcome: "claimed",
    });
    expect(store.stored()).toEqual({
      version: 1,
      replacements: [
        {
          service: connection.origin,
          deviceId: connection.deviceId,
          recipeId,
          route: "passkey",
          at: 5_000_000_000,
        },
      ],
    });
    const second = claimSetup({ store, now: clock });
    second.advance(RECIPE_REPLACE_INTERVAL_MS - 1);
    expect(await second.generation.claimRepair!(recipeId, "passkey")).toEqual({
      outcome: "not-due",
    });
    // Another account's gap, the password route, has its own claim (owner, 2026-10-23).
    expect(await second.generation.claimRepair!(recipeId, "password")).toMatchObject({
      outcome: "claimed",
    });
    expect(await second.generation.claimRepair!(recipeId, "password")).toEqual({
      outcome: "not-due",
    });
    const other = "gen-fedcba9876543210fedcba9876543210";
    expect(await second.generation.claimRepair!(other, "passkey")).toMatchObject({
      outcome: "claimed",
    });
    second.advance(1);
    expect(await second.generation.claimRepair!(recipeId, "passkey")).toMatchObject({
      outcome: "claimed",
    });
    expect(entries(second).map((entry) => [entry.recipeId, entry.route])).toEqual([
      [recipeId, "password"],
      [other, "passkey"],
      [recipeId, "passkey"],
    ]);
  });

  it("claims one of two repairs of a recipe asked for at once", async () => {
    const h = claimSetup();
    const claims = await Promise.all([
      h.generation.claimRepair!(recipeId, "passkey"),
      h.generation.claimRepair!(recipeId, "passkey"),
    ]);
    expect(claims.map((claim) => claim.outcome).toSorted()).toEqual(["claimed", "not-due"]);
    expect(entries(h)).toHaveLength(1);
  });

  it("keeps claims apart per service and device, and releases only its own", async () => {
    const store = shared();
    const h = claimSetup({ store });
    const claim = await h.generation.claimRepair!(recipeId, "passkey");
    const otherDevice = claimSetup({
      store,
      paired: () => ({ ...connection, deviceId: "another-device" }),
    });
    expect(await otherDevice.generation.claimRepair!(recipeId, "passkey")).toMatchObject({
      outcome: "claimed",
    });
    expect(entries(h)).toHaveLength(2);
    // A request the service never answered gives its claim back.
    if (claim.outcome !== "claimed") throw new Error("Expected a claim");
    await claim.release();
    expect(entries(h).map((entry) => entry.deviceId)).toEqual(["another-device"]);
    expect(await h.generation.claimRepair!(recipeId, "passkey")).toMatchObject({
      outcome: "claimed",
    });
    expect(await otherDevice.generation.claimRepair!(recipeId, "passkey")).toEqual({
      outcome: "not-due",
    });
  });

  it("claims nothing it could not record", async () => {
    const h = claimSetup();
    h.replaceStorage.write.mockRejectedValueOnce(new Error("quota"));
    expect(await h.generation.claimRepair!(recipeId, "passkey")).toEqual({
      outcome: "not-sent",
      reason: "storage-unavailable",
    });
    expect(await h.generation.claimRepair!(recipeId, "passkey")).toMatchObject({
      outcome: "claimed",
    });
  });

  it("keeps at most 200 claims, dropping the oldest", async () => {
    const h = claimSetup();
    const ids = Array.from(
      { length: MAX_RECIPE_REPLACEMENTS },
      (_, index) => `gen-${index.toString(16).padStart(32, "0")}`,
    );
    for (const id of ids) {
      h.advance(1);
      // eslint-disable-next-line no-await-in-loop
      await h.generation.claimRepair!(id, "passkey");
    }
    h.advance(1);
    expect(await h.generation.claimRepair!(recipeId, "passkey")).toMatchObject({
      outcome: "claimed",
    });
    const kept = entries(h);
    expect(kept).toHaveLength(MAX_RECIPE_REPLACEMENTS);
    expect(kept[0]!.recipeId).toBe(ids[1]);
    expect(await h.generation.claimRepair!(ids[0]!, "passkey")).toMatchObject({
      outcome: "claimed",
    });
  });

  it("claims nothing without a paired, accepted device", async () => {
    const setups = [
      claimSetup({ paired: () => undefined }),
      claimSetup({ paired: () => ({ ...connection, rejected: true }) }),
    ];
    for (const claim of await Promise.all(
      setups.map((h) => h.generation.claimRepair!(recipeId, "passkey")),
    ))
      expect(claim).toEqual({ outcome: "not-due", reason: "not-connected" });
    for (const h of setups) expect(h.replaceStorage.write).not.toHaveBeenCalled();
  });
}
