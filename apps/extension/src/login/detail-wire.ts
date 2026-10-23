import { detailFormatSchema, loginDetailSchema, type LoginDetail } from "@pateat/contracts";
import type { TFunction } from "i18next";
import * as v from "valibot";

const id = v.pipe(v.string(), v.minLength(1), v.maxLength(120));
const tabId = v.pipe(v.number(), v.integer(), v.minValue(0));
/** A vault item's or field's label from the device's catalog, for display only. */
const label = v.pipe(v.string(), v.minLength(1), v.maxLength(200));

/**
 * The toolbar popup asks what personal details the tab's page asks for and which vault
 * items could give them (ADR 0061), and which links the site's login item has.
 */
export const detailRequestSchema = v.strictObject({
  version: v.literal(1),
  type: v.literal("login.detail.get"),
  tabId,
});
const sourceSchema = v.strictObject({
  connectionId: id,
  itemId: id,
  fieldId: id,
  itemLabel: label,
  fieldLabel: label,
});
export const detailResponseSchema = v.variant("ok", [
  v.strictObject({
    ok: v.literal(true),
    origin: v.string(),
    /**
     * The page's `detail` handler that the tab's last login stopped at for want of a link,
     * with the vault fields that could give each detail it asks for, the best guess first.
     * Absent when no login stopped there or no field could give one.
     */
    offer: v.optional(
      v.strictObject({
        documentId: id,
        details: v.pipe(
          v.array(
            v.strictObject({
              detail: loginDetailSchema,
              format: v.optional(detailFormatSchema),
              candidates: v.pipe(v.array(sourceSchema), v.minLength(1), v.maxLength(20)),
              /**
               * The first candidate is no guess and is not selected, as for a member ID,
               * whose fields' names say little.
               */
              preselect: v.optional(v.literal(false)),
            }),
          ),
          v.minLength(1),
          v.maxLength(3),
        ),
      }),
    ),
    /** The links saved for the tab's login item on this site, and one kept for this tab. */
    links: v.pipe(
      v.array(
        v.strictObject({
          detail: loginDetailSchema,
          itemLabel: label,
          fieldLabel: label,
          /** Kept for this tab until its login is confirmed, not yet saved. */
          pending: v.optional(v.literal(true)),
        }),
      ),
      v.maxLength(loginDetailSchema.options.length),
    ),
  }),
  v.strictObject({ ok: v.literal(false), reason: v.literal("no-page") }),
]);
/**
 * The popup's **Fill**: fill the offered input with the value made from this field, in the
 * offer's document, without pressing its button, and keep the link for the tab until its
 * login is confirmed.
 */
export const detailFillRequestSchema = v.strictObject({
  version: v.literal(1),
  type: v.literal("login.detail.fill"),
  tabId,
  documentId: id,
  detail: loginDetailSchema,
  connectionId: id,
  itemId: id,
  fieldId: id,
});
export const detailFillResponseSchema = v.variant("ok", [
  v.strictObject({ ok: v.literal(true) }),
  v.strictObject({
    ok: v.literal(false),
    reason: v.picklist([
      /** The tab shows another document, or no longer shows the offer's input. */
      "document-gone",
      /** The offer is gone, or does not list this field for this detail. */
      "not-a-candidate",
      /** The field's value is not a date, or has too few or too many digits. */
      "unreadable",
      /** The vault is locked or the field may no longer be used. */
      "unavailable",
      /** The page refused the fill. */
      "not-filled",
      /** The page shows another account than the login item's. */
      "other-account",
    ]),
  }),
]);
/** The popup's **Remove**: drop the site's link for this detail, saved or pending. */
export const detailRemoveRequestSchema = v.strictObject({
  version: v.literal(1),
  type: v.literal("login.detail.remove"),
  tabId,
  detail: loginDetailSchema,
});
export const detailRemoveResponseSchema = v.variant("ok", [
  v.strictObject({ ok: v.literal(true) }),
  v.strictObject({
    ok: v.literal(false),
    reason: v.picklist(["no-link", "not-saved"]),
  }),
]);

export type DetailResponse = v.InferOutput<typeof detailResponseSchema>;
export type DetailFillRequest = Omit<
  v.InferOutput<typeof detailFillRequestSchema>,
  "version" | "type"
>;
export type DetailFillResponse = v.InferOutput<typeof detailFillResponseSchema>;
export type DetailRemoveResponse = v.InferOutput<typeof detailRemoveResponseSchema>;

/** What each detail is, as the popup says it (ADR 0061), in the UI language. */
export function detailName(detail: LoginDetail, t: TFunction, format?: string): string {
  if (detail === "birth-date")
    return format === "yyyymm"
      ? t("your birth year and month")
      : format === "mmdd"
        ? t("your birth month and day")
        : t("your birth date");
  return {
    "phone-last-4": () => t("the last 4 digits of your phone number"),
    "card-last-4": () => t("the last 4 digits of your card number"),
    "card-code": () => t("your card's security code"),
    "card-number": () => t("your card number"),
    "card-expiry": () => t("your card's expiry date"),
    pin: () => t("your PIN"),
    "secret-answer": () => t("the answer to your secret question"),
    "member-id": () => t("your member or customer number"),
  }[detail]();
}

/** The popup's message for a **Fill** that filled nothing. */
export function detailFillFailure(
  reason: Extract<DetailFillResponse, { ok: false }>["reason"],
  t: TFunction,
): string {
  return {
    "document-gone": () => t("The page changed, so nothing was filled."),
    "not-a-candidate": () => t("This page no longer asks for it."),
    unreadable: () => t("That field does not hold a value Pateat can use here."),
    unavailable: () => t("Pateat cannot read that field now. Unlock the vault and try again."),
    "not-filled": () => t("The page did not accept the value."),
    "other-account": () => t("This page shows another account, so nothing was filled."),
  }[reason]();
}

/** What the popup may ask the background about a page's personal details (ADR 0061). */
export interface DetailClient {
  get(tabId: number): Promise<DetailResponse>;
  fill(request: DetailFillRequest): Promise<DetailFillResponse>;
  remove(tabId: number, detail: LoginDetail): Promise<DetailRemoveResponse>;
}

export function createDetailClient(send: (message: unknown) => Promise<unknown>): DetailClient {
  return {
    get: async (tab) =>
      v.parse(
        detailResponseSchema,
        await send({ version: 1, type: "login.detail.get", tabId: tab }),
      ),
    fill: async (request) =>
      v.parse(
        detailFillResponseSchema,
        await send({ version: 1, type: "login.detail.fill", ...request }),
      ),
    remove: async (tab, detail) =>
      v.parse(
        detailRemoveResponseSchema,
        await send({ version: 1, type: "login.detail.remove", tabId: tab, detail }),
      ),
  };
}
