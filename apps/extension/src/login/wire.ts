import * as v from "valibot";
import {
  listClickSchema,
  loginFieldTargetSchema,
  loginOperationSchema,
  loginMarkerTargetSchema,
  loginTargetSchema,
  type LoginStep,
  type LoginTarget,
} from "@pateat/contracts";
import { entryMisses, type ListMiss, otherMisses } from "../page/account-list";
import { alertMisses } from "../page/sign-in-state";

const id = v.pipe(v.string(), v.minLength(1), v.maxLength(120));
/** Which inputs a secret value may fill; see `acceptsSecret` in `inputs.ts`. */
export const loginSecretKinds = [
  "password",
  "otp",
  "hidden",
  "card-code",
  "detail",
  "answer",
] as const;
/**
 * What a secret question's answer is filled under (ADR 0061): its custom field's `name`,
 * which the page's text beside the input must contain, or, for a field named otherwise,
 * the `question` the owner confirmed, which must be one whole question shown there.
 */
const questionSchema = v.union([
  v.strictObject({ name: v.pipe(v.string(), v.minLength(1), v.maxLength(200)) }),
  v.strictObject({ question: v.pipe(v.string(), v.minLength(1), v.maxLength(200)) }),
]);
export type AskedQuestion = v.InferOutput<typeof questionSchema>;
export type LoginSecretKind = (typeof loginSecretKinds)[number];
const path = v.pipe(v.string(), v.minLength(1), v.maxLength(300));
/** One target's state: no element, exactly one usable element, several, or one unusable. */
export const targetStateSchema = v.picklist(["missing", "unique", "ambiguous", "unusable"]);
export type TargetState = v.InferOutput<typeof targetStateSchema>;
/**
 * What a target's one element must be to count as `unique`: a shown writable input, a
 * shown enabled button, any shown element, an input of a kind Pateat fills (`input`, shown
 * or not) or such an input shown (`shown-input`), so another page's element with the same
 * locator is never taken for a sign-in field; `present` takes any element. With
 * `described-writable` and `described-clickable`, the writable input or the clickable button
 * must also be visible as the page's description reads it: not hidden from assistive
 * technology, transparent unless it fades in, tiny or moved before the page's start
 * (ADR 0018), as an advance's next step on its own path is measured (ADR 0013).
 * `password-choice` takes a shown button that names the password as the way to confirm the
 * sign-in, enabled or not: by its rendered text (`namesPasswordChoice`, ADR 0048), or with
 * an accessible name by that name and all the text it holds, hidden text too
 * (`namesPasswordControl`, its 2026-10-19 amendment).
 */
export const targetRequirementSchema = v.picklist([
  "writable",
  "clickable",
  "described-writable",
  "described-clickable",
  "shown",
  "present",
  "input",
  "shown-input",
  "password-choice",
]);
export type TargetRequirement = v.InferOutput<typeof targetRequirementSchema>;
/**
 * The check that decided a target's state, for the log only (ADR 0019): `ok` for `unique`,
 * `missing`, `matches-2` to `matches-9` for several elements (9 or more), or why the one
 * element failed `require`: for an input or button requirement, not seen by the content
 * script's visibility check, under a `hidden` attribute (`hidden-attr`) or not rendered
 * otherwise (`not-rendered`), or seen but disabled, read-only or no such control
 * (`not-writable`, `not-clickable`); or, with `described-writable` or
 * `described-clickable`, the first reason the page's description would not see it
 * (`presenceMiss`: `hidden-attr`, `not-rendered`, `off-start`, `transparent`, `tiny`);
 * `unusable` for another requirement.
 */
export const targetCheckSchema = v.picklist([
  "ok",
  "missing",
  "matches-2",
  "matches-3",
  "matches-4",
  "matches-5",
  "matches-6",
  "matches-7",
  "matches-8",
  "matches-9",
  "not-writable",
  "not-clickable",
  "hidden-attr",
  "not-rendered",
  "off-start",
  "transparent",
  "tiny",
  "unusable",
]);
export type TargetCheck = v.InferOutput<typeof targetCheckSchema>;
/**
 * What confirms an advance whose next step is on its own path (ADR 0013): that step's
 * elements, each measured with `require` just before the advance and after it.
 */
export const inPlaceNextSchema = v.strictObject({
  require: targetRequirementSchema,
  targets: v.pipe(v.array(loginTargetSchema), v.maxLength(20)),
});
export type InPlaceNext = v.InferOutput<typeof inPlaceNextSchema>;
/**
 * Elements a step needs before it can run: each target matches exactly one element that
 * is a writable input (`fill`), an enabled visible button (`click`) or simply present.
 * No targets means the path alone is enough.
 */
