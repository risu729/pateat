import * as v from "valibot";

const id = v.pipe(v.string(), v.minLength(1), v.maxLength(120));
const tabId = v.pipe(v.number(), v.integer(), v.minValue(0));

/**
 * Why a tab asks for an account after a logout (ADR 0021 D): it logged out of the site
 * (`this-tab`), the site did not accept its last login (`rejected`), another tab of the
 * site logged out (`other-tab`), or this tab's own login stopped after a submission or its
 * watch ended before it signed in (`stopped-login`).
 */
export const logoutReasonSchema = v.picklist([
  "this-tab",
  "rejected",
  "other-tab",
  "stopped-login",
]);
export type LogoutReason = v.InferOutput<typeof logoutReasonSchema>;
/** The toolbar popup's line saying why it asks for an account (ADR 0021). */
export function choiceReason(logout: LogoutReason | undefined, matches: number): string {
  if (logout === undefined) return `${matches} accounts match this page`;
  return {
    "this-tab": "You logged out of this site in this tab",
    rejected: "The site did not accept the last login in this tab",
    "other-tab": "You logged out of this site in another tab",
    "stopped-login": "The last login on this site stopped in this tab",
  }[logout];
}
/** The toolbar popup asks which accounts the refused login in a tab could use (ADR 0021). */
export const choiceRequestSchema = v.strictObject({
  version: v.literal(1),
  type: v.literal("login.choice.get"),
  tabId,
});
/** The popup's pick: restart that document's login with this account. */
export const pickRequestSchema = v.strictObject({
  version: v.literal(1),
  type: v.literal("login.choice.pick"),
  tabId,
  documentId: id,
  connectionId: id,
  itemId: id,
  /** Save it as the site default once the login is `authenticated`. */
  makeDefault: v.boolean(),
});
export const choiceResponseSchema = v.variant("ok", [
  v.strictObject({
    ok: v.literal(true),
    origin: v.string(),
    documentId: id,
    /** Several match, or (`logout`) any one after a logout, with the saved default first. */
    candidates: v.pipe(
      v.array(v.strictObject({ connectionId: id, itemId: id })),
      v.minLength(1),
      v.maxLength(100),
    ),
    /** The tab asks after a logout (ADR 0021 D), and why. */
    logout: v.optional(logoutReasonSchema),
    /** Another tab's login holds the site, so a pick cannot start yet (ADR 0022). */
    held: v.optional(v.literal(true)),
    /**
     * The site rejected another tab's login and that tab still asks, so the popup chooses
     * no account for this tab either (ADR 0021).
     */
    rejectedElsewhere: v.optional(v.literal(true)),
  }),
  v.strictObject({ ok: v.literal(false), reason: v.literal("no-choice") }),
]);
export const pickResponseSchema = v.variant("ok", [
  v.strictObject({ ok: v.literal(true) }),
  v.strictObject({
    ok: v.literal(false),
    reason: v.picklist([
      "no-choice",
      "not-a-candidate",
      "document-gone",
      "not-started",
      "origin-busy",
    ]),
  }),
]);
export type ChoiceResponse = v.InferOutput<typeof choiceResponseSchema>;
export type PickRequest = Omit<v.InferOutput<typeof pickRequestSchema>, "version" | "type">;
export type PickResponse = v.InferOutput<typeof pickResponseSchema>;

/** What the popup may ask the background about a refused login. */
export interface ChoiceClient {
  get(tabId: number): Promise<ChoiceResponse>;
  pick(request: PickRequest): Promise<PickResponse>;
}

export function createChoiceClient(send: (message: unknown) => Promise<unknown>): ChoiceClient {
  return {
    get: async (tab) =>
      v.parse(
        choiceResponseSchema,
        await send({ version: 1, type: "login.choice.get", tabId: tab }),
      ),
    pick: async (request) =>
      v.parse(
        pickResponseSchema,
        await send({ version: 1, type: "login.choice.pick", ...request }),
      ),
  };
}
