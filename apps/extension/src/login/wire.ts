import * as v from "valibot";
import {
  chooserClickSchema,
  loginAttributeTargetSchema,
  loginOperationSchema,
  loginTargetSchema,
  type LoginStep,
  type LoginTarget,
} from "@pateat/contracts";

const id = v.pipe(v.string(), v.minLength(1), v.maxLength(120));
/** Which inputs a secret value may fill; see `acceptsSecret` in `inputs.ts`. */
export const loginSecretKinds = ["password", "otp", "hidden"] as const;
export type LoginSecretKind = (typeof loginSecretKinds)[number];
const path = v.pipe(v.string(), v.minLength(1), v.maxLength(300));
/** One target's state: no element, exactly one usable element, several, or one unusable. */
export const targetStateSchema = v.picklist(["missing", "unique", "ambiguous", "unusable"]);
export type TargetState = v.InferOutput<typeof targetStateSchema>;
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
    require: step.kind === "fill" ? "writable" : step.kind === "click" ? "clickable" : "present",
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
export const helloSchema = v.strictObject({
  version: v.literal(1),
  type: v.literal("login.document.ready"),
  token: id,
  /** The first step's elements are ready on this path; a new attempt may start. */
  start: v.optional(v.strictObject({ path })),
  /**
   * A visible password, username or one-time-code input shows on this path, so a page
   * without a recipe may be sent for generation (ADR 0016).
   */
  signIn: v.optional(v.strictObject({ path })),
  /**
   * Such an input shows on this path but no first step is ready; sent once per path, only
   * for the log of a login that did not start.
   */
  shown: v.optional(v.strictObject({ path })),
  /**
   * Ten seconds after loading, this path shows no sign-in input but lists accounts (ADR
   * 0028): an entry or a text beside at most three buttons with an email, masked or not.
   * Without one, `names` are the short texts that may name an account by a username that
   * is not an email, for the background to compare with the matching items' usernames.
   */
  list: v.optional(
    v.strictObject({
      path,
      names: v.optional(
        v.pipe(v.array(v.pipe(v.string(), v.minLength(1), v.maxLength(64))), v.maxLength(32)),
      ),
    }),
  ),
});
/**
 * A form with a password input was submitted in this document by anyone, Pateat or the
 * person: the tab's next page of the origin is never sent as a list of accounts (ADR 0028).
 */
export const submittedSchema = v.strictObject({
  version: v.literal(1),
  type: v.literal("login.document.submitted"),
  token: id,
});
/**
 * A refused hello. `starts` lists the first steps of the origin's recipes; the document
 * announces again with `start` once one of them is ready on the current path.
 */
