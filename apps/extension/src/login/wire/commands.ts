import * as v from "valibot";
import {
  datePartSchema,
  listClickSchema,
  loginFieldTargetSchema,
  loginOperationSchema,
  loginOriginSchema,
  loginMarkerTargetSchema,
  loginTargetSchema,
  logoutPurposeSchema,
} from "@pateat/contracts";
import { DESCRIBED_WATCH_MAX_MS, LOGIN_STEP_WAIT_MS, LOGOUT_REACTION_MS } from "./constants";
import {
  hostList,
  href,
  id,
  inPlaceNextSchema,
  loginSecretKinds,
  path,
  questionSchema,
  targetRequirementSchema,
} from "./primitives";
import { loginReadinessSchema } from "./readiness";

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

/** What a fill value of a split detail (ADR 0061) says about the input it goes into. */
const splitPartEntries = {
  /**
   * A card number's or PIN's digit group goes only into an input whose `maxlength` is this,
   * the group's length, or the last group's input's when its digits are fewer.
   */
  group: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(19))),
  /** A split date's part, whose range a select's option values must lie in. */
  part: v.optional(datePartSchema),
  /** A card expiry year, which a select may write with two or four digits. */
  shortYear: v.optional(v.literal(true)),
};

export const commandSchema = v.variant("type", [
  v.strictObject({
    version: v.literal(1),
    type: v.literal("login.fill.change"),
    token: id,
    timeoutMs: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(LOGIN_STEP_WAIT_MS)),
    /**
     * A sign-in fill's next step (ADR 0035): answered once it is ready, else at the next
     * sign of a change of the page. With `settled`, it was ready before the fill already,
     * and only a move of the page to another path answers.
     */
    readiness: v.optional(loginReadinessSchema),
    settled: v.optional(v.literal(true)),
    /** Learned handlers not entered yet (ADR 0061): answered too once one of them shows. */
    handlers: v.optional(v.pipe(v.array(loginReadinessSchema), v.minLength(1), v.maxLength(8))),
    /**
     * The worker found nothing to do after the previous answer: the page waits for its next
     * change before it reads the steps again, so a disagreement never repeats at once.
     */
    changed: v.optional(v.literal(true)),
  }),
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
          ...splitPartEntries,
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
     * With `account`: the page may show no identifier yet, and the fill's own click
     * follows on its path, so the comparison may wait for that click (ADR 0049 amendment
     * of 2026-11-03). Never for a fill-only login, a software keyboard's or a code's fill,
     * whose page may submit without that click.
     */
    accountAtPress: v.optional(v.literal(true)),
    /**
     * Without the recipe's switch: the page's own control for another account may be
     * clicked when the page shows another account (ADR 0078).
     */
    otherSwitch: v.optional(v.literal(true)),
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
     * With an `authenticator` handler's click (ADR 0081): the button is pressed only while
     * it, read in the same task as the press, still names an authenticator app's code as
     * `authenticator-choice` takes it; otherwise nothing is pressed and the step fails as
     * one whose target is missing.
     */
    authenticatorChoice: v.optional(v.literal(true)),
    /**
     * With an advance whose next step is on its own path (ADR 0013): that step's elements,
     * measured in the same task as the click or the fill's first input, just before it. The
     * answer reports them as `before`.
     */
    next: v.optional(inPlaceNextSchema),
    /**
     * With an advance where another layout of the recipe goes on along the same steps (ADR
     * 0060): that layout's next step on the advance's path, measured as `next` is. The answer
     * reports them as `siblingsBefore`, in this order.
     */
    siblings: v.optional(v.pipe(v.array(inPlaceNextSchema), v.maxLength(2))),
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
   * The popup's **Fill** of a personal detail (ADR 0061): types each value into the one
   * writable input its `target` names on `path`, or chooses its option in a select for a
   * split date's part, after checking the first input's choosing radio button, and presses
   * nothing. Every input is checked before any is filled. Outside any login: no
   * operation, no submission.
   */
  v.strictObject({
    version: v.literal(1),
    type: v.literal("login.detail.fill"),
    token: id,
    path,
    /** The pending, document-bound fill whose destinations the background authorizes. */
    fillId: id,
    expiresAt: v.pipe(v.number(), v.integer(), v.minValue(0)),
    origin: loginOriginSchema,
    /** The shown handler button, checked for a submitter's `formaction` before filling. */
    submit: loginTargetSchema,
    fields: v.pipe(
      v.array(
        v.strictObject({
          target: loginFieldTargetSchema,
          value: v.pipe(v.string(), v.minLength(1), v.maxLength(128)),
          secret: v.optional(v.picklist(loginSecretKinds)),
          question: v.optional(questionSchema),
          ...splitPartEntries,
        }),
      ),
      v.minLength(1),
      v.maxLength(6),
    ),
    /** The login item's username: the page must not show another account. */
    account: v.optional(v.strictObject({ username: v.pipe(v.string(), v.maxLength(4096)) })),
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
   * What the page shows beside the card detail input `target` and in its title (ADR
   * 0061): the last four digits of masked card numbers and card brands, never its text.
   */
  v.strictObject({
    version: v.literal(1),
    type: v.literal("login.detail.card"),
    token: id,
    path,
    target: loginFieldTargetSchema,
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
   * Asks which of `usernames` equals the value the page itself put into the account input
   * `targets` name before anyone typed (ADR 0028 amendment of 2026-10-23). Answered once
   * per document; only the index leaves the content script.
   */
  v.strictObject({
    version: v.literal(1),
    type: v.literal("login.site.account"),
    token: id,
    path,
    targets: v.pipe(v.array(loginFieldTargetSchema), v.minLength(1), v.maxLength(8)),
    usernames: v.pipe(
      v.array(v.pipe(v.string(), v.maxLength(4096))),
      v.minLength(2),
      v.maxLength(32),
    ),
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
    page: v.picklist(["login", "signed-in", "accounts", "entry", "passkey", "logout"]),
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
    /**
     * The description goes to the service (ADR 0016): a frame that does not show in the
     * tab's page answers `frame-hidden` instead (ADR 0086).
     */
    shown: v.optional(v.literal(true)),
  }),
  /**
   * After a judged page whose description had nothing to send (`no-candidates`), as a page
   * still loading shows (ADR 0027 amendment of 2026-11-04): the document reports once, with
   * `login.document.described`, when a page after the sign-in (`signed-in`) would describe
   * something, checking at each change of the page (ADR 0082) for up to `timeoutMs`. A
   * later watch replaces it; it answers at once and never mutates.
   */
  v.strictObject({
    version: v.literal(1),
    type: v.literal("login.extract.watch"),
    token: id,
    timeoutMs: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(DESCRIBED_WATCH_MAX_MS)),
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
   * Waits up to `timeoutMs` for a logout recipe's target (ADR 0063) to name a shown element
   * and presses it when it names exactly one whose names say nothing more than `purpose`
   * (`safeLogoutControl`), only while the page's URL is still the one the command found.
   */
  v.strictObject({
    version: v.literal(1),
    type: v.literal("login.logout.click"),
    token: id,
    target: loginTargetSchema,
    /** What the click is for: a control whose name says more is never pressed (ADR 0063). */
    purpose: logoutPurposeSchema,
    timeoutMs: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(LOGIN_STEP_WAIT_MS)),
    /**
     * After the press, how long to watch the page for a reaction: the URL changing, a new
     * open dialog or menu, or the control going away (ADR 0063, owner 2026-10-23).
     */
    watchMs: v.optional(
      v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(LOGOUT_REACTION_MS)),
    ),
  }),
  /**
   * Finds the page's one control that says it logs out of this site, by its words, and
   * answers its locator (ADR 0063); the page's text never leaves it otherwise.
   */
  v.strictObject({
    version: v.literal(1),
    type: v.literal("login.logout.local"),
    token: id,
    /**
     * The hosts the worker found on the page's site among those `login.entry.hosts`
     * listed: a logout link elsewhere is not this site's.
     */
    onSite: hostList,
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
    /**
     * Reads the page once its document has loaded, waiting for its `load` event at most
     * this many milliseconds (ADR 0029, amended 2026-11-03; ADR 0082).
     */
    loadWithinMs: v.optional(
      v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(LOGIN_STEP_WAIT_MS)),
    ),
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
