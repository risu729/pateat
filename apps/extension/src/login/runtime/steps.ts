import * as v from "valibot";
import {
  attemptPlan,
  builtInLoginSlots,
  findLoginBinding,
  isFieldExcluded,
  loginFieldSource,
  loginObservationSchema,
  keypadStep,
  loginStepEffect,
  passwordVariants,
  recipeBranch,
  resolveBindingFields,
  sameLoginTarget,
  saveLoginChoice,
  TOTP_HANDLER_SLOT,
  type LoginFieldTarget,
  questionText,
  shownQuestionSchema,
  storedQuestionSchema,
  totpFieldReference,
  type LoginAttemptMetadata,
  type LoginHandler,
  type LoginObservation,
  chooserClickBranch,
  type LoginRecipe,
  type LoginStep,
  type LocalSettings,
  type SavedLoginBinding,
  type SemanticSlot,
  type SettingsSnapshot,
  type VaultCatalog,
  type VaultConnectionMetadata,
  type VaultItemMetadata,
} from "@pateat/contracts";
import { domainKey } from "@pateat/bitwarden";
import { loginReadiness, type InPlaceNext } from "../wire";
import { type LiveSiteCandidate } from "../../vault/site-candidates";
import { type AskReason } from "../choice-wire";
import { type CustomFieldOffer } from "../generation-slots";
import { type SignInSigns } from "../sign-in-state";
import { type OnSite } from "../entry";
import { newId } from "@pateat/contracts/ids";
import {
  type UnsavedChoice,
  type LiveDocument,
  type DetailSourceField,
  type KeypadPress,
  type GenerationScope,
} from "./types";
import { type PairedQuestion } from "./session-schemas";
import { type GenerationOutcome, type EntryGenerationOutcome } from "./report";

/**
 * The sign-in form with its password input shown again in the first new document after
 * the password submission, with no sign of another step or of a sign-in (ADR 0021 D).
 */
export const formAgain = (signs: SignInSigns) =>
  signs.reshown === true &&
  signs.s2 &&
  !signs.s3 &&
  !signs.s4 &&
  !signs.s5 &&
  !signs.e1 &&
  !signs.e2 &&
  !signs.e3;

/** The registrable domain of an origin or URL, as Bitwarden's Domain match compares it. */
export function siteOf(value: string | URL): string | undefined {
  const url = typeof value === "string" ? URL.parse(value) : value;
  if (!url) return undefined;
  // Keep domain matching failures separate from an invalid URL.
  try {
    return domainKey(url);
  } catch {
    return undefined;
  }
}

/** Names a site's automatic login completions in the normal or the incognito session. */
export const reloginKey = (site: string, incognito: boolean) =>
  `${incognito ? "incognito" : "normal"} ${site}`;

/** Whether a URL is on the site of `page` (its registrable domain). */
export const sameSiteAs =
  (page: string): OnSite =>
  (url) => {
    const site = siteOf(page);
    return site !== undefined && siteOf(url) === site;
  };

/**
 * Settings with the choice added where missing, or replacing the site default for an
 * account picked to become it; the same object when nothing changes.
 */
export const withChoice = (value: SettingsSnapshot["settings"], choice: UnsavedChoice) =>
  saveLoginChoice(value, choice.binding, { replace: choice.replace === true });

/** A document's path before its token-like segments are replaced (ADR 0039). */
export const rawPath = (live: LiveDocument) => new URL(live.url).pathname;

/**
 * The popup's codes within its 200 characters: a page's own refusal reason is any text the
 * content script sent.
 */
export const clipCodes = <T extends Record<string, string | undefined>>(fields: T): T =>
  Object.fromEntries(
    Object.entries(fields).map(([key, value]) => [key, value?.slice(0, 200)]),
  ) as T;

/** A provider's or vault's reason as a log code, within the log's 64 characters. */
export const logCode = (reason: string) =>
  reason
    .toLowerCase()
    .replace(/[^a-z0-9.:-]+/gu, "-")
    .replace(/^[^a-z0-9]+/u, "")
    .slice(0, 64) || "unknown";

/** Documents are tracked per frame; a tab still runs at most one attempt. */
export const frameKey = (document: { tabId: number; frameId: number }) =>
  `${document.tabId}:${document.frameId}`;