export const loginReadinessSchema = v.strictObject({
  path,
  require: v.picklist(["writable", "clickable", "present"]),
  targets: v.pipe(v.array(loginTargetSchema), v.maxLength(20)),
  /**
   * A chooser recipe's start (ADR 0028): ready on its path, without a sign-in input, once
   * one of `targets` shows or the page lists an account by its email, masked or not.
   */
  accounts: v.optional(v.literal(true)),
  /**
   * A later `fill` step a new login may start at (ADR 0049): ready only while the page
   * shows no other identifier input, as an email form beside its password input would.
   */
  later: v.optional(v.literal(true)),
});
export type LoginReadiness = v.InferOutput<typeof loginReadinessSchema>;
/** What a step waits for; a `wait` or `assert`-absent step does its own waiting. */
export function loginReadiness(step: LoginStep): LoginReadiness {
  const targets: LoginTarget[] =
    step.kind === "fill"
      ? step.fields.map((field) => field.target)
      : step.kind === "click" || (step.kind === "assert" && step.present)
        ? [step.target]
        : [];
  return {
    path: step.path,
    // Enter goes into a field (ADR 0064).
    require:
      step.kind === "fill" || (step.kind === "click" && step.press === "enter")
        ? "writable"
        : step.kind === "click"
          ? "clickable"
          : "present",
    targets,
  };
}
/**
 * How many times a document announces a ready first step before it waits until the form
 * goes, each try about half a second after a refusal that may pass, such as a stale
 * announcement. The worker counts them to log the page giving up (ADR 0019).
 */
export const START_TRIES = 4;
/**
 * How long apart a document's tries of one start may be to count together. The worker
 * cannot see the form go and come back between tries, so the count is an estimate: a
 * short window keeps a form that flickers from counting as one that gave up.
 */
export const START_TRY_WINDOW_MS = 2000;
/** How long a started attempt waits for a fill or click step's elements (owner-approved). */
export const LOGIN_STEP_WAIT_MS = 10000;
/**
 * How long a page is left unjudged while a held click's button still shows (ADR 0027): a
 * handler's, such as "Use security key", or the `passkey` route's, such as "Sign in with a
 * passkey", during a WebAuthn exchange; the passkey chooser's limit.
 */
export const HELD_CLICK_WAIT_MS = 120_000;
/**
 * Why a page offered for generation sent nothing by the end of the step wait: it showed no
 * list of accounts, sign-in entry or identifier input when its offer wait ended (ADR 0057)
 * and no sign-in input since (`no-list`), it is the page right after a submitted password
 * form (`after-sign-in`), a sign-in input showed only at the end of the wait
 * (`sign-in-shown`), or it shows a `type="text"` input named as a secret answer, which
 * looks like a verification but is never sent (`text-answer`, ADR 0035). `frame`: a frame,
 * which is never sent, showed a sign-in input or such an answer within the step wait after
 * the worker asked it to report one (ADR 0035).
 */
