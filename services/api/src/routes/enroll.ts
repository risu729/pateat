import {
  deviceLabelSchema,
  enrollmentChallengeSchema,
  enrollmentCode,
  normalizeEnrollmentCode,
} from "@pateat/contracts";
import { and, eq, isNull, lte } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { Hono } from "hono";
import { html } from "hono/html";
import { validator } from "hono/validator";
import * as v from "valibot";
import type { ApiEnv } from "../auth";
import { enrollments } from "../db/schema";
import { resolveOwner } from "../owners";
import { message, page } from "../pages";
import { requireFormBody } from "../validation";

/** How long an approval waits for the extension to redeem it. */
export const ENROLLMENT_TTL_MS = 10 * 60 * 1000;

const requestSchema = v.strictObject({
  challenge: enrollmentChallengeSchema,
  label: deviceLabelSchema,
});
const approvalSchema = v.strictObject({
  challenge: enrollmentChallengeSchema,
  label: deviceLabelSchema,
  code: v.pipe(v.string(), v.maxLength(32)),
});

const invalidRequest = (c: Parameters<typeof message>[0]) =>
  message(c, 400, "Invalid request", "Start pairing again from Pateat's settings.");

/** Access-protected owner approval of a device's pairing challenge. */
export const enrollRoutes = new Hono<ApiEnv>()
  .get(
    "/",
    validator("query", (value, c) => {
      const result = v.safeParse(requestSchema, value);
      return result.success ? result.output : invalidRequest(c);
    }),
    (c) => {
      const { challenge, label } = c.req.valid("query");
      return page(
        c,
        200,
        "Approve device",
        html`<p>Approve <strong>${label}</strong> as a Pateat device for this account.</p>
          <p>
            Type the code shown in Pateat's settings. If you did not just start pairing in Pateat,
            close this page.
          </p>
          <form method="post" action="/enroll">
            <input type="hidden" name="challenge" value="${challenge}" />
            <input type="hidden" name="label" value="${label}" />
            <p>
              <label for="code">Code</label>
              <input
                id="code"
                name="code"
                required
                maxlength="32"
                autocomplete="off"
                autocapitalize="characters"
                spellcheck="false"
              />
            </p>
            <button type="submit">Approve device</button>
          </form>`,
      );
    },
  )
  .post(
    "/",
    requireFormBody,
    validator("form", (value, c) => {
      const result = v.safeParse(approvalSchema, value);
      return result.success ? result.output : invalidRequest(c);
    }),
    async (c) => {
      const { challenge, label, code } = c.req.valid("form");
      // The typed code proves the owner sees this challenge on their own device, so
      // a link carrying someone else's challenge cannot be approved by mistake.
      if (normalizeEnrollmentCode(code) !== enrollmentCode(challenge))
        return message(
          c,
          400,
          "Code does not match",
          "Go back and type the code shown in Pateat. Close this page if you did not start pairing.",
        );

      const ownerId = await resolveOwner(c.env.DB, c.get("identity"));
      const db = drizzle(c.env.DB);
      const now = Date.now();
      await db.batch([
        db
          .delete(enrollments)
          .where(and(isNull(enrollments.redeemedAt), lte(enrollments.expiresAt, now))),
        db
          .insert(enrollments)
          .values({
            challenge,
            ownerId,
            label,
            approvedAt: now,
            expiresAt: now + ENROLLMENT_TTL_MS,
          })
          .onConflictDoNothing(),
      ]);
      const [row] = await db
        .select()
        .from(enrollments)
        .where(eq(enrollments.challenge, challenge))
        .limit(1);
      // Approving the same pending challenge again is harmless; anything else is reuse.
      if (!row || row.ownerId !== ownerId || row.redeemedAt !== null || row.expiresAt <= now)
        return message(
          c,
          409,
          "Already used",
          "This pairing request was already used. Start pairing again from Pateat's settings.",
        );
      return message(
        c,
        200,
        "Device approved",
        "Return to Pateat to finish pairing. The approval expires in 10 minutes.",
      );
    },
  );