/**
 * Attempt records are kept per tab and origin: each origin a tab shows keeps its own
 * record until the tab closes, while the tab still runs one attempt at a time.
 */
export const recordKey = (tabId: number, origin: string) => `${tabId} ${origin}`;

/** A document's key in the entry press's sets and maps (ADR 0031). */
export const documentKey = (page: { tabId: number; documentId: string }) =>
  `${page.tabId} ${page.documentId}`;

/**
 * The judge's pairings as a login keeps them (ADR 0061): each answer input with the custom
 * field whose slot the judge named, and the question. A slot sent for no custom field, or
 * a question too short or too long to store, pairs nothing.
 */
export function pairedQuestions(
  path: string,
  questions: readonly { field: LoginFieldTarget; slot: string; shown: string }[] | undefined,
  offers: readonly CustomFieldOffer[],
): { path: string; questions: PairedQuestion[] } | undefined {
  const kept = (questions ?? []).flatMap((entry) => {
    const offer = offers.find((candidate) => candidate.slot.id === entry.slot);
    const question = questionText(entry.shown);
    const shown = entry.shown.trim();
    return offer && v.is(storedQuestionSchema, question) && v.is(shownQuestionSchema, shown)
      ? [{ target: entry.field, field: offer.reference, question, shown }]
      : [];
  });
  return kept.length ? { path, questions: kept } : undefined;
}

/** Whether two fields' inputs are the same, in the same order. */
export const sameInputs = (left: readonly LoginFieldTarget[], right: readonly LoginFieldTarget[]) =>
  left.length === right.length && left.every((target, at) => sameLoginTarget(target, right[at]!));

/** A link's source field as a key, the same whatever order its properties came in. */
export const sourceFieldKey = (field: DetailSourceField) =>
  typeof field === "string"
    ? field
    : JSON.stringify([field.custom, field.position ?? null, field.count ?? null]);

/** Names a popup choice by its document and the accounts it offers. */
export const choiceKey = (choice: {
  document: { documentId: string; origin: string };
  candidates: readonly { connectionId: string; itemId: string }[];
}) =>
  JSON.stringify([
    choice.document.documentId,
    choice.document.origin,
    choice.candidates.map((entry) => `${entry.connectionId} ${entry.itemId}`).sort(),
  ]);

/** An in-memory catalog copy in which one item covers `origin`; never persisted. */
export function withItemOrigin(
  catalog: VaultCatalog,
  account: { connectionId: string; itemId: string },
  origin: string,
): VaultCatalog {
  const granted = structuredClone(catalog);
  const item = granted.connections
    .find((entry) => entry.id === account.connectionId)
    ?.items.find((entry) => entry.id === account.itemId);
  if (item && !item.allowedOrigins.includes(origin)) item.allowedOrigins.push(origin);
  return granted;
}

/** The document's path now, after any route it took in place since it announced. */
export const pathNow = (live: LiveDocument) => live.route ?? live.path;

/** An outcome's fields for the local log: never the recipe itself or `retry`. */
export function outcomeFields(answer: GenerationOutcome | EntryGenerationOutcome) {
  const timed = answer.timing ? { timing: answer.timing } : {};
  // A route recipe's kind (ADR 0035); a chooser and an entry recipe are always `sign-in`.
  if (answer.outcome === "recipe")
    return {
      outcome: answer.outcome,
      ...("recipe" in answer && "pageKind" in answer.recipe
        ? { pageKind: answer.recipe.pageKind }
        : {}),
      ...timed,
    };
  if (!("check" in answer)) return { outcome: answer.outcome, reason: answer.reason, ...timed };
  const { outcome, reason, check, detail, path } = answer;
  return {
    outcome,
    reason,
    check,
    ...(detail === undefined ? {} : { detail }),
    ...(path === undefined ? {} : { path }),
    ...timed,
  };
}

/**
 * A page's description as generation may send it (ADR 0016), or why not as a value-free
 * code for the log's `detail` (ADR 0019): `invalid-observation` when it fails its check,
 * the extractor's `gap` when it is incomplete (`incomplete` without one), and for a
 * complete one `origin-changed` or `path-changed` when it describes another origin or path
 * than expected, or `list-mismatch` when `list` is given and the description lists
 * accounts on a page not announced as a list, or none on one that was.
 */