export const unofferedReasons = [
  "no-list",
  "after-sign-in",
  "sign-in-shown",
  "text-answer",
  "frame",
] as const;
export const helloSchema = v.strictObject({
  version: v.literal(1),
  type: v.literal("login.document.ready"),
  token: id,
  /** The first step's elements are ready on this path; a new attempt may start. */
  start: v.optional(v.strictObject({ path })),
  /**
   * A visible password, username or one-time-code input shows on this path, so a page
   * without a recipe may be sent for generation (ADR 0016); `identifier` when the page,
   * after the offer wait (ADR 0057), asks for an account identifier alone instead, or
   * `passkey` when it shows a button that signs in with a passkey and no identifier input
   * (ADR 0053). A passkey page also carries the `list` and `entry` it would otherwise be
   * announced with, used when no matching item holds a discoverable passkey.
   */
  signIn: v.optional(
    v.pipe(
      v.strictObject({
        path,
        identifier: v.optional(v.literal(true)),
        passkey: v.optional(v.literal(true)),
      }),
      v.check(
        (signIn) => !(signIn.identifier && signIn.passkey),
        "A page asks for an identifier or shows a passkey button, not both",
      ),
    ),
  ),
  /**
   * Such an input shows on this path but no first step is ready; sent once per path, only
   * for the log of a login that did not start. On a page the worker named a verification
   * Pateat does not fill (`confirm` in its answer), it is sent as soon as that page's first
   * step shows, with `amount`: whether an amount (`¥`, `円` or `$` with digits) shows in the
   * form of that step's elements, never the amount, and absent when they are in no form
   * (ADR 0035).
   */
  shown: v.optional(v.strictObject({ path, amount: v.optional(v.boolean()) })),
  /**
   * After the offer wait (ADR 0057), this path shows no sign-in input but lists accounts (ADR
   * 0028): an entry or a text beside at most three buttons with an email, masked or not.
   * Without one, `names` are the short texts that may name an account by a username that
   * is not an email, for the background to compare with the matching items' usernames.
   * `other` says that the page also shows a control to sign in with another account, so
   * the list is sent even when no text names an item, or, for a list by email, when no
   * matching item's username is an email. Without one, `otherMiss` says why words for another
   * account showed but no such control counts, and `missed` why a text with an email
   * address is not an entry, both for the log only.
   */
  list: v.optional(
    v.strictObject({
      path,
      names: v.optional(
        v.pipe(v.array(v.pipe(v.string(), v.minLength(1), v.maxLength(64))), v.maxLength(32)),
      ),
      other: v.optional(v.literal(true)),
      otherMiss: v.optional(v.picklist(otherMisses)),
      missed: v.optional(v.picklist(entryMisses)),
    }),
  ),
  /**
   * No sign-in input and no ready first step showed on this path within the offer wait
   * (ADR 0057), so the page may be sent as a site's sign-in entry (ADR 0031).
   */
  entry: v.optional(v.strictObject({ path })),
  /**
   * The page was offered for generation, but nothing was sent by the end of the step wait:
   * why, for the log only (ADR 0019).
   */
  unoffered: v.optional(v.strictObject({ path, why: v.picklist(unofferedReasons) })),
});
/**
 * A form with a password input was submitted in this document by anyone, Pateat or the
 * person: the tab's next page of the origin is never sent as a list of accounts (ADR 0028)
 * or as a sign-in entry (ADR 0031).
 */
export const submittedSchema = v.strictObject({
  version: v.literal(1),
  type: v.literal("login.document.submitted"),
  token: id,
});
/**
 * The person submitted the form of a page the worker named a verification Pateat does not
 * fill (ADR 0035): a trusted `submit` event of the form that holds the page's first step,
 * reported before the page leaves. No button text or value is sent.
 */
export const personSubmittedSchema = v.strictObject({
  version: v.literal(1),
  type: v.literal("login.document.person-submitted"),
  token: id,
});
/**
 * A control that logs out was clicked in this document by the person (ADR 0021 D, owner
 * 2026-10-16): nothing about the control or the page is sent.
 */
export const logoutClickedSchema = v.strictObject({
  version: v.literal(1),
  type: v.literal("login.document.logout-clicked"),
  token: id,
});
/**
 * The answer to a hello. `starts` lists the first steps of the origin's recipes; the
 * document announces again with `start` once one of them is ready on the current path. A
 * refused hello carries them, and so does an accepted one of a watched login (ADR 0027).
 */
export const readySchema = v.strictObject({
  ok: v.boolean(),
  reason: v.optional(v.string()),
  starts: v.optional(v.pipe(v.array(loginReadinessSchema), v.maxLength(32))),
  /** The page may be sent for generation; announce again with `signIn` once it applies. */
  generate: v.optional(v.literal(true)),
  /**
   * With `generate`: the page's URL names another path of its site, so it may be sent as a
   * sign-in entry; announce again with `entry` when no sign-in input showed (ADR 0031).
   */
  entry: v.optional(v.literal(true)),
  /**
   * A recipe generated as `confirm` or `unclear` starts on this path, so Pateat only watches
   * (ADR 0035): its first step, whose showing the document reports with `shown`, and whose
   * form's trusted submission it reports with `login.document.person-submitted`.
   */
  confirm: v.optional(loginReadinessSchema),
  /**
   * The document is a frame, which is never sent for generation: it announces once with
   * `unoffered` `frame` if a sign-in input or a secret answer shows within the step wait,
   * so such pages are counted (ADR 0035).
   */
  frame: v.optional(v.literal(true)),
});
export const reconnectSchema = v.strictObject({
  version: v.literal(1),
  type: v.literal("login.reconnect"),
});
export const authorizeSchema = v.strictObject({
  version: v.literal(1),
  type: v.literal("login.operation.authorize"),
  token: id,
  attemptId: id,
  operationId: id,
});
/**
 * Asks whether a step's form may submit to `destination`, an HTTP(S) URL off the document's
 * origin (ADR 0051). The background answers with {@link destinationAnswerSchema}.
 */
