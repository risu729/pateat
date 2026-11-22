import * as v from "valibot";
import { loginDocumentSchema, vaultFieldReferenceSchema } from "@pateat/contracts";

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
/** Ends the tab's pending request before it starts a login; a started login is not stopped. */
export const manualCancelRequestSchema = v.strictObject({
  version: v.literal(1),
  type: v.literal("login.manual.cancel"),
  tabId,
  requestId: ref,
});
export const manualCancelResponseSchema = v.strictObject({ ok: v.boolean() });
/**
 * The popup's **Fill** on a verification page (ADR 0035, amended 2026-11-17): the person's
 * chosen account fills the page's fields once, and no button is pressed.
 */
export const confirmFillRequestSchema = v.strictObject({
  version: v.literal(1),
  type: v.literal("login.confirm.fill"),
  requestId: ref,
  document: loginDocumentSchema,
  scope: ref,
  connectionId: ref,
  itemId: ref,
  /**
   * The vault field the person chose for the page's one slot, saved as the account's
   * binding of the page's recipe before the fill (ADR 0035, amended 2026-11-22); `null`
   * clears a saved field no longer offered, so the recipe's own choice fills.
   */
  field: v.optional(v.nullable(vaultFieldReferenceSchema)),
});
export const confirmFillStatusSchema = v.strictObject({
  requestId: ref,
  state: v.picklist(["preparing", "generating", "asked", "filled", "kept", "blocked"]),
  reason: v.optional(v.pipe(v.string(), v.maxLength(100))),
});
export const confirmFillResponseSchema = v.variant("ok", [
  v.strictObject({
    ok: v.literal(true),
    state: v.picklist(["preparing", "generating", "asked", "filled", "kept"]),
  }),
  v.strictObject({ ok: v.literal(false), reason: v.pipe(v.string(), v.maxLength(100)) }),
]);
/**
 * `choosing`: the request waits for the person's sign-in method choice in the popup, as
 * for an item with SSO methods (ADR 0085, amendment of 2026-11-18).
 */
export const manualStatusSchema = v.strictObject({
  requestId: ref,
  state: v.picklist(["evaluating", "generating", "choosing", "started", "blocked"]),
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
          /** A verification page: the popup offers **Fill** instead of **Log in now**. */
          fill: v.optional(v.literal(true)),
          candidates: v.pipe(
            v.array(
              v.strictObject({
                connectionId: ref,
                itemId: ref,
                /**
                 * On a verification page whose recipe fills one slot: the account's fields
                 * the person may choose for it, the built-in password without a name, and
                 * the one its saved binding names (ADR 0035, amended 2026-11-22).
                 */
                fields: v.optional(
                  v.pipe(
                    v.array(
                      v.strictObject({
                        field: vaultFieldReferenceSchema,
                        name: v.optional(v.pipe(v.string(), v.maxLength(1000))),
                      }),
                    ),
                    v.maxLength(30),
                  ),
                ),
                chosen: v.optional(vaultFieldReferenceSchema),
                /** The binding names a field for the slot, offered (`chosen`) or not. */
                saved: v.optional(v.literal(true)),
              }),
            ),
            v.maxLength(100),
          ),
        }),
      ),
      v.maxLength(100),
    ),
    status: v.optional(manualStatusSchema),
    /** The tab's latest **Fill** press, while it runs and how it ended. */
    fill: v.optional(confirmFillStatusSchema),
    reason: v.optional(v.pipe(v.string(), v.maxLength(100))),
  }),
  v.strictObject({ ok: v.literal(false), reason: v.literal("no-page") }),
]);
export const manualStartResponseSchema = v.variant("ok", [
  v.strictObject({
    ok: v.literal(true),
    state: v.picklist(["evaluating", "generating", "choosing", "started"]),
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
export type ConfirmFillStatus = v.InferOutput<typeof confirmFillStatusSchema>;
export type ConfirmFillRequest = Omit<
  v.InferOutput<typeof confirmFillRequestSchema>,
  "version" | "type"
>;
export type ConfirmFillResponse = v.InferOutput<typeof confirmFillResponseSchema>;

export interface ManualClient {
  get(tabId: number): Promise<ManualOfferResponse>;
  start(request: ManualStartRequest): Promise<ManualStartResponse>;
  cancel(tabId: number, requestId: string): Promise<{ ok: boolean }>;
  fill(request: ConfirmFillRequest): Promise<ConfirmFillResponse>;
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
    cancel: async (tab, requestId) =>
      v.parse(
        manualCancelResponseSchema,
        await send({ version: 1, type: "login.manual.cancel", tabId: tab, requestId }),
      ),
    fill: async (request) =>
      v.parse(
        confirmFillResponseSchema,
        await send({ version: 1, type: "login.confirm.fill", ...request }),
      ),
  };
}
