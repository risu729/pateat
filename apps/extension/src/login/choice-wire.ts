import type { TFunction } from "i18next";
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
/** The toolbar popup's line saying why it asks for an account (ADR 0021), in its language. */
export function choiceReason(
  logout: LogoutReason | undefined,
  matches: number,
  t: TFunction,
): string {
  if (logout === undefined) return t("matchingAccounts", { count: matches });
  return t(
    {
      "this-tab": "You logged out of this site in this tab",
      rejected: "The site did not accept the last login in this tab",
      "other-tab": "You logged out of this site in another tab",
      "stopped-login": "The last login on this site stopped in this tab",
    }[logout],
  );
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
  /** Save it as the site default once the login is confirmed `authenticated`. */
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
/**
 * The toolbar popup's message for a pick that started no login, in its language. A picked
 * account becomes the default only once its login succeeds (ADR 0021), so with
 * `makeDefault` it says that nothing was saved. Each case is one whole sentence to translate.
 */
export function pickFailure(
  reason: Extract<v.InferOutput<typeof pickResponseSchema>, { ok: false }>["reason"],
  name: string,
  makeDefault: boolean,
  t: TFunction,
): string {
  if (reason === "document-gone")
    return makeDefault
      ? t(
          "The page changed, so nothing was started. {{name}} was not made the default. Reload it to choose again.",
          { name },
        )
      : t("The page changed, so nothing was started. Reload it to choose again.");
  if (reason === "origin-busy")
    return makeDefault
      ? t(
          "Another tab's login to this site is running or did not succeed, so Pateat did not log in here. {{name}} was not made the default. Close that tab or wait up to 10 minutes, then choose again.",
          { name },
        )
      : t(
          "Another tab's login to this site is running or did not succeed, so Pateat did not log in here. Close that tab or wait up to 10 minutes, then choose again.",
        );
  if (reason === "not-started")
    return makeDefault
      ? t(
          "Pateat could not log in with {{name}} on this page. {{name}} was not made the default. Reload the page to choose again.",
          { name },
        )
      : t("Pateat could not log in with {{name}} on this page. Reload the page to choose again.", {
          name,
        });
  return makeDefault
    ? t("This page is no longer waiting for a choice. {{name}} was not made the default.", {
        name,
      })
    : t("This page is no longer waiting for a choice");
}
/** The toolbar popup asks what Pateat did on a tab's page (ADR 0038). */
export const statusRequestSchema = v.strictObject({
  version: v.literal(1),
  type: v.literal("login.status.get"),
  tabId,
});
/** A state, outcome or reason as the log names it. */
const code = v.pipe(v.string(), v.maxLength(200));
export const statusResponseSchema = v.variant("ok", [
  v.strictObject({
    ok: v.literal(true),
    /** The tab's top page origin. */
    origin: v.string(),
    /**
     * Whether the origin has a recipe: one that starts on the top page's path, as a sign-in
     * page, a list of accounts or a sign-in entry (`page`), only on other paths, or none.
     */
    recipe: v.picklist(["page", "other-paths", "none"]),
    /** A model request for the tab's page is in flight, while the badge spins. */
    asking: v.optional(v.literal(true)),
    /**
     * The top page as the worker last saw it: watching for a recipe's first step, sent for
     * generation, or refused with a reason; why its sign-in input did not start a login,
     * and why it was last not sent for generation.
     */
    page: v.optional(
      v.strictObject({
        state: v.optional(code),
        reason: v.optional(code),
        notStarted: v.optional(code),
        generationSkip: v.optional(code),
      }),
    ),
    /**
     * The tab's last login on this origin's page: `started`, then its state and outcome;
     * `settled` while it is `reconciling` with a result that settled as unknown, which is
     * watched from the next page on (ADR 0027); `fillOnly` for a login that only fills the
     * form after a logout and never presses anything (ADR 0021 D).
     */
    login: v.optional(
      v.strictObject({
        state: code,
        outcome: v.optional(code),
        cause: v.optional(code),
        unconfirmed: v.optional(v.literal(true)),
        fillOnly: v.optional(v.literal(true)),
        settled: v.optional(v.literal(true)),
      }),
    ),
    /**
     * A refusal on this origin's page that the badge shows as a failure, such as `no-route`
     * for a vault item with neither a password nor a passkey, until the next login starts.
     */
    refused: v.optional(v.strictObject({ reason: code, detail: v.optional(code) })),
    /** The tab's last page sent for generation on this origin's page, and what came back. */
    generation: v.optional(
      v.strictObject({
        outcome: code,
        reason: v.optional(code),
        page: v.optional(v.picklist(["accounts", "entry", "continuation"])),
      }),
    ),
  }),
  v.strictObject({ ok: v.literal(false), reason: v.literal("no-page") }),
]);
export type ChoiceResponse = v.InferOutput<typeof choiceResponseSchema>;
export type StatusResponse = v.InferOutput<typeof statusResponseSchema>;
export type PickRequest = Omit<v.InferOutput<typeof pickRequestSchema>, "version" | "type">;
export type PickResponse = v.InferOutput<typeof pickResponseSchema>;

/** What the popup may ask the background about a refused login and the tab's page. */
export interface ChoiceClient {
  get(tabId: number): Promise<ChoiceResponse>;
  pick(request: PickRequest): Promise<PickResponse>;
  /** What Pateat did on the tab's page, for the popup's page section (ADR 0038). */
  status(tabId: number): Promise<StatusResponse>;
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
    status: async (tab) =>
      v.parse(
        statusResponseSchema,
        await send({ version: 1, type: "login.status.get", tabId: tab }),
      ),
  };
}