export const destinationCheckSchema = v.strictObject({
  version: v.literal(1),
  type: v.literal("login.destination.check"),
  token: id,
  attemptId: id,
  operationId: id,
  destination: v.pipe(v.string(), v.maxLength(8192)),
});
/**
 * The background's answer to a destination check: allowed only on the document's site,
 * through HTTPS unless the document is HTTP, at a site Pateat may act on, and matched by
 * the login's vault item; `unchecked` when that could not be decided now (ADR 0051).
 */
export const destinationAnswerSchema = v.variant("ok", [
  v.strictObject({ ok: v.literal(true) }),
  v.strictObject({
    ok: v.literal(false),
    reason: v.picklist([
      "not-authorized",
      "insecure",
      "cross-site",
      "no-site-access",
      "item-mismatch",
      "unchecked",
    ]),
  }),
]);
export type DestinationAnswer = v.InferOutput<typeof destinationAnswerSchema>;
/**
 * What a chooser's login needs to choose on its list (ADR 0028): the chosen item's
 * username, the other matching items' usernames and the chooser's buttons. The usernames
 * never leave the content script.
 */
const listInputSchema = v.strictObject({
  username: v.pipe(v.string(), v.maxLength(4096)),
  others: v.pipe(v.array(v.pipe(v.string(), v.maxLength(4096))), v.maxLength(32)),
  /** Whether `others` holds every other matching item's username; else no masked text fits. */
  othersComplete: v.boolean(),
  other: v.optional(loginTargetSchema),
  continue: v.optional(loginTargetSchema),
});
const listCount = v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(5000));
const buttonFound = v.picklist(["none", "missing", "one", "many"]);
/** What a list showed when nothing on it fits (`ListMiss`), for the log only. */
export const listMissSchema = v.strictObject({
  username: v.picklist(["email", "name", "empty"]),
  entries: listCount,
  masked: v.optional(listCount),
  sameDomain: v.optional(listCount),
  fits: v.optional(listCount),
  entryMiss: v.optional(v.picklist(entryMisses)),
  beside: listCount,
  named: v.optional(listCount),
  other: buttonFound,
  continue: buttonFound,
});
export type ListMissReport = v.InferOutput<typeof listMissSchema>;
// The page's summary and the schema name the same fields, so a field added to only one
// fails here rather than turning every list without a fit into a refused answer.
const listMissFields: [
  Exclude<keyof ListMiss, keyof ListMissReport>,
  Exclude<keyof ListMissReport, keyof ListMiss>,
] extends [never, never]
  ? (miss: ListMiss) => ListMissReport
  : never = (miss) => miss;
void listMissFields;
/**
 * What the list showed a chooser's login would click; `none` when nothing fits, with what
 * the list showed (`miss`).
 */
