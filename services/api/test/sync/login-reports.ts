import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { type Device, enrollOwner, addDevice, DAY_MS, api, put, publish } from "./harness";

export function registerLoginOutcomeTests() {
  describe("login outcomes", () => {
    const report = {
      version: 1,
      revision: 1,
      branch: "1000",
      outcome: "unknown-submit",
      cause: "settled",
      step: 1,
    };
    const send = (
      device: Device | undefined,
      id: string,
      body: unknown,
      type = "application/json",
    ) =>
      api(device, `/v1/recipes/${id}/outcome`, {
        method: "POST",
        headers: { "Content-Type": type },
        body: typeof body === "string" ? body : JSON.stringify(body),
      });
    const stored = async (ownerId: string) =>
      (
        await env.DB.prepare(
          "SELECT recipe_id, branch, revision, outcome, cause, step FROM login_outcomes WHERE owner_id = ? ORDER BY recipe_id, revision",
        )
          .bind(ownerId)
          .all()
      ).results;

    it("keeps the first code of each revision, from any of the owner's devices", async () => {
      const device = await enrollOwner();
      const other = await addDevice(device.ownerId);
      expect((await publish(device, "bank-login", 0)).status).toBe(200);
      expect((await publish(device, "bank-login", 1)).status).toBe(200);
      const before = Date.now();
      const first = await send(device, "bank-login", report);
      expect(first.status).toBe(204);
      expect(await first.text()).toBe("");
      // A repeat, or another device's later login of the same revision, changes nothing.
      expect(
        (await send(other, "bank-login", { ...report, outcome: "authenticated" })).status,
      ).toBe(204);
      expect(
        (
          await send(other, "bank-login", {
            version: 1,
            revision: 2,
            branch: "1000",
            outcome: "authenticated",
            step: 2,
          })
        ).status,
      ).toBe(204);
      expect(
        (
          await send(device, "bank-login", {
            ...report,
            branch: "1000:other",
            cause: "target-missing",
          })
        ).status,
      ).toBe(204);
      expect(await stored(device.ownerId)).toEqual([
        {
          recipe_id: "bank-login",
          branch: "1000",
          revision: 1,
          outcome: "unknown-submit",
          cause: "settled",
          step: 1,
        },
        {
          recipe_id: "bank-login",
          branch: "1000:other",
          revision: 1,
          outcome: "unknown-submit",
          cause: "target-missing",
          step: 1,
        },
        {
          recipe_id: "bank-login",
          branch: "1000",
          revision: 2,
          outcome: "authenticated",
          cause: null,
          step: 2,
        },
      ]);
      // The service stamps the time itself.
      const { results } = await env.DB.prepare(
        "SELECT created_at FROM login_outcomes WHERE owner_id = ?",
      )
        .bind(device.ownerId)
        .all<{ created_at: number }>();
      expect(results.every((row) => row.created_at >= before && row.created_at <= Date.now())).toBe(
        true,
      );
    });

    it("refuses a recipe or revision the owner never had, and a revoked head", async () => {
      const device = await enrollOwner();
      const stranger = await enrollOwner();
      expect((await publish(device, "bank-login", 0)).status).toBe(200);
      expect((await publish(stranger, "other-login", 0)).status).toBe(200);
      const statuses = await Promise.all([
        send(device, "missing-login", report),
        send(device, "other-login", report),
        send(stranger, "bank-login", report),
        send(device, "bank-login", { ...report, revision: 2 }),
      ]);
      expect(statuses.map((response) => response.status)).toEqual([404, 404, 404, 404]);
      expect(await statuses[0]!.json()).toEqual({ error: "not_found" });
      expect(
        (
          await put(device, "/v1/recipes/bank-login", {
            version: 1,
            expectedRevision: 1,
            state: "revoked",
          })
        ).status,
      ).toBe(200);
      // Revision 2 is the tombstone; revision 1 ran before the revocation.
      expect((await send(device, "bank-login", { ...report, revision: 2 })).status).toBe(404);
      expect((await send(device, "bank-login", report)).status).toBe(204);
      expect(await stored(device.ownerId)).toHaveLength(1);
      expect(await stored(stranger.ownerId)).toEqual([]);
    });

    it("refuses anything but the codes, without echoing the input", async () => {
      const device = await enrollOwner();
      expect((await publish(device, "bank-login", 0)).status).toBe(200);
      const bodies: unknown[] = [
        { ...report, url: "https://bank.example/login?user=someone" },
        { ...report, reason: "Password for someone@example.com was wrong" },
        { ...report, recipeId: "bank-login" },
        { ...report, createdAt: 1 },
        { ...report, outcome: "wrong password" },
        { ...report, cause: "Wrong password" },
        { ...report, branch: "list" },
        { ...report, branch: "other" },
        { version: 1, revision: 1, outcome: "unknown-submit", step: 1 },
        { ...report, revision: 0 },
        { ...report, step: 41 },
        { ...report, version: 2 },
        "{",
      ];
      const responses = await Promise.all(bodies.map((body) => send(device, "bank-login", body)));
      expect(responses.map((response) => response.status)).toEqual(bodies.map(() => 400));
      expect(await Promise.all(responses.map((response) => response.json()))).toEqual(
        bodies.map(() => ({ error: "bad_request" })),
      );
      expect((await send(device, "bank-login", report, "text/plain")).status).toBe(415);
      expect(
        (await send(device, "bank-login", { ...report, padding: "x".repeat(2_000) })).status,
      ).toBe(413);
      expect((await send(device, "not a recipe", report)).status).toBe(400);
      expect(await stored(device.ownerId)).toEqual([]);
    });

    it("requires a device credential and answers other methods with 405", async () => {
      const device = await enrollOwner();
      expect((await publish(device, "bank-login", 0)).status).toBe(200);
      const anonymous = await send(undefined, "bank-login", report);
      expect(anonymous.status).toBe(401);
      expect(await anonymous.json()).toEqual({ error: "unauthorized" });
      const wrong = await api(device, "/v1/recipes/bank-login/outcome", { method: "GET" });
      expect(wrong.status).toBe(405);
      expect(wrong.headers.get("Allow")).toBe("POST");
      expect(await stored(device.ownerId)).toEqual([]);
    });

    it("deletes codes older than a year when recipes are read or a code is kept", async () => {
      const device = await enrollOwner();
      expect((await publish(device, "bank-login", 0)).status).toBe(200);
      expect((await publish(device, "bank-login", 1)).status).toBe(200);
      expect((await publish(device, "bank-login", 2)).status).toBe(200);
      const insert = (revision: number, age: number) =>
        env.DB.prepare(
          "INSERT INTO login_outcomes (owner_id, recipe_id, branch, revision, outcome, step, created_at) VALUES (?, 'bank-login', '', ?, 'authenticated', 1, ?)",
        ).bind(device.ownerId, revision, Date.now() - age);
      await env.DB.batch([insert(1, 366 * DAY_MS), insert(2, 364 * DAY_MS)]);
      expect((await api(device, "/v1/recipes")).status).toBe(200);
      expect((await stored(device.ownerId)).map((row) => row["revision"])).toEqual([2]);
      await insert(1, 366 * DAY_MS).run();
      expect((await send(device, "bank-login", { ...report, revision: 3 })).status).toBe(204);
      expect((await stored(device.ownerId)).map((row) => row["revision"])).toEqual([2, 3]);
    });
  });

  // ADR 0055: every ended login's result and times, with the site the service reads itself.
}