export function acceptedObservation(
  described: { readonly observation: unknown; readonly gap?: string | undefined },
  expected: { readonly origin: string; readonly path: string; readonly list?: boolean },
): { observation: LoginObservation } | { detail: string } {
  const parsed = v.safeParse(loginObservationSchema, described.observation);
  if (!parsed.success) return { detail: "invalid-observation" };
  const observation = parsed.output;
  if (!observation.complete) return { detail: described.gap ?? "incomplete" };
  if (observation.origin !== expected.origin) return { detail: "origin-changed" };
  if (observation.path !== expected.path) return { detail: "path-changed" };
  if (expected.list !== undefined && (observation.accounts !== undefined) !== expected.list)
    return { detail: "list-mismatch" };
  return { observation };
}

/** Roles of a field that can take an account's email address, username or ID. */
export const accountRoles = new Set(["text", "email", "tel", "number"]);

/**
 * A field's `autocomplete` that leaves it free to take an account: none, or one for a
 * username, an email address or a phone number.
 */
export const accountTokens = new Set([undefined, "off", "username", "email", "tel"]);

/**
 * Whether a page asks for an account (ADR 0028): it holds a field that can take one, in the
 * same form as a password field when it shows one, so a search box or another form's
 * field beside a password-only form does not count.
 */
export const asksAccount = (observation: LoginObservation) => {
  const passwords = observation.candidates.filter((candidate) => candidate.role === "password");
  return observation.candidates.some(
    (candidate) =>
      accountRoles.has(candidate.role) &&
      accountTokens.has(candidate.autocomplete) &&
      (!passwords.length || passwords.some((password) => password.group === candidate.group)),
  );
};

/**
 * Slot meanings sent for generation, each read from the vault item's built-in field of
 * the same name by `defaultLoginBinding`; `totp` reads a custom field holding a TOTP key
 * instead when the built-in one holds no value (`totpFieldReference`, owner 2026-10-23).
 */
export const generationSlots: { slot: SemanticSlot; fieldId: string }[] = [
  { slot: builtInLoginSlots.username, fieldId: "login.username" },
  { slot: builtInLoginSlots.password, fieldId: "login.password" },
  { slot: builtInLoginSlots.totp, fieldId: "login.totp-code" },
];

/**
 * Whether a matching item offers a generation slot's built-in field. The password counts
 * only when it holds a value and is not excluded (ADR 0027); the TOTP field counts when
 * present, so the TOTP flag never decides what the model is offered.
 */
export function offersGenerationField(
  settings: LocalSettings,
  catalog: VaultCatalog,
  entry: { connectionId: string; item: VaultItemMetadata },
  fieldId: string,
): boolean {
  const field = entry.item.fields.find((candidate) => candidate.id === fieldId);
  if (!field) return false;
  if (fieldId !== "login.password") return true;
  return (
    field.empty !== true &&
    !isFieldExcluded(settings, catalog, entry.connectionId, entry.item.id, fieldId)
  );
}

/**
 * The field a `totp` handler makes its code from for the login's item (ADR 0027): the
 * field the item's saved binding for the recipe names for `totp`, else the one
 * `totpFieldReference` picks (the built-in TOTP field when it holds a value, else the one
 * custom field flagged as holding a key, owner 2026-10-23), or the synthetic probe item's
 * `totp` field. A custom field counts only when it is a Text or Hidden field the catalog
 * flags as holding a TOTP key (`totpSeed`). The code is always generated from the field's
 * key; its raw value is never typed. Undefined when the item has no such field, or when
 * the binding names any other field for `totp`.
 */
