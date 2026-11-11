import * as v from "valibot";
import { loginDocumentSchema } from "@pateat/contracts";

const tabId = v.pipe(v.number(), v.integer(), v.minValue(0));
const ref = v.pipe(v.string(), v.minLength(1), v.maxLength(512));
export const manualOfferRequestSchema = v.strictObject({
  version: v.literal(1),
  type: v.literal("login.manual.get"),
  tabId,
});
export const manualStartRequestSchema = v.strictObject({
  version: v.literal(1),
  type: v.literal("login.manual.start"),
  requestId: ref,
  document: loginDocumentSchema,
  scope: ref,
  connectionId: ref,
  itemId: ref,
});
export const manualStatusSchema = v.strictObject({
  requestId: ref,
  state: v.picklist(["evaluating", "generating", "started", "blocked"]),
  reason: v.optional(v.pipe(v.string(), v.maxLength(100))),
});
export const manualOfferResponseSchema = v.variant("ok", [
  v.strictObject({
    ok: v.literal(true),
    targets: v.pipe(
      v.array(
        v.strictObject({
          document: loginDocumentSchema,
          scope: ref,
          candidates: v.pipe(
            v.array(v.strictObject({ connectionId: ref, itemId: ref })),
            v.maxLength(100),
          ),
        }),
      ),
      v.maxLength(100),
    ),
    status: v.optional(manualStatusSchema),
    reason: v.optional(v.pipe(v.string(), v.maxLength(100))),
  }),
  v.strictObject({ ok: v.literal(false), reason: v.literal("no-page") }),
]);
export const manualStartResponseSchema = v.variant("ok", [
  v.strictObject({
    ok: v.literal(true),
    state: v.picklist(["evaluating", "generating", "started"]),
  }),
  v.strictObject({ ok: v.literal(false), reason: v.pipe(v.string(), v.maxLength(100)) }),
]);
export type ManualStatus = v.InferOutput<typeof manualStatusSchema>;
export type ManualOfferResponse = v.InferOutput<typeof manualOfferResponseSchema>;
export type ManualStartRequest = Omit<
  v.InferOutput<typeof manualStartRequestSchema>,
  "version" | "type"
>;
export type ManualStartResponse = v.InferOutput<typeof manualStartResponseSchema>;

export interface ManualClient {
  get(tabId: number): Promise<ManualOfferResponse>;
  start(request: ManualStartRequest): Promise<ManualStartResponse>;
}

export function createManualClient(send: (message: unknown) => Promise<unknown>): ManualClient {
  return {
    get: async (tab) =>
      v.parse(
        manualOfferResponseSchema,
        await send({ version: 1, type: "login.manual.get", tabId: tab }),
      ),
    start: async (request) =>
      v.parse(
        manualStartResponseSchema,
        await send({ version: 1, type: "login.manual.start", ...request }),
      ),
  };
}