export function registerLoginRecordTests() {
  describe("login records", () => {
    const record = {
      version: 1,
      revision: 1,
      branch: "1000",
      outcome: "authenticated",
      extensionBuild: "1c42ad3",
      totalMs: 9000,
      serviceMs: 2600,
      networkMs: 200,
      personMs: 4000,
      pageMs: 1800,
    };
    const send = (
      device: Device | undefined,
      id: string,
      body: unknown,
      type = "application/json",
    ) =>
      api(device, `/v1/recipes/${id}/logins`, {
        method: "POST",
        headers: { "Content-Type": type },
        body: typeof body === "string" ? body : JSON.stringify(body),
      });
    const stored = async (ownerId: string) =>
      (
        await env.DB.prepare(
          "SELECT recipe_id, branch, revision, origin, outcome, cause, extension_build, total_ms, service_ms, network_ms, person_ms, page_ms FROM login_timings WHERE owner_id = ? ORDER BY created_at, total_ms",
        )
          .bind(ownerId)
          .all()
      ).results;

    it("keeps one row per login, from any of the owner's devices, with the recipe's own site", async () => {
      const device = await enrollOwner();
      const other = await addDevice(device.ownerId);
      expect((await publish(device, "bank-login", 0)).status).toBe(200);
      expect((await publish(device, "bank-login", 1)).status).toBe(200);
      const before = Date.now();
      const first = await send(device, "bank-login", record);
      expect(first.status).toBe(204);
      expect(await first.text()).toBe("");
      // The same login sent again, or another login of the same revision, is another row.
      expect((await send(device, "bank-login", record)).status).toBe(204);
      expect(
        (
          await send(other, "bank-login", {
            ...record,
            revision: 2,
            branch: "1000:other",
            outcome: "structural-mismatch",
            cause: "target-missing",
            totalMs: 12_000,
          })
        ).status,
      ).toBe(204);
      const rows = await stored(device.ownerId);
      expect(rows).toHaveLength(3);
      expect(rows[0]).toEqual({
        recipe_id: "bank-login",
        branch: "1000",
        revision: 1,
        origin: "https://bank.example",
        outcome: "authenticated",
        cause: null,
        extension_build: "1c42ad3",
        total_ms: 9000,
        service_ms: 2600,
        network_ms: 200,
        person_ms: 4000,
        page_ms: 1800,
      });
      expect(rows.find((row) => row["revision"] === 2)).toMatchObject({
        branch: "1000:other",
        origin: "https://bank.example",
        outcome: "structural-mismatch",
        cause: "target-missing",
      });
      // The service stamps the time and the row's ID itself.
      const { results } = await env.DB.prepare(
        "SELECT id, created_at FROM login_timings WHERE owner_id = ?",
      )
        .bind(device.ownerId)
        .all<{ id: string; created_at: number }>();
      expect(new Set(results.map((row) => row.id)).size).toBe(3);
      expect(results.every((row) => row.created_at >= before && row.created_at <= Date.now())).toBe(
        true,
      );
      // Login records are apart from the first login result codes.
      expect(
        (
          await env.DB.prepare("SELECT COUNT(*) AS n FROM login_outcomes WHERE owner_id = ?")
            .bind(device.ownerId)
            .first<{ n: number }>()
        )?.n,
      ).toBe(0);
    });

    it("refuses a recipe or revision the owner never had, and a revoked head", async () => {
      const device = await enrollOwner();
      const stranger = await enrollOwner();
      expect((await publish(device, "bank-login", 0)).status).toBe(200);
      expect((await publish(stranger, "other-login", 0)).status).toBe(200);
      const statuses = await Promise.all([
        send(device, "missing-login", record),
        send(device, "other-login", record),
        send(stranger, "bank-login", record),
        send(device, "bank-login", { ...record, revision: 2 }),
      ]);
      expect(statuses.map((response) => response.status)).toEqual([404, 404, 404, 404]);
      expect(await statuses[0]!.json()).toEqual({ error: "not_found" });
      expect(
        (
          await put(device, "/v1/recipes/bank-login", {
            version: 1,
            expectedRevision: 1,
            state: "revoked",
          })
        ).status,
      ).toBe(200);
      // Revision 2 is the tombstone. Revision 1 ran before the revocation, but a revoked
      // recipe keeps no document, so the service can no longer name its site.
      expect((await send(device, "bank-login", { ...record, revision: 2 })).status).toBe(404);
      expect((await send(device, "bank-login", record)).status).toBe(404);
      expect(await stored(device.ownerId)).toEqual([]);
      expect(await stored(stranger.ownerId)).toEqual([]);
    });

    it("keeps where Pateat's own time went, and nothing for a record without it", async () => {
      const device = await enrollOwner();
      expect((await publish(device, "bank-login", 0)).status).toBe(200);
      const parts = {
        beforeShownMs: 400,
        startMs: 300,
        awaitMs: 1200,
        saveMs: 100,
        statusMs: 0,
        checkMs: 0,
        vaultMs: 100,
        commandMs: 200,
      };
      expect((await send(device, "bank-login", { ...record, ...parts })).status).toBe(204);
      expect((await send(device, "bank-login", { ...record, totalMs: 9500 })).status).toBe(204);
      const { results } = await env.DB.prepare(
        "SELECT before_shown_ms, start_ms, await_ms, save_ms, status_ms, check_ms, vault_ms, command_ms FROM login_timings WHERE owner_id = ? ORDER BY total_ms",
      )
        .bind(device.ownerId)
        .all();
      expect(results).toEqual([
        {
          before_shown_ms: 400,
          start_ms: 300,
          await_ms: 1200,
          save_ms: 100,
          status_ms: 0,
          check_ms: 0,
          vault_ms: 100,
          command_ms: 200,
        },
        {
          before_shown_ms: null,
          start_ms: null,
          await_ms: null,
          save_ms: null,
          status_ms: null,
          check_ms: null,
          vault_ms: null,
          command_ms: null,
        },
      ]);
    });

    it("takes the site from the newest kept revision once the reported one is pruned", async () => {
      const device = await enrollOwner();
      expect((await publish(device, "bank-login", 0)).status).toBe(200);
      expect((await publish(device, "bank-login", 1)).status).toBe(200);
      await env.DB.prepare(
        "DELETE FROM recipe_revisions WHERE owner_id = ? AND recipe_id = 'bank-login' AND revision = 1",
      )
        .bind(device.ownerId)
        .run();
      expect((await send(device, "bank-login", record)).status).toBe(204);
      expect((await stored(device.ownerId)).map((row) => [row["revision"], row["origin"]])).toEqual(
        [[1, "https://bank.example"]],
      );
    });

    it("refuses a site, values, typing time and anything beyond the record, without echoing it", async () => {
      const device = await enrollOwner();
      const ownParts = {
        beforeShownMs: 0,
        startMs: 0,
        awaitMs: 0,
        saveMs: 0,
        statusMs: 0,
        checkMs: 0,
        vaultMs: 0,
        commandMs: 0,
      };
      expect((await publish(device, "bank-login", 0)).status).toBe(200);
      const bodies: unknown[] = [
        { ...record, origin: "https://bank.example" },
        { ...record, url: "https://bank.example/login?user=someone" },
        { ...record, reason: "Password for someone@example.com was wrong" },
        { ...record, typingMs: 120 },
        { ...record, otherMs: 2400 },
        { ...record, createdAt: 1 },
        { ...record, outcome: "wrong password" },
        { ...record, cause: "Wrong password" },
        { ...record, extensionBuild: "someone@example.com" },
        { ...record, totalMs: -1 },
        { ...record, totalMs: 86_400_001 },
        { ...record, serviceMs: 1.5 },
        { ...record, pageMs: -1 },
        { ...record, pageMs: undefined },
        // Parts of Pateat's own time are whole steps of 100 ms, all of them or none (ADR 0055).
        { ...record, ...ownParts, startMs: 150 },
        { ...record, ...ownParts, awaitMs: -100 },
        { ...record, ...ownParts, fillMs: 300 },
        { ...record, startMs: 100 },
        { ...record, branch: "list" },
        { ...record, revision: 0 },
        { ...record, version: 2 },
        "{",
      ];
      const responses = await Promise.all(bodies.map((body) => send(device, "bank-login", body)));
      expect(responses.map((response) => response.status)).toEqual(bodies.map(() => 400));
      expect(await Promise.all(responses.map((response) => response.json()))).toEqual(
        bodies.map(() => ({ error: "bad_request" })),
      );
      expect((await send(device, "bank-login", record, "text/plain")).status).toBe(415);
      expect(
        (await send(device, "bank-login", { ...record, padding: "x".repeat(2_000) })).status,
      ).toBe(413);
      expect((await send(device, "not a recipe", record)).status).toBe(400);
      expect(await stored(device.ownerId)).toEqual([]);
    });

    it("requires a device credential and answers other methods with 405", async () => {
      const device = await enrollOwner();
      expect((await publish(device, "bank-login", 0)).status).toBe(200);
      const anonymous = await send(undefined, "bank-login", record);
      expect(anonymous.status).toBe(401);
      expect(await anonymous.json()).toEqual({ error: "unauthorized" });
      const wrong = await api(device, "/v1/recipes/bank-login/logins", { method: "GET" });
      expect(wrong.status).toBe(405);
      expect(wrong.headers.get("Allow")).toBe("POST");
      expect(await stored(device.ownerId)).toEqual([]);
    });

    it("deletes records older than a year when recipes are read or a record is kept", async () => {
      const device = await enrollOwner();
      expect((await publish(device, "bank-login", 0)).status).toBe(200);
      const insert = (totalMs: number, age: number) =>
        env.DB.prepare(
          "INSERT INTO login_timings (id, owner_id, recipe_id, branch, revision, origin, outcome, extension_build, total_ms, service_ms, network_ms, person_ms, page_ms, created_at) VALUES (?, ?, 'bank-login', '', 1, 'https://bank.example', 'authenticated', 'development', ?, 0, 0, 0, 0, ?)",
        ).bind(`login-${crypto.randomUUID()}`, device.ownerId, totalMs, Date.now() - age);
      await env.DB.batch([insert(1, 366 * DAY_MS), insert(2, 364 * DAY_MS)]);
      expect((await api(device, "/v1/recipes")).status).toBe(200);
      expect((await stored(device.ownerId)).map((row) => row["total_ms"])).toEqual([2]);
      await insert(3, 366 * DAY_MS).run();
      expect((await send(device, "bank-login", record)).status).toBe(204);
      expect((await stored(device.ownerId)).map((row) => row["total_ms"])).toEqual([2, 9000]);
    });
  });
}
