import { and, desc, eq, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { Hono } from "hono";
import { html } from "hono/html";
import { validator } from "hono/validator";
import * as v from "valibot";
import type { ApiEnv } from "../auth";
import { devices } from "../db/schema";
import { findOwner } from "../owners";
import { message, page } from "../pages";
import { requireFormBody } from "../validation";

const deviceParamSchema = v.strictObject({
  deviceId: v.pipe(v.string(), v.minLength(1), v.maxLength(100)),
});

function formatTime(milliseconds: number) {
  return new Date(milliseconds).toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

/** Access-protected device list and revocation for the signed-in owner only. */
export const manageRoutes = new Hono<ApiEnv>()
  .get("/", async (c) => {
    const ownerId = await findOwner(c.env.DB, c.get("identity"));
    const rows = ownerId
      ? await drizzle(c.env.DB)
          .select({
            id: devices.id,
            label: devices.label,
            createdAt: devices.createdAt,
            revokedAt: devices.revokedAt,
          })
          .from(devices)
          .where(eq(devices.ownerId, ownerId))
          .orderBy(desc(devices.createdAt))
      : [];
    if (rows.length === 0)
      return message(c, 200, "Devices", "No devices are paired with this account.");
    return page(
      c,
      200,
      "Devices",
      html`<p>
          Revoking a device stops its later service requests. It does not erase data already stored
          on that device or affect any vault.
        </p>
        <table>
          <thead>
            <tr>
              <th scope="col">Device</th>
              <th scope="col">Paired</th>
              <th scope="col">Status</th>
            </tr>
          </thead>
          <tbody>
            ${rows.map(
              (row) =>
                html`<tr>
                  <td>${row.label || "Unnamed device"}</td>
                  <td>${formatTime(row.createdAt)}</td>
                  <td>
                    ${
                      row.revokedAt === null
                        ? html`<form
                            method="post"
                            action="/manage/devices/${encodeURIComponent(row.id)}/revoke"
                          >
                            <button type="submit">Revoke</button>
                          </form>`
                        : `Revoked ${formatTime(row.revokedAt)}`
                    }
                  </td>
                </tr>`,
            )}
          </tbody>
        </table>`,
    );
  })
  .post(
    "/devices/:deviceId/revoke",
    validator("param", (value, c) => {
      const result = v.safeParse(deviceParamSchema, value);
      return result.success ? result.output : message(c, 404, "Not found", "No such device.");
    }),
    requireFormBody,
    async (c) => {
      const { deviceId } = c.req.valid("param");
      const ownerId = await findOwner(c.env.DB, c.get("identity"));
      if (!ownerId) return message(c, 404, "Not found", "No such device.");
      const db = drizzle(c.env.DB);
      const owned = and(eq(devices.id, deviceId), eq(devices.ownerId, ownerId));
      const result = await db
        .update(devices)
        .set({ revokedAt: Date.now() })
        .where(and(owned, isNull(devices.revokedAt)));
      if (result.meta.changes !== 1) {
        const [existing] = await db.select({ id: devices.id }).from(devices).where(owned).limit(1);
        if (!existing) return message(c, 404, "Not found", "No such device.");
      }
      return c.redirect("/manage", 303);
    },
  );