export const chooseResultSchema = v.variant("ok", [
  v.pipe(
    v.strictObject({
      ok: v.literal(true),
      click: v.picklist([...listClickSchema.options, "none"]),
      miss: v.optional(listMissSchema),
    }),
    v.check((result) => (result.click === "none") === (result.miss !== undefined)),
  ),
  v.strictObject({ ok: v.literal(false) }),
]);
/** Hosts the content script asks the worker about at most (ADR 0031). */
const hostList = v.pipe(v.array(v.pipe(v.string(), v.maxLength(253))), v.maxLength(256));
const href = v.pipe(v.string(), v.maxLength(8192));
export const commandSchema = v.variant("type", [
  v.strictObject({
    version: v.literal(1),
    type: v.literal("login.observe"),
    token: id,
    path: v.string(),
    // A signed-in marker may name a link by its path (ADR 0029).
    targets: v.pipe(v.array(loginMarkerTargetSchema), v.maxLength(24)),
    /**
     * Per target, what its one element must be to count as `unique`
     * (`targetRequirementSchema`); otherwise it is `unusable`. Without it, any one element
     * counts, hidden or not.
     */
    require: v.optional(v.pipe(v.array(targetRequirementSchema), v.maxLength(24))),
    /**
     * Per target, whether a text locator may also name a link by its text, as for an
     * account switch: set for a completion marker, which may be a link (ADR 0018).
     */
    links: v.optional(v.pipe(v.array(v.boolean()), v.maxLength(24))),
    /**
     * Per target, whether hidden elements count when an attribute or `autocomplete` locator
     * names several (`findTargets`): set for a signed-in marker and the elements it needs
     * missing (ADR 0029), which keep counting every copy (ADR 0037 amendment of
     * 2026-10-22).
     */
    hidden: v.optional(v.pipe(v.array(v.boolean()), v.maxLength(24))),
    /**
     * Also answer `signIn`: whether the page has loaded and which sign-in inputs other than
     * `targets` it shows, to continue a recipe on (ADR 0018).
     */
    signIn: v.optional(v.literal(true)),
    /** Also answer `checks`, why each target has its state, for the log (ADR 0019). */
    explain: v.optional(v.literal(true)),
  }),
  v.strictObject({
    version: v.literal(1),
    type: v.literal("login.execute"),
    token: id,
    operation: loginOperationSchema,
    values: v.pipe(
      v.array(
        v.strictObject({
          slot: id,
          value: v.pipe(v.string(), v.maxLength(4096)),
          /** Secret values fill only matching inputs; other values fill any writable input. */
          secret: v.optional(v.picklist(loginSecretKinds)),
          /**
           * A secret question's answer goes in only while the input still asks this
           * field's question (ADR 0061), checked just before it is typed.
           */
          question: v.optional(questionSchema),
        }),
      ),
      v.maxLength(20),
    ),
    /**
     * The selected account's username, sent only with a fill of a secret but no username.
     * The page must not show another account; it never leaves the content script.
     */
    account: v.optional(v.strictObject({ username: v.pipe(v.string(), v.maxLength(4096)) })),
    /** The recipe's account switch, clicked when the page shows another account. */
    accountSwitch: v.optional(loginTargetSchema),
    /**
     * With a chooser's click on its list (ADR 0028): the click goes to the element the
     * list's choice names, and only when that choice is `click`.
     */
    list: v.optional(v.strictObject({ ...listInputSchema.entries, click: listClickSchema })),
    /**
     * With a `totp` handler's code fill (ADR 0027): the button that submits the code. The
     * fill then watches for the page submitting the code by itself before it answers.
     * Without `submit`, with the fill of a `totp` handler without a button (`effect:
     * "submit"`, ADR 0027 amendment of 2026-10-23): the code is typed as a person types it,
     * one digit per input for a split code, and its last character is the submission.
     */
    code: v.optional(v.strictObject({ submit: v.optional(loginTargetSchema) })),
    /**
     * With a `detail` handler's fill (ADR 0061): the input's choosing radio button is
     * checked first, in the same task as the fill (`chooseFor`).
     */
    choose: v.optional(v.literal(true)),
    /**
     * With a `password` handler's click (ADR 0048): the button is pressed only while it,
     * read in the same task as the press, names the password as the way to confirm the
     * sign-in as `password-choice` takes it (`namesPasswordChoice`, or with an accessible
     * name `namesPasswordControl`); otherwise nothing is pressed and the step fails as one
     * whose target is missing. A click whose target is named by its accessible name is
     * pressed only with it.
     */
    passwordChoice: v.optional(v.literal(true)),
    /**
     * With an advance whose next step is on its own path (ADR 0013): that step's elements,
     * measured in the same task as the click or the fill's first input, just before it. The
     * answer reports them as `before`.
     */
    next: v.optional(inPlaceNextSchema),
  }),
  v.strictObject({
    version: v.literal(1),
    type: v.literal("login.await"),
    token: id,
    readiness: loginReadinessSchema,
    timeoutMs: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(LOGIN_STEP_WAIT_MS)),
  }),
  v.strictObject({ version: v.literal(1), type: v.literal("login.cancel"), token: id }),
  /**
   * The popup's **Fill** of a personal detail (ADR 0061): types `value` into the one
   * writable input `target` names on `path`, after checking its choosing radio button, and
   * presses nothing. Outside any login: no operation, no submission.
   */
  v.strictObject({
    version: v.literal(1),
    type: v.literal("login.detail.fill"),
    token: id,
    path,
    target: loginFieldTargetSchema,
    value: v.pipe(v.string(), v.minLength(1), v.maxLength(128)),
    secret: v.optional(v.picklist(loginSecretKinds)),
    question: v.optional(questionSchema),
  }),
  /**
   * Which of the login item's answer fields, each by its name or by the question the owner
   * confirmed for it, is the secret question shown beside `target` (ADR 0061); page text
   * never leaves the document.
   */
  v.strictObject({
    version: v.literal(1),
    type: v.literal("login.detail.question"),
    token: id,
    path,
    target: loginFieldTargetSchema,
    names: v.pipe(v.array(questionSchema), v.maxLength(100)),
  }),
  /**
   * Asks what a chooser's login would click on the list this document shows (ADR 0028),
   * without clicking anything.
   */
  v.strictObject({
    version: v.literal(1),
    type: v.literal("login.choose"),
    token: id,
    path,
    list: listInputSchema,
  }),
  /**
   * Clicks the account switch a `wrong-account` result of `operationId` reported as
   * `switchable`, once the attempt has recorded the switch.
   */
  v.strictObject({
    version: v.literal(1),
    type: v.literal("login.switch"),
    token: id,
    operationId: id,
  }),
  /**
   * Describes the page without values: a login page to generate a recipe from, or the
   * page after a generated recipe's final submission (ADR 0018).
   */
  v.strictObject({
    version: v.literal(1),
    type: v.literal("login.extract"),
    token: id,
    page: v.picklist(["login", "signed-in", "accounts", "entry", "passkey"]),
    /**
     * For a list of accounts (ADR 0028): the shown texts that equal a matching item's
     * username that is not an email, hidden from the observation as `[account]`.
     */
    names: v.optional(
      v.pipe(v.array(v.pipe(v.string(), v.minLength(1), v.maxLength(64))), v.maxLength(32)),
    ),
    /**
     * For a login page that continues a recipe (ADR 0018): the fields the recipe already
     * fills on this path. One of them shown read-only or disabled, as an email address shown
     * again beside the password, is left out rather than making the page incomplete.
     */
    known: v.optional(v.pipe(v.array(loginFieldTargetSchema), v.maxLength(24))),
    /**
     * For a page without a login form (`entry`, ADR 0031): the hosts the worker found on
     * the page's site among those `login.entry.hosts` listed. A link elsewhere is left out.
     */
    onSite: v.optional(hostList),
  }),
  /** Lists the hosts the page's URL and its links name (ADR 0031). */
  v.strictObject({ version: v.literal(1), type: v.literal("login.entry.hosts"), token: id }),
  /**
   * Waits up to `timeoutMs` for an entry recipe's target to name exactly one element and
   * describes it, for the worker's checks before the press (ADR 0031). Never clicks.
   */
  v.strictObject({
    version: v.literal(1),
    type: v.literal("login.entry.inspect"),
    token: id,
    target: loginTargetSchema,
    timeoutMs: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(LOGIN_STEP_WAIT_MS)),
  }),
  /**
   * Presses the entry link the worker checked, only while the page's URL is still `url`,
   * the target still names exactly that one link and its `href` is still `href` (ADR 0031).
   */
  v.strictObject({
    version: v.literal(1),
    type: v.literal("login.entry.press"),
    token: id,
    target: loginTargetSchema,
    href,
    url: href,
  }),
  /**
   * Waits up to `timeoutMs` on the page after an entry press for a sign-in input or one of
   * `starts` ready, then reports those and whether a sign-up form shows (ADR 0031).
   */
  v.strictObject({
    version: v.literal(1),
    type: v.literal("login.entry.check"),
    token: id,
    starts: v.pipe(v.array(loginReadinessSchema), v.maxLength(32)),
    timeoutMs: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(LOGIN_STEP_WAIT_MS)),
  }),
  /**
   * Reads the page signs of ADR 0029 after an effect step that no check explained. The
   * username, when given, is compared with the header and navigation and never leaves the
   * content script. `fields`, the route's sign-in elements, is given for the first new
   * top document after a password submission that shows the sign-in form again: F1 and F2
   * are then read on those of them that are shown writable inputs, and on the alerts next
   * to them, without an earlier reading to compare with.
   */
  v.strictObject({
    version: v.literal(1),
    type: v.literal("login.state"),
    token: id,
    account: v.optional(v.strictObject({ username: v.pipe(v.string(), v.maxLength(4096)) })),
    fields: v.optional(v.pipe(v.array(loginTargetSchema), v.maxLength(24))),
  }),
  v.strictObject({
    version: v.literal(1),
    type: v.literal("login.status"),
    token: id,
    state: v.string(),
    stepIndex: v.number(),
    outcome: v.optional(v.string()),
  }),
]);
export type ExecutionDetail = NonNullable<v.InferOutput<typeof executionResultSchema>["detail"]>;
export const executionResultSchema = v.strictObject({
  ok: v.boolean(),
  operationId: id,
  documentId: id,
  mutation: v.picklist(["none", "possible"]),
  /**
   * `value-mismatch`: a value does not fit its input, and nothing was filled.
   * `fill-rejected`: after a preparing fill the page marked a filled input invalid or
   * showed a new alert (ADR 0010), or while typing it kept a character out so the input
   * does not hold the value.
   * `submitted`: after a `totp` handler's code fill the page showed that it submits the
   * code by itself (ADR 0027); nothing was clicked.
   * `captcha`: the page showed a CAPTCHA before a click, so the click was left to the
   * person (ADR 0029, S4); nothing was clicked.
   */
  reason: v.optional(
    v.picklist([
      "structural-mismatch",
      "timeout",
      "cancelled",
      "wrong-account",
      "value-mismatch",
      "fill-rejected",
      "submitted",
      "captcha",
    ]),
  ),
  /**
   * Why a step was `cancelled` or failed, for the local log only (ADR 0019): the worker did
   * not authorize it, this document was cancelled, the operation was used or expired, the
   * page moved to another path, a field changed under the fill, the step threw; or, for a
   * failure, the form was replaced, the target is missing or not writable (or, for a
   * `password` handler's click, its text no longer names the password, ADR 0048), the form
   * changed before a click, an `assert` did not hold, the step was sent values it does not
   * fill, two of its fields name the same input, its fields are in different forms, an
   * input refused its secret, the page's inputs have no value setter, a code field's
   * submission watch could not start, the form or the clicked button would send the form
   * off the document's origin to a destination the background did not allow, or the
   * background could not decide that now (ADR 0051).
   */
  detail: v.optional(
    v.picklist([
      "not-authorized",
      "document-cancelled",
      "operation-used",
      "operation-expired",
      "page-changed",
      "field-changed",
      "threw",
      "form-replaced",
      "target-missing",
      "form-changed",
      "assert-failed",
      "unexpected-values",
      "fields-shared",
      "fields-split",
      "secret-refused",
      "unsupported-input",
      "code-watch-failed",
      "form-off-origin",
      "form-destination-unchecked",
    ]),
  ),
  /**
   * With `wrong-account`: the command's account switch is on the page and can be clicked
   * with `login.switch`. Nothing was filled or clicked.
   */
  switchable: v.optional(v.literal(true)),
  /**
   * With the command's `next`: each of its targets just before the click or the fill's
   * first input, in the same task.
   */
  before: v.optional(v.pipe(v.array(targetStateSchema), v.maxLength(20))),
});
export const awaitResultSchema = v.strictObject({
  ok: v.boolean(),
  reason: v.optional(v.picklist(["timeout", "cancelled"])),
});
/** Why an observation is incomplete; see `ObservationGap`. Value-free codes only. */
export const observationGaps = [
  "shadow-field",
  "shadow-control",
  "unfillable-field",
  "unsupported-control",
  "unlocated-field",
  "unlocated-checkbox",
  "unlocated-button",
  "too-many-fields",
  "too-many-candidates",
  "too-many-accounts",
  "unlisted-accounts",
  "too-many-elements",
  "too-many-controls",
] as const;
/** The page description; validated again against `loginObservationSchema` by the caller. */
export const extractResultSchema = v.variant("ok", [
  v.strictObject({
    ok: v.literal(true),
    observation: v.unknown(),
    /** Why the observation is incomplete; for diagnostics only. */
    gap: v.optional(v.picklist(observationGaps)),
    /**
     * A signed-in page's description left out a disabled field that may not be a sign-in
     * field: only `signed-in` completes the page (ADR 0029).
     */
    disabledLeftOut: v.optional(v.literal(true)),
  }),
  v.strictObject({
    ok: v.literal(false),
    reason: v.string(),
    /** For `no-candidates`, why no field was described, as codes only; for the log. */
    detail: v.optional(v.pipe(v.string(), v.maxLength(64))),
  }),
]);
/** The answer to `login.entry.hosts`. */
export const entryHostsResultSchema = v.strictObject({ ok: v.literal(true), hosts: hostList });
/**
 * The answer to `login.entry.inspect`: how many elements the target names, and for exactly
 * one, why it may not be pressed apart from where it leads (`refusal`), its `href` and the
 * page's URL, each as the browser resolved it (ADR 0031).
 */