export function codeFieldOf(
  connection: VaultConnectionMetadata,
  itemId: string,
  bindings: readonly SavedLoginBinding[],
  recipe: LoginRecipe,
): string | undefined {
  const item = connection.items.find((entry) => entry.id === itemId);
  if (!item) return undefined;
  if (connection.provider === "dummy")
    return item.fields.some((field) => field.id === "totp") ? "totp" : undefined;
  if (connection.provider !== "bitwarden" || !connection.userId) return undefined;
  const saved = findLoginBinding(bindings, recipe, {
    provider: connection.provider,
    server: connection.server,
    userId: connection.userId,
    itemId,
  });
  const reference =
    saved?.slots.find((entry) => entry.slot === TOTP_HANDLER_SLOT)?.field ??
    totpFieldReference(item.fields);
  if (reference !== "totp") {
    const resolved = resolveBindingFields(
      { slots: [{ slot: TOTP_HANDLER_SLOT, field: reference }] },
      [TOTP_HANDLER_SLOT],
      item.fields,
    );
    const fieldId = resolved.ok ? resolved.slots[0]!.fieldId : undefined;
    const field = item.fields.find((entry) => entry.id === fieldId);
    return field?.id.startsWith("custom.") &&
      (field.kind === "text" || field.kind === "hidden") &&
      field.totpSeed === true
      ? field.id
      : undefined;
  }
  return item.fields.some((field) => field.id === "login.totp-code")
    ? "login.totp-code"
    : undefined;
}

/**
 * Why an item's password fact is false, for the log (ADR 0027): the item's password is
 * missing or empty (`password-empty`), or it holds one that the account may not fill,
 * directly or through a field linked to it (`password-not-allowed`). Never a value.
 */
export function passwordMiss(
  item: Pick<VaultItemMetadata, "fields"> | undefined,
  allowedFieldIds: readonly string[],
): "password-not-allowed" | "password-empty" {
  const held = item?.fields.some((field) => field.id === "login.password" && field.empty !== true);
  return item &&
    held &&
    !allowedFieldIds.some((allowed) => loginFieldSource(item, allowed) === "login.password")
    ? "password-not-allowed"
    : "password-empty";
}

/**
 * Where the plan step at `index` stands in a TOTP code's entry (ADR 0027): the code fill
 * of an entered `totp` handler or of a route step that fills only the `totp` slot, or
 * the click on its button that follows the fill on the same path. A route's code fill
 * counts only when that click, a submit, follows it. A `totp` handler without a button
 * has only its fill, which submits by itself (ADR 0027 amendment of 2026-10-23).
 */
export function codeStep(
  recipe: LoginRecipe,
  metadata: LoginAttemptMetadata,
  index: number,
): "fill" | "click" | undefined {
  const plan = attemptPlan(recipe, metadata);
  const entry = plan?.[index];
  if (!entry) return undefined;
  const before = plan![index - 1];
  if (entry.handler !== undefined) {
    if (recipe.handlers?.[entry.handler]?.kind !== "totp") return undefined;
    if (entry.step.kind === "fill") return "fill";
    return entry.step.kind === "click" &&
      before?.handler === entry.handler &&
      before.step.kind === "fill"
      ? "click"
      : undefined;
  }
  const routeCode = (at: { step: LoginStep; handler?: number } | undefined) =>
    at?.handler === undefined &&
    at?.step.kind === "fill" &&
    at.step.fields.length === 1 &&
    at.step.fields[0]!.slot === TOTP_HANDLER_SLOT;
  const after = plan![index + 1];
  if (routeCode(entry))
    return after?.handler === undefined &&
      after?.step.kind === "click" &&
      after.step.purpose === "submit" &&
      after.step.path === entry.step.path
      ? "fill"
      : undefined;
  return entry.step.kind === "click" &&
    entry.step.purpose === "submit" &&
    routeCode(before) &&
    before!.step.path === entry.step.path
    ? "click"
    : undefined;
}

/**
 * Where the plan step at `index` stands in an entry the page may submit by itself: a TOTP
 * code's (`codeStep`, ADR 0027), or a route step's fill on a software keyboard followed on
 * the same path by its submit click, as a PIN pad that submits at its last digit
 * (ADR 0067).
 */
export function selfSubmitStep(
  recipe: LoginRecipe,
  metadata: LoginAttemptMetadata,
  index: number,
): "fill" | "click" | undefined {
  const code = codeStep(recipe, metadata, index);
  if (code) return code;
  const plan = attemptPlan(recipe, metadata);
  type Entry = { step: LoginStep; handler?: number } | undefined;
  const keyed = (fill: Entry, click: Entry) =>
    fill?.handler === undefined &&
    click?.handler === undefined &&
    fill !== undefined &&
    keypadStep(fill.step) &&
    click?.step.kind === "click" &&
    click.step.purpose === "submit" &&
    click.step.path === fill.step.path;
  if (keyed(plan?.[index], plan?.[index + 1])) return "fill";
  if (keyed(plan?.[index - 1], plan?.[index])) return "click";
  return undefined;
}