export const readySchema = v.strictObject({
  ok: v.boolean(),
  reason: v.optional(v.string()),
  starts: v.optional(v.pipe(v.array(loginReadinessSchema), v.maxLength(32))),
  /** The page may be sent for generation; announce again with `signIn` once it applies. */
  generate: v.optional(v.literal(true)),
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
 * What a chooser's login needs to choose on its list (ADR 0028): the chosen item's
 * username, the other matching items' usernames and the chooser's buttons. The usernames
 * never leave the content script.
 */
const listInputSchema = v.strictObject({
  username: v.pipe(v.string(), v.maxLength(4096)),
  others: v.pipe(v.array(v.pipe(v.string(), v.maxLength(4096))), v.maxLength(32)),
  other: v.optional(loginTargetSchema),
  continue: v.optional(loginTargetSchema),
});
/** What the list showed a chooser's login would click; `none` when nothing fits. */
export const chooseResultSchema = v.variant("ok", [
  v.strictObject({
    ok: v.literal(true),
    click: v.picklist([...chooserClickSchema.options, "none"]),
  }),
  v.strictObject({ ok: v.literal(false) }),
]);
export const commandSchema = v.variant("type", [
  v.strictObject({
    version: v.literal(1),
    type: v.literal("login.observe"),
    token: id,
    path: v.string(),
    targets: v.pipe(v.array(loginTargetSchema), v.maxLength(24)),
    /**
     * Per target, what its one element must be to count as `unique`: a shown writable
     * input, a shown enabled button, or any shown element; otherwise it is `unusable`.
     * Without it, any one element counts, hidden or not.
     */
    require: v.optional(
      v.pipe(v.array(v.picklist(["writable", "clickable", "shown", "present"])), v.maxLength(24)),
    ),
    /**
     * Per target, whether a text locator may also name a link by its text, as for an
     * account switch: set for a completion marker, which may be a link (ADR 0018).
     */
    links: v.optional(v.pipe(v.array(v.boolean()), v.maxLength(24))),
    /**
     * Also answer `signIn`: whether the page has loaded and which sign-in inputs other than
     * `targets` it shows, to continue a recipe on (ADR 0018).
     */
    signIn: v.optional(v.literal(true)),
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
    list: v.optional(v.strictObject({ ...listInputSchema.entries, click: chooserClickSchema })),
    /**
     * With a `totp` handler's code fill (ADR 0027): the button that submits the code. The
     * fill then watches for the page submitting the code by itself before it answers.
     */
    code: v.optional(v.strictObject({ submit: loginTargetSchema })),
    /**
     * With an advance whose next step is on its own path (ADR 0013): that step's elements,
     * measured in the same task as the click or the fill's first input, just before it. The
     * answer reports them as `before`.
     */
    next: v.optional(loginReadinessSchema),
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
    page: v.picklist(["login", "signed-in", "accounts"]),
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
    known: v.optional(v.pipe(v.array(loginAttributeTargetSchema), v.maxLength(24))),
  }),
  /**
   * Reads the page signs of ADR 0029 after an effect step that no check explained. The
   * username, when given, is compared with the header and navigation and never leaves the
   * content script.
   */
  v.strictObject({
    version: v.literal(1),
    type: v.literal("login.state"),
    token: id,
    account: v.optional(v.strictObject({ username: v.pipe(v.string(), v.maxLength(4096)) })),
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
   * showed a new alert (ADR 0010).
   * `submitted`: after a `totp` handler's code fill the page showed that it submits the
   * code by itself (ADR 0027); nothing was clicked.
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
    ]),
  ),
  /**
   * Why a step was `cancelled` or failed, for the local log only (ADR 0019): the worker did
   * not authorize it, this document was cancelled, the operation was used or expired, the
   * page moved to another path, a field changed under the fill, the step threw; or, for a
   * failure, the form was replaced, the target is missing or not writable, the form
   * changed before a click, an `assert` did not hold, the step was sent values it does not
   * fill, its fields are in different forms, an input refused its secret, the page's inputs
   * have no value setter, or a code field's submission watch could not start.
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
      "fields-split",
      "secret-refused",
      "unsupported-input",
      "code-watch-failed",
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
/** Why a signed-in page's observation is incomplete; see `ObservationGap`. */
export const observationGaps = [
  "shadow-field",
  "unfillable-field",
  "unlocated-field",
  "too-many-fields",
] as const;
/** The page description; validated again against `loginObservationSchema` by the caller. */
export const extractResultSchema = v.variant("ok", [
  v.strictObject({
    ok: v.literal(true),
    observation: v.unknown(),
    /** Why a signed-in page's observation is incomplete; for diagnostics only. */
    gap: v.optional(v.picklist(observationGaps)),
  }),
  v.strictObject({ ok: v.literal(false), reason: v.string() }),
]);
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
});
export const configureSchema = v.strictObject({
  version: v.literal(1),
  type: v.literal("login.probe.configure"),
  origin: v.pipe(
    v.string(),
    v.check((origin) => {
      try {
        const url = new URL(origin);
        return url.origin === origin && url.protocol === "http:" && url.hostname === "127.0.0.1";
      } catch {
        return false;
      }
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