export const entryInspectResultSchema = v.strictObject({
  ok: v.literal(true),
  state: v.picklist(["missing", "unique", "ambiguous"]),
  refusal: v.optional(
    v.picklist(["not-link", "script-link", "hidden", "no-text", "new-window", "download"]),
  ),
  href: v.optional(href),
  url: href,
});
/** The answer to `login.entry.press`: whether the link was clicked, and why not. */
export const entryPressResultSchema = v.strictObject({
  ok: v.boolean(),
  reason: v.optional(v.picklist(["page-changed", "target-changed", "cancelled"])),
});
/**
 * The answer to `login.entry.check`, for the page after an entry press (ADR 0031). `signIn`
 * also holds for an input that asks for an account identifier alone (ADR 0016).
 */
export const entryCheckResultSchema = v.strictObject({
  ok: v.literal(true),
  signIn: v.boolean(),
  start: v.boolean(),
  signUp: v.boolean(),
});
/** The answer to `login.state`: the page signs as flags only (ADR 0029). */
export const stateResultSchema = v.variant("ok", [
  v.strictObject({
    ok: v.literal(true),
    signs: v.strictObject({
      password: v.boolean(),
      code: v.boolean(),
      captcha: v.boolean(),
      invalid: v.boolean(),
      alert: v.boolean(),
      /** Why `alert` does not hold on a sign-in form shown again, for the log only. */
      alertMiss: v.optional(v.picklist(alertMisses)),
      username: v.optional(v.boolean()),
    }),
    /** Whether the document has finished loading; the login completes only then. */
    loaded: v.boolean(),
  }),
  v.strictObject({ ok: v.literal(false) }),
]);
export const observationSchema = v.strictObject({
  path: v.string(),
  targets: v.pipe(v.array(targetStateSchema), v.maxLength(24)),
  /**
   * With `signIn` asked: whether the page has finished loading, and whether it shows a
   * visible writable password input (`password`) or an email input or one marked for a
   * username or an email address (`identifier`) that is none of the asked targets, outside
   * any form with a `new-password` or `one-time-code` input.
   */
  signIn: v.optional(
    v.strictObject({ loaded: v.boolean(), password: v.boolean(), identifier: v.boolean() }),
  ),
  /** With `explain` asked: per target, the check that decided its state. */
  checks: v.optional(v.pipe(v.array(targetCheckSchema), v.maxLength(24))),
});
export const configureSchema = v.strictObject({
  version: v.literal(1),
  type: v.literal("login.probe.configure"),
  origin: v.pipe(
    v.string(),
    v.check((origin) => {
      const url = URL.parse(origin);
      return (
        url !== null &&
        url.origin === origin &&
        url.protocol === "http:" &&
        url.hostname === "127.0.0.1"
      );
    }),
  ),
  /** Probe-only explicit account binding; the default is the bundled demo item. */
  account: v.optional(
    v.strictObject({
      connectionId: id,
      itemId: id,
      slots: v.pipe(
        v.array(v.strictObject({ slot: id, fieldId: id })),
        v.minLength(1),
        v.maxLength(20),
      ),
    }),
  ),
  /**
   * Probe-only passkey fact for the synthetic item (ADR 0027). The probe vault holds no
   * passkey, so this stands in for the vault search; no key is created or used.
   */
  passkey: v.optional(v.picklist(["discoverable", "second-factor"])),
  /**
   * Probe-only TOTP fact for the synthetic item (ADR 0027): its synthetic `totp` field then
   * counts as holding a TOTP secret. The field's value is a fixed synthetic code.
   */
  totp: v.optional(v.literal(true)),
  /**
   * Probe-only wait in place of `LOGIN_STEP_WAIT_MS` for a step's elements and an
   * advance's confirmation, so a test runs past those waits without sitting out ten
   * seconds. Without it, as always in production, the full wait applies.
   */
  stepWaitMs: v.optional(
    v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(LOGIN_STEP_WAIT_MS)),
  ),
});
export const statusSchema = v.strictObject({
  version: v.literal(1),
  type: v.literal("login.probe.status"),
});
export const cancelSchema = v.strictObject({
  version: v.literal(1),
  type: v.literal("login.probe.cancel"),
  tabId: v.pipe(v.number(), v.integer(), v.minValue(0)),
});
export const probeControlSchema = v.variant("action", [
  v.strictObject({
    version: v.literal(1),
    type: v.literal("login.probe.control"),
    action: v.literal("arm"),
    checkpoint: v.picklist(["before-delivery", "before-ack", "intent-write-failure"]),
  }),
  v.strictObject({
    version: v.literal(1),
    type: v.literal("login.probe.control"),
    action: v.literal("release"),
  }),
]);