/**
 * Whether a TOTP code's fill (see `codeStep`) went in, or may have, and its click has not
 * run (ADR 0027): a page that moved on meanwhile submitted the code by itself. A fill on a
 * software keyboard counts only after the page told of its first key press (`press`, ADR
 * 0067), while the fill is still running or once it went in and before its click is
 * prepared: a document that replaced the page before any press, as after the person's own
 * link click or a reload, submitted nothing, and neither did one after a stopped fill.
 */
export const codeAwaitsClick = (
  recipe: LoginRecipe,
  metadata: LoginAttemptMetadata,
  press: KeypadPress | undefined,
) =>
  metadata.operationId === undefined
    ? codeStep(recipe, metadata, metadata.stepIndex) === "click" ||
      (press?.filled === true &&
        press.stepIndex === metadata.stepIndex - 1 &&
        selfSubmitStep(recipe, metadata, metadata.stepIndex) === "click")
    : metadata.operationKind === "fill" &&
      metadata.operationEffect === "prepare" &&
      metadata.mutationIntent === true &&
      (codeStep(recipe, metadata, metadata.stepIndex) === "fill" ||
        (press?.filled !== true &&
          press?.operationId === metadata.operationId &&
          selfSubmitStep(recipe, metadata, metadata.stepIndex) === "fill"));

/** The event for a code the page submitted by itself, marking a route step's code. */
export const autoSubmitted = (recipe: LoginRecipe, metadata: LoginAttemptMetadata) => ({
  type: "AUTO_SUBMITTED" as const,
  operationId: newId(),
  ...(attemptPlan(recipe, metadata)?.[metadata.stepIndex]?.handler === undefined
    ? { routeStep: true as const }
    : {}),
});

export const stepTargets = (step: LoginStep) =>
  step.kind === "fill" ? step.fields.map((field) => field.target) : [step.target];

/**
 * The name of the layout a login runs (ADR 0060) and, for a chooser login (ADR 0028), the
 * branch its click led to, as the service's records and requests name them; `undefined` for
 * a recipe without layouts, as the probe build's.
 */
export function branchOf(metadata: LoginAttemptMetadata): string | undefined {
  return metadata.layout === undefined
    ? undefined
    : recipeBranch(
        metadata.layout,
        metadata.chooser ? chooserClickBranch(metadata.chooser.click) : undefined,
      );
}

/** `branchOf` as an optional `branch` member. */
export function branchField(metadata: LoginAttemptMetadata): { branch?: string } {
  const branch = branchOf(metadata);
  return branch ? { branch } : {};
}

/**
 * The recipe's signed-in markers as elements to observe (ADR 0029): each marker, which may
 * be a link located by its text (ADR 0018), then the elements it needs missing. `proves`
 * reads their states from `offset`: whether one marker shows once, visible, while each
 * element it needs missing is missing even hidden, on any path. Only the markers learned
 * on `pageOrigin` count: the recipe's own origin by default, or another origin that a
 * login's tab moved to (ADR 0022).
 */
/** Whether two recipes hold the same signed-in markers, so reading one reads the other. */
export const sameMarkers = (left: LoginRecipe, right: LoginRecipe) =>
  JSON.stringify(left.completion ?? []) === JSON.stringify(right.completion ?? []);

export function markerProof(recipe: LoginRecipe, pageOrigin = recipe.origin) {
  const markers = (recipe.completion ?? []).filter(
    (marker) => (marker.origin ?? recipe.origin) === pageOrigin,
  );
  return {
    targets: markers.flatMap((marker) => [marker.target, ...(marker.absent ?? [])]),
    links: markers.flatMap((marker) => [true, ...(marker.absent ?? []).map(() => false)]),
    /** Every copy counts, hidden or not, as the markers were learned (ADR 0037 amendment). */
    hidden: markers.flatMap((marker) => [true, ...(marker.absent ?? []).map(() => true)]),
    /** Each marker must be visible; the elements it needs gone count even when hidden. */
    shown: markers.flatMap((marker) => [
      "shown" as const,
      ...(marker.absent ?? []).map(() => "present" as const),
    ]),
    proves(states: readonly string[], offset = 0): boolean {
      let at = offset;
      for (const marker of markers) {
        const absent = marker.absent ?? [];
        if (
          states[at] === "unique" &&
          absent.every((_target, index) => states[at + 1 + index] === "missing")
        )
          return true;
        at += 1 + absent.length;
      }
      return false;
    },
  };
}

