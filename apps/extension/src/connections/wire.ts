import { bitwardenEmail } from "@pateat/bitwarden";
import * as v from "valibot";
import type { SetupReply } from "./types";

export const SETUP_PORT = "pateat.bitwarden-setup.v1";
const id = v.pipe(v.string(), v.minLength(1), v.maxLength(200));
const email = bitwardenEmail;
const password = v.pipe(v.string(), v.minLength(1));
const environment = v.variant("kind", [
  v.strictObject({ kind: v.literal("cloud"), region: v.picklist(["us", "eu"]) }),
  v.strictObject({
    kind: v.literal("self-hosted"),
    baseUrl: v.pipe(v.string(), v.maxLength(2048)),
  }),
]);
export const setupBeginSchema = v.variant("kind", [
  v.strictObject({
    kind: v.literal("new"),
    environment,
    label: v.pipe(id, v.maxLength(200)),
    email,
    password,
    enabled: v.boolean(),
  }),
  v.strictObject({
    kind: v.literal("existing"),
    connectionId: id,
    password,
    autoUnlock: v.picklist(["enable", "preserve"]),
  }),
]);
export const setupContinuationSchema = v.pipe(
  v.strictObject({
    flowId: v.pipe(v.string(), v.uuid()),
    twoFactor: v.optional(
      v.strictObject({
        provider: v.picklist([0, 1]),
        code: v.pipe(v.string(), v.minLength(1), v.maxLength(1024)),
      }),
    ),
    newDeviceOtp: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(1024))),
  }),
  v.check((input) => input.twoFactor !== undefined || input.newDeviceOtp !== undefined),
);
export const setupRequestSchema = v.variant("type", [
  v.strictObject({
    requestId: v.pipe(v.string(), v.uuid()),
    type: v.literal("connection.begin"),
    input: setupBeginSchema,
  }),
  v.strictObject({
    requestId: v.pipe(v.string(), v.uuid()),
    type: v.literal("connection.continue"),
    input: setupContinuationSchema,
  }),
  v.strictObject({
    requestId: v.pipe(v.string(), v.uuid()),
    type: v.picklist(["connection.cancel", "connection.send-email-code"]),
    flowId: id,
  }),
  v.strictObject({ requestId: v.pipe(v.string(), v.uuid()), type: v.literal("connection.status") }),
  v.strictObject({
    requestId: v.pipe(v.string(), v.uuid()),
    type: v.picklist([
      "connection.sync",
      "connection.disable",
      "connection.forget",
      "connection.delete",
    ]),
    connectionId: id,
  }),
  v.strictObject({
    requestId: v.pipe(v.string(), v.uuid()),
    type: v.literal("connection.review"),
    input: v.strictObject({
      connectionId: id,
      itemId: v.pipe(v.string(), v.uuid()),
      snapshotId: v.pipe(v.string(), v.uuid()),
      expectedRevision: v.pipe(v.number(), v.integer(), v.minValue(0)),
      excludedFieldIds: v.pipe(v.array(id), v.maxLength(2000)),
    }),
  }),
]);
const errorCode = v.pipe(v.string(), v.minLength(1), v.maxLength(80), v.regex(/^[a-z-]+$/));
const replySchema = v.union([
  v.strictObject({
    ok: v.literal(false),
    error: v.strictObject({
      code: errorCode,
      check: v.optional(v.pipe(v.string(), v.maxLength(40), v.regex(/^[a-z-]+$/))),
    }),
  }),
  v.strictObject({
    ok: v.literal(true),
    kind: v.literal("ready"),
    connectionId: id,
    snapshotId: v.pipe(v.string(), v.uuid()),
    policyReviewItemIds: v.pipe(v.array(id), v.maxLength(10000)),
  }),
  v.strictObject({
    ok: v.literal(true),
    kind: v.literal("mfa-required"),
    flowId: v.pipe(v.string(), v.uuid()),
    providers: v.pipe(v.array(v.picklist([0, 1])), v.maxLength(2)),
  }),
  v.strictObject({
    ok: v.literal(true),
    kind: v.literal("email-code"),
    flowId: v.pipe(v.string(), v.uuid()),
    result: v.picklist(["sent", "rate-limited", "unavailable", "refused", "failed"]),
  }),
  v.strictObject({
    ok: v.literal(true),
    kind: v.literal("new-device-verification-required"),
    flowId: v.pipe(v.string(), v.uuid()),
    invalidOtp: v.boolean(),
  }),
  v.strictObject({
    ok: v.literal(true),
    kind: v.literal("interaction-required"),
    reason: v.picklist(["sso", "protocol-compatibility", "unsupported-challenge"]),
  }),
  v.strictObject({ ok: v.literal(true), kind: v.literal("cancelled") }),
  v.strictObject({ ok: v.literal(true), kind: v.literal("disabled"), connectionId: id }),
  v.strictObject({ ok: v.literal(true), kind: v.literal("forgotten"), connectionId: id }),
  v.strictObject({ ok: v.literal(true), kind: v.literal("deleted"), connectionId: id }),
  v.strictObject({
    ok: v.literal(true),
    kind: v.literal("status"),
    connections: v.pipe(
      v.array(
        v.strictObject({
          connectionId: id,
          label: id,
          email,
          environment,
          autoUnlock: v.picklist(["enabled", "disabled", "unknown"]),
          state: v.picklist(["configured", "ready", "disabled", "review-required", "unavailable"]),
          providerSession: v.picklist([
            "none",
            "active",
            "refresh-required",
            "reauthentication-required",
            "unavailable",
          ]),
          snapshotId: v.optional(v.pipe(v.string(), v.uuid())),
          syncedAt: v.optional(
            v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(Number.MAX_SAFE_INTEGER)),
          ),
        }),
      ),
      v.maxLength(100),
    ),
  }),
]);
export function parseSetupReply(input: unknown): SetupReply {
  return v.parse(replySchema, input) as SetupReply;
}
