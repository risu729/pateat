import * as v from "valibot";
import type {
  BitwardenResult,
  LocalFieldReference,
  PreparedBitwardenAccount,
} from "@pateat/bitwarden";

export const CRYPTO_PORT = "pateat.crypto-host.v1";
export const OFFSCREEN_PATH = "/crypto-offscreen.html";
export const MAX_MESSAGE_BYTES = 32 * 1024 * 1024;
const id = v.pipe(v.string(), v.minLength(1), v.maxLength(128));
const uuid = v.pipe(v.string(), v.uuid());
export const sessionSchema = v.strictObject({
  brokerGeneration: uuid,
  connectionId: id,
  userId: uuid,
  sessionId: uuid,
  snapshotId: uuid,
});
export type HostSessionRef = v.InferOutput<typeof sessionSchema>;
export type HostUnlock =
  | { kind: "password"; password: string }
  | { kind: "decrypted-key"; userKey: string };
export type HostOperation =
  | { kind: "derive-auth"; input: unknown }
  | { kind: "open"; prepared: PreparedBitwardenAccount; snapshotId: string; unlock: HostUnlock }
  | { kind: "decrypt" | "list"; session: HostSessionRef; itemId: string }
  | { kind: "verify-received-ciphers" | "export-unlock" | "catalog"; session: HostSessionRef }
  | {
      kind: "resolve";
      session: HostSessionRef;
      ref: LocalFieldReference;
      allowedFieldIds: readonly string[];
      nowMs?: number;
    }
  | { kind: "lock"; session: HostSessionRef }
  | { kind: "close" };
export const commandSchema = v.strictObject({
  version: v.literal(1),
  type: v.literal("crypto.command"),
  generation: uuid,
  requestId: uuid,
  connectionId: id,
  operation: v.variant("kind", [
    v.strictObject({ kind: v.literal("derive-auth"), input: v.unknown() }),
    v.strictObject({
      kind: v.literal("open"),
      prepared: v.unknown(),
      snapshotId: uuid,
      unlock: v.variant("kind", [
        v.strictObject({
          kind: v.literal("password"),
          password: v.pipe(v.string(), v.minLength(1)),
        }),
        v.strictObject({
          kind: v.literal("decrypted-key"),
          userKey: v.pipe(v.string(), v.minLength(1), v.maxLength(1_048_576)),
        }),
      ]),
    }),
    v.strictObject({ kind: v.picklist(["decrypt", "list"]), session: sessionSchema, itemId: uuid }),
    v.strictObject({
      kind: v.picklist(["verify-received-ciphers", "export-unlock", "catalog"]),
      session: sessionSchema,
    }),
    v.strictObject({
      kind: v.literal("resolve"),
      session: sessionSchema,
      ref: v.strictObject({
        connectionId: id,
        userId: uuid,
        itemId: uuid,
        snapshotId: uuid,
        fieldId: id,
      }),
      allowedFieldIds: v.pipe(v.array(id), v.maxLength(2_000)),
      nowMs: v.optional(
        v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(Number.MAX_SAFE_INTEGER)),
      ),
    }),
    v.strictObject({ kind: v.literal("lock"), session: sessionSchema }),
    v.strictObject({ kind: v.literal("close") }),
  ]),
});
export type HostCommand = v.InferOutput<typeof commandSchema>;
export const controlSchema = v.variant("type", [
  v.strictObject({ version: v.literal(1), type: v.literal("crypto.reset"), generation: uuid }),
  v.strictObject({
    version: v.literal(1),
    type: v.literal("crypto.cancel"),
    generation: uuid,
    requestId: uuid,
    session: v.optional(sessionSchema),
  }),
]);
export const lifecycleSchema = v.variant("type", [
  v.strictObject({ version: v.literal(1), type: v.literal("crypto.hello") }),
  v.strictObject({ version: v.literal(1), type: v.literal("crypto.ready"), generation: uuid }),
]);
export const replySchema = v.strictObject({
  version: v.literal(1),
  type: v.literal("crypto.result"),
  generation: uuid,
  requestId: uuid,
  connectionId: id,
  result: v.unknown(),
});
export const progressSchema = v.strictObject({
  version: v.literal(1),
  type: v.literal("crypto.dispatched"),
  generation: uuid,
  requestId: uuid,
  connectionId: id,
});
export type HostReply = Omit<v.InferOutput<typeof replySchema>, "result"> & {
  result: BitwardenResult<unknown>;
};
export function boundedMessage(value: unknown): boolean {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength <= MAX_MESSAGE_BYTES;
  } catch {
    return false;
  }
}