/**
 * What confirms the route step at `index` when it is an advance whose next route step is
 * on the same path, as an identifier-first form that swaps in its password form in place
 * (ADR 0013): the next step's elements, as that step waits for them and also visible as
 * the page's description reads them (ADR 0018), so a password input an email form keeps
 * off-screen or hidden from assistive technology for the browser is not taken for the
 * password form before or after the advance. Undefined when no element could confirm it: a
 * next step that needs none, one that shares an element with the advance, or a handler's
 * step, which keeps its own rules (ADR 0027). A `password` handler's click is the exception:
 * the route's next step on its path confirms it as it confirms an advance (ADR 0048).
 */
export function inPlaceNext(
  recipe: LoginRecipe,
  metadata: LoginAttemptMetadata,
  index: number,
): InPlaceNext | undefined {
  const plan = attemptPlan(recipe, metadata);
  const done = plan?.[index];
  const next = plan?.[index + 1];
  if (
    !done ||
    !next ||
    (done.handler !== undefined && recipe.handlers?.[done.handler]?.kind !== "password") ||
    next.handler !== undefined ||
    loginStepEffect(done.step) !== "advance" ||
    done.step.path !== next.step.path
  )
    return undefined;
  const readiness = loginReadiness(next.step);
  const own = stepTargets(done.step);
  if (
    !readiness.targets.length ||
    readiness.targets.some((target) => own.some((other) => sameLoginTarget(other, target)))
  )
    return undefined;
  return {
    require:
      readiness.require === "writable"
        ? "described-writable"
        : readiness.require === "clickable"
          ? "described-clickable"
          : "present",
    targets: readiness.targets,
  };
}

/**
 * The order in which handlers shown together are tried: a `password` handler first, so a
 * login that types its password goes on to it rather than to a passkey beside it (ADR
 * 0048), then a passkey, which types nothing.
 */
export const handlerOrder = {
  password: 0,
  passkey: 1,
  totp: 2,
  // After a code field already shown, and after a passkey button beside it (ADR 0081).
  authenticator: 3,
  detail: 4,
} as const satisfies Record<LoginHandler["kind"], number>;

/**
 * The recipe's inputs for the `username` slot on `path`, over every password variant, each
 * once: where a site may show the account it remembers (ADR 0028 amendment of 2026-10-23).
 */
export function accountTargetsOn(recipe: LoginRecipe, path: string): LoginFieldTarget[] {
  const targets: LoginFieldTarget[] = [];
  for (const variant of passwordVariants(recipe))
    for (const step of variant.steps)
      if (step.kind === "fill" && step.path === path)
        for (const field of step.fields)
          if (
            field.slot === "username" &&
            !targets.some((target) => sameLoginTarget(target, field.target))
          )
            targets.push(field.target);
  return targets;
}

/** Each URI match's connection and item in the catalog; one the catalog lacks is left out. */
export function catalogItems(
  catalog: VaultCatalog,
  candidates: readonly Pick<LiveSiteCandidate, "connectionId" | "itemId">[],
): GenerationScope["items"] {
  return candidates.flatMap((candidate) => {
    const connection = catalog.connections.find((entry) => entry.id === candidate.connectionId);
    const item = connection?.items.find((entry) => entry.id === candidate.itemId);
    return connection && item ? [{ connection, item }] : [];
  });
}

/** The badge of a tab whose login waits for an account choice (ADR 0021). */
export function choiceBadge(
  candidates: readonly unknown[],
  ask: AskReason | undefined,
  paused?: boolean,
): { count: number; ask?: AskReason; paused?: true } {
  return {
    count: candidates.length,
    ...(ask ? { ask } : {}),
    ...(paused ? { paused: true as const } : {}),
  };
}
