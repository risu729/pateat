import * as v from "valibot";

const id = v.pipe(v.string(), v.minLength(1), v.maxLength(200));
const tabId = v.pipe(v.number(), v.integer(), v.minValue(0));
export const bindingReviewRequestSchema = v.strictObject({
  version: v.literal(1),
  type: v.literal("login.binding-review.get"),
  tabId,
  /** Only the popup's first read may ask a document the worker forgot to announce again. */
  reconnect: v.optional(v.literal(true)),
});
export const bindingRepairRequestSchema = v.strictObject({
  version: v.literal(1),
  type: v.literal("login.binding-review.pick"),
  tabId,
  reviewId: id,
  picks: v.pipe(
    v.array(v.strictObject({ slot: id, fieldId: id })),
    v.minLength(1),
    v.maxLength(100),
  ),
});
export const bindingReviewResponseSchema = v.strictObject({
  ok: v.literal(true),
  blocked: v.array(v.strictObject({ id: v.string(), connection: v.string(), item: v.string() })),
  repair: v.optional(
    v.strictObject({
      reviewId: id,
      origin: v.string(),
      item: v.string(),
      slots: v.array(
        v.strictObject({
          slot: id,
          name: v.string(),
          reason: v.picklist(["field-missing", "field-ambiguous", "field-count-changed"]),
          candidates: v.array(v.strictObject({ fieldId: id, name: v.string() })),
        }),
      ),
    }),
  ),
});
export const bindingRepairResponseSchema = v.variant("ok", [
  // A re-prompt item's restart waits for its master password, with the choice kept.
  v.strictObject({ ok: v.literal(true), waiting: v.optional(v.literal("master-password")) }),
  v.strictObject({
    ok: v.literal(false),
    reason: v.picklist(["stale-review", "not-a-candidate", "unavailable"]),
  }),
]);
export type BindingReviewResponse = v.InferOutput<typeof bindingReviewResponseSchema>;
export type BindingRepairRequest = v.InferOutput<typeof bindingRepairRequestSchema>;
export type BindingRepairResponse = v.InferOutput<typeof bindingRepairResponseSchema>;
export interface BindingReviewClient {
  get(tabId: number, reconnect?: boolean): Promise<BindingReviewResponse>;
  pick(request: Omit<BindingRepairRequest, "version" | "type">): Promise<BindingRepairResponse>;
}
export function createBindingReviewClient(
  send: (message: unknown) => Promise<unknown>,
): BindingReviewClient {
  return {
    get: async (tab, reconnect) =>
      v.parse(
        bindingReviewResponseSchema,
        await send({
          version: 1,
          type: "login.binding-review.get",
          tabId: tab,
          ...(reconnect ? { reconnect: true } : {}),
        }),
      ),
    pick: async (request) =>
      v.parse(
        bindingRepairResponseSchema,
        await send({ version: 1, type: "login.binding-review.pick", ...request }),
      ),
  };
}
