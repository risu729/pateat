import type { TFunction } from "i18next";
import * as v from "valibot";

/** The lengths the person chooses from when pausing (ADR 0062), in milliseconds. */
export const PAUSE_LENGTHS = { "10m": 10 * 60_000, "1h": 60 * 60_000 } as const;
export type PauseLength = keyof typeof PAUSE_LENGTHS;
export const pauseLengthSchema = v.picklist(Object.keys(PAUSE_LENGTHS) as [PauseLength]);

const id = v.pipe(v.string(), v.minLength(1), v.maxLength(120));
const tabId = v.pipe(v.number(), v.integer(), v.minValue(0));

/**
 * Why a tab asks for an account instead of logging in (ADR 0021 D, ADR 0062): the site did
 * not accept its last login (`rejected`) or another tab's that still asks
 * (`rejected-elsewhere`), or this tab's own login stopped after a submission or its watch
 * ended before it signed in (`stopped-login`); these three fill the page once with the one
 * account to use, pressing nothing. Or two automatic logins of the site ended signed in
 * within 10 minutes (`relogin-limit`), or an account was picked for the site in this
 * browser session without making it the default (`one-time-pick`, ADR 0063); these two
 * fill nothing.
 */
export const askReasonSchema = v.picklist([
  "rejected",
  "rejected-elsewhere",
  "stopped-login",
  "relogin-limit",
  "one-time-pick",
]);
export type AskReason = v.InferOutput<typeof askReasonSchema>;
/** The toolbar popup's line saying why it asks for an account (ADR 0021), in its language. */
export function choiceReason(
  ask: AskReason | undefined,
  matches: number,
  t: TFunction,
  paused = false,
): string {
  // A paused site asks with any matching account, also with one (ADR 0062).
  if (paused) return t("Automatic login is paused on this site");
  if (ask === undefined) return t("matchingAccounts", { count: matches });
  return t(
    {
      rejected: "The site did not accept the last login in this tab",
      "rejected-elsewhere": "The site did not accept the last login in another tab",
      "stopped-login": "The last login on this site stopped in this tab",
      "relogin-limit":
        "Pateat logged in to this site twice in the last 10 minutes, so it waits for you to choose",
      "one-time-pick":
        "You chose an account here without making it the default, so Pateat asks each time until an account is made the default",
    }[ask],
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
    /** Several match, or (`ask`) any one while the tab asks, with the saved default first. */
    candidates: v.pipe(
      v.array(v.strictObject({ connectionId: id, itemId: id })),
      v.minLength(1),
      v.maxLength(100),
    ),
    /** The tab asks for an account (ADR 0021 D, ADR 0062), and why. */
    ask: v.optional(askReasonSchema),
    /**
     * Automatic login of the page's site is paused (ADR 0062): any matching account, also
     * the saved default or the only match, is offered, and a pick logs in once.
     */
    paused: v.optional(v.literal(true)),
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
      // A paused site's pick of an item with no password, only a passkey (ADR 0062).
      "paused-no-password",
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
  if (reason === "paused-no-password")
    return makeDefault
      ? t(
          "Automatic login is paused on this site, and {{name}} has no password, so Pateat did not log in. {{name}} was not made the default. To sign in with its passkey, use the page's own passkey sign-in button and choose {{name}} in Pateat's window.",
          { name },
        )
      : t(
          "Automatic login is paused on this site, and {{name}} has no password, so Pateat did not log in. To sign in with its passkey, use the page's own passkey sign-in button and choose {{name}} in Pateat's window.",
          { name },
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
/**
 * The popup's account switch (ADR 0063): log the tab out of its site, then log in on the
 * site's next login page in that tab with this account.
 */
export const switchRequestSchema = v.strictObject({
  version: v.literal(1),
  type: v.literal("login.switch.start"),
  tabId,
  connectionId: id,
  itemId: id,
  /** Save it as the site default once the login is confirmed `authenticated`. */
  makeDefault: v.boolean(),
});
/**
 * Why a switch did not start: the tab shows no page Pateat watches (`no-page`), its page
 * waits for an account choice, a switch or a login runs in the tab, another tab's login or
 * switch holds the site (`site-held`), the settings could not be read, the account does not
 * match the page, or no paired service can tell how to log out (`unavailable`). A paused or
 * excluded site still switches: the switch is the person's pick.
 */
export const switchRefusalSchema = v.picklist([
  "no-page",
  "choice-waiting",
  "in-progress",
  "tab-busy",
  "site-held",
  "settings-unavailable",
  "not-a-candidate",
  "unavailable",
]);
export type SwitchRefusal = v.InferOutput<typeof switchRefusalSchema>;
export const switchResponseSchema = v.variant("ok", [
  v.strictObject({ ok: v.literal(true) }),
  v.strictObject({ ok: v.literal(false), reason: switchRefusalSchema }),
]);
export type SwitchRequest = Omit<v.InferOutput<typeof switchRequestSchema>, "version" | "type">;
export type SwitchResponse = v.InferOutput<typeof switchResponseSchema>;
/** The toolbar popup's message for a switch that did not start. */
export function switchRefusal(reason: SwitchRefusal, name: string, t: TFunction): string {
  if (reason === "not-a-candidate") return t("{{name}} does not match this page.", { name });
  return t(
    {
      "no-page": "Pateat is not running on this page yet. Reload it, then try again.",
      "choice-waiting": "This page waits for an account choice. Choose the account there.",
      "in-progress": "An account switch is already running in this tab.",
      "tab-busy": "A login is running in this tab. Wait for it to end, then try again.",
      "site-held":
        "Another tab's login or account switch on this site is running or waits for a code. Finish or close it, then try again.",
      "settings-unavailable": "Pateat settings could not be read. Try again.",
      unavailable: "Pateat needs its service to find how to log out. Pair it in the settings.",
    }[reason],
  );
}
/**
 * The popup's line for the tab's account switch: logging out, signed out and waiting for
 * the site's login page, or why it stopped.
 */
export function switchStatus(
  state: "running" | "signed-out" | "failed",
  reason: string | undefined,
  name: string,
  t: TFunction,
): string {
  if (state === "running") return t("Logging out to switch to {{name}}…", { name });
  if (state === "signed-out")
    return t("Logged out. Pateat logs in with {{name}} on this site's login page in this tab", {
      name,
    });
  if (reason === "no-logout-control")
    return t(
      "Pateat found no way to log out on this page, so it did not switch to {{name}}. Log out yourself, then choose the account",
      { name },
    );
  if (reason === "unsafe-control")
    return t(
      "The only control Pateat found to log out may also log out other devices or close the account, so it did not switch to {{name}}. Log out yourself, then choose the account",
      { name },
    );
  if (reason === "interrupted")
    return t(
      "Pateat stopped while logging out, so it did not switch to {{name}}. Check whether you are logged out, then choose the account",
      { name },
    );
  if (reason === "still-signed-in")
    return t(
      "The site still shows you logged in after 3 tries, so Pateat did not switch to {{name}}. Log out yourself, then choose the account",
      { name },
    );
  return t(
    "Pateat could not log out to switch to {{name}}. Log out yourself, then choose the account",
    { name },
  );
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
     * form while the tab asks for an account and never presses anything (ADR 0021 D).
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
    /**
     * The account of the tab's last login on this site that signed in, which the popup
     * marks as used in this tab (ADR 0063).
     */
    used: v.optional(v.strictObject({ connectionId: id, itemId: id })),
    /** The tab's account switch (ADR 0063): logging out, signed out, or why it stopped. */
    switch: v.optional(
      v.strictObject({
        state: v.picklist(["running", "signed-out", "failed"]),
        reason: v.optional(code),
        connectionId: id,
        itemId: id,
      }),
    ),
    /** Automatic login of the tab's site is paused until then, in epoch ms (ADR 0062). */
    pause: v.optional(v.strictObject({ until: v.pipe(v.number(), v.integer(), v.minValue(0)) })),
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
/**
 * The popup pauses automatic login of the tab's site for the length the person chose, or
 * resumes it (ADR 0062); the pause covers the registrable site in every tab of the tab's
 * window kind.
 */
export const pauseRequestSchema = v.variant("paused", [
  v.strictObject({
    version: v.literal(1),
    type: v.literal("login.pause.set"),
    tabId,
    paused: v.literal(true),
    length: pauseLengthSchema,
  }),
  v.strictObject({
    version: v.literal(1),
    type: v.literal("login.pause.set"),
    tabId,
    paused: v.literal(false),
  }),
]);
/** What the popup asks for: a pause of a chosen length, or its end. */
export type PauseChange = { paused: true; length: PauseLength } | { paused: false };
export const pauseResponseSchema = v.variant("ok", [
  v.strictObject({
    ok: v.literal(true),
    /** While paused: when the pause ends, in epoch milliseconds. */
    until: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0))),
  }),
  v.strictObject({ ok: v.literal(false), reason: v.picklist(["no-site", "storage-unavailable"]) }),
]);
export type ChoiceResponse = v.InferOutput<typeof choiceResponseSchema>;
export type PauseResponse = v.InferOutput<typeof pauseResponseSchema>;
export type StatusResponse = v.InferOutput<typeof statusResponseSchema>;
export type PickRequest = Omit<v.InferOutput<typeof pickRequestSchema>, "version" | "type">;
export type PickResponse = v.InferOutput<typeof pickResponseSchema>;

/** What the popup may ask the background about a refused login and the tab's page. */
export interface ChoiceClient {
  get(tabId: number): Promise<ChoiceResponse>;
  pick(request: PickRequest): Promise<PickResponse>;
  /** What Pateat did on the tab's page, for the popup's page section (ADR 0038). */
  status(tabId: number): Promise<StatusResponse>;
  /** Logs the tab out of its site and in again with another account (ADR 0063). */
  switchTo(request: SwitchRequest): Promise<SwitchResponse>;
  /** Pauses automatic login of the tab's site, or resumes it (ADR 0062). */
  pause(tabId: number, change: PauseChange): Promise<PauseResponse>;
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
    switchTo: async (request) =>
      v.parse(
        switchResponseSchema,
        await send({ version: 1, type: "login.switch.start", ...request }),
      ),
    pause: async (tab, change) =>
      v.parse(
        pauseResponseSchema,
        await send({ version: 1, type: "login.pause.set", tabId: tab, ...change }),
      ),
  };
}
