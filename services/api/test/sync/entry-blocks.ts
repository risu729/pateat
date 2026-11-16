import { type LoginEntryRecipe, type SyncRecipeChanges } from "@pateat/contracts";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { type Device, enrollOwner, addDevice, api, put, publish } from "./harness";

/** A synthetic entry recipe (ADR 0031): the start path and the link pressed there. */
function entryRecipe(id: string, revision: number): LoginEntryRecipe {
  return {
    version: 1,
    id,
    revision,
    origin: "https://www.bank.example",
    entry: { path: "/en/", target: { by: "text", value: revision > 1 ? "Sign in" : "Login" } },
  };
}

export function registerEntryBlockTests() {
  describe("entry blocks (ADR 0031, amended 2026-11-16)", () => {
    const publishEntry = (device: Device, id: string, expectedRevision: number) =>
      put(device, `/v1/recipes/${id}`, {
        version: 1,
        expectedRevision,
        state: "active",
        recipe: entryRecipe(id, expectedRevision + 1),
      });
    const block = (device: Device | undefined, id: string, body: unknown) =>
      api(device, `/v1/recipes/${id}/entry-block`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    const changes = async (device: Device, after = 0) =>
      (await (await api(device, `/v1/recipes?after=${after}`)).json()) as SyncRecipeChanges;
    const rows = async (ownerId: string) =>
      (
        await env.DB.prepare(
          "SELECT recipe_id, revision, reason, device_id FROM recipe_entry_blocks WHERE owner_id = ? ORDER BY recipe_id",
        )
          .bind(ownerId)
          .all()
      ).results;

    it("keeps the first reason of a revision from any device, and every device's sync brings it", async () => {
      const device = await enrollOwner();
      const other = await addDevice(device.ownerId);
      expect((await publishEntry(device, "art-entry", 0)).status).toBe(200);
      const { cursor } = await changes(other);
      const before = Date.now();
      const first = await block(device, "art-entry", {
        version: 1,
        revision: 1,
        reason: "sign-up",
      });
      expect(first.status).toBe(204);
      expect(await first.text()).toBe("");
      // Another device's later reason of the same revision changes nothing.
      expect(
        (await block(other, "art-entry", { version: 1, revision: 1, reason: "left-site" })).status,
      ).toBe(204);
      expect(await rows(device.ownerId)).toEqual([
        { recipe_id: "art-entry", revision: 1, reason: "sign-up", device_id: device.deviceId },
      ]);
      // The other device's cursor sync brings the revision again, now blocked.
      const page = await changes(other, cursor);
      expect(page.changes).toEqual([
        {
          recipeId: "art-entry",
          revision: 1,
          state: "active",
          recipe: entryRecipe("art-entry", 1),
          entryBlock: { reason: "sign-up", blockedAt: expect.any(Number) },
        },
      ]);
      const change = page.changes[0]!;
      expect(change.state === "active" && change.entryBlock!.blockedAt).toBeGreaterThanOrEqual(
        before,
      );
      // A repeat moves the head no further, so no device reads it again for nothing.
      expect(
        (await block(device, "art-entry", { version: 1, revision: 1, reason: "sign-up" })).status,
      ).toBe(204);
      expect((await changes(other, page.cursor)).changes).toEqual([]);
    });

    it("ends with a newer revision, which a report of the older one no longer blocks", async () => {
      const device = await enrollOwner();
      await publishEntry(device, "art-entry", 0);
      await block(device, "art-entry", { version: 1, revision: 1, reason: "no-sign-in" });
      expect((await publishEntry(device, "art-entry", 1)).status).toBe(200);
      expect(await rows(device.ownerId)).toEqual([]);
      expect(
        (await block(device, "art-entry", { version: 1, revision: 1, reason: "sign-up" })).status,
      ).toBe(204);
      expect(await rows(device.ownerId)).toEqual([]);
      expect((await changes(device)).changes).toEqual([
        {
          recipeId: "art-entry",
          revision: 2,
          state: "active",
          recipe: entryRecipe("art-entry", 2),
        },
      ]);
      expect(
        (await block(device, "art-entry", { version: 1, revision: 2, reason: "left-site" })).status,
      ).toBe(204);
      expect(await rows(device.ownerId)).toEqual([
        { recipe_id: "art-entry", revision: 2, reason: "left-site", device_id: device.deviceId },
      ]);
    });

    it("ends with the recipe's revocation, and a revoked recipe takes none", async () => {
      const device = await enrollOwner();
      await publishEntry(device, "art-entry", 0);
      await block(device, "art-entry", { version: 1, revision: 1, reason: "sign-up" });
      const revoked = await put(device, "/v1/recipes/art-entry", {
        version: 1,
        expectedRevision: 1,
        state: "revoked",
      });
      expect(revoked.status).toBe(200);
      expect(await rows(device.ownerId)).toEqual([]);
      expect(
        (await block(device, "art-entry", { version: 1, revision: 2, reason: "sign-up" })).status,
      ).toBe(404);
      expect(await rows(device.ownerId)).toEqual([]);
    });

    it("refuses a recipe the owner does not hold, a revision it never had and a login recipe", async () => {
      const device = await enrollOwner();
      const stranger = await enrollOwner();
      await publishEntry(device, "art-entry", 0);
      await publish(device, "bank-login", 0);
      const report = { version: 1, revision: 1, reason: "sign-up" };
      expect((await block(device, "missing-entry", report)).status).toBe(404);
      expect((await block(stranger, "art-entry", report)).status).toBe(404);
      expect((await block(device, "art-entry", { ...report, revision: 2 })).status).toBe(404);
      expect((await block(device, "bank-login", report)).status).toBe(400);
      expect((await block(device, "art-entry", { ...report, reason: "slow" })).status).toBe(400);
      expect((await block(undefined, "art-entry", report)).status).toBe(401);
      expect(await rows(device.ownerId)).toEqual([]);
      expect(await rows(stranger.ownerId)).toEqual([]);
    });
  });
}
