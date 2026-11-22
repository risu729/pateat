// The RP return of an SSO flow: reading the RP page the tab came back to after the IdP, and
// completing the flow on its evidence (ADR 0026, amendments of 2026-11-20).
import * as v from "valibot";
import {
  getItemEligibility,
  onlyChoicesSince,
  parseAttemptMetadata,
  type LoginAttemptMetadata,
  type LoginTarget,
} from "@pateat/contracts";
import { ssoReturnResultSchema } from "../../sso-operation-wire";
import { stateResultSchema, observationSchema } from "../../wire";
import { loginUsernameFieldId } from "../../vault";
import { send, publish, noteSignedIn, reportAttempt } from "../attempt";
import { keep, quietly } from "../session-store";
import { withChoice } from "../steps";
import { hideUsernames, returnMarkerProofs, showsMarkers } from "../markers";
import { countRelogin } from "../relogin";
import { ssoScope } from "../sso-scope";
import type { SsoWork } from "../sso-state";
import { ssoObservation } from "./entry";
import { releaseChild } from "./child";
import { watchReturn } from "./moved";
import { cancelSso } from "./flow";
import type { LiveDocument } from "../types";
import type { Runtime } from "../state";

/** The flow's parent record ended unsigned, as a cancelled login. */
export const cancelled = (work: SsoWork, parent: LoginAttemptMetadata) =>
  parseAttemptMetadata({
    ...parent,
    state: "blocked",
    outcome: "cancelled",
    timing: { ...parent.timing, pageMs: Date.now() - work.startedAt },
  });
export async function username(rt: Runtime, work: SsoWork, live: LiveDocument, idp: boolean) {
  const account = idp ? { ...work.selected.account, origin: work.selected.origin } : work.account;
  const connection = work.saved.catalog.connections.find(
    (entry) => entry.id === account.connectionId,
  );
  const eligible = getItemEligibility(
    work.saved.snapshot.settings,
    work.saved.catalog,
    account.connectionId,
    account.itemId,
  );
  const fieldId = connection && loginUsernameFieldId(connection, account.itemId);
  if (
    !connection ||
    !fieldId ||
    !eligible.eligible ||
    !eligible.fieldIds.includes(fieldId) ||
    !(await ssoScope(rt, work, live))
  )
    return undefined;
  const value = await rt.fields({ connection, account, fieldId }).catch(() => undefined);
  return (await ssoScope(rt, work, live))?.() ? value : undefined;
}
/**
 * Completes the flow on the RP page's positive evidence. After an IdP that showed no page
 * (`instant`) nothing confirmed which IdP account signed in: a bracket-form method then
 * needs the RP to show the selected identity itself, and a URL-form method completing on
 * a marker alone is recorded as unconfirmed, which saves no account choice, keeps no
 * session pick and leaves no confirmation proof.
 */
async function completeSso(rt: Runtime, work: SsoWork, live: LiveDocument, instant = false) {
  if (!work.parent || !(await ssoScope(rt, work, live))?.()) return false;
  let selected = work.form === "url" ? undefined : await username(rt, work, live, false);
  const identity = v.safeParse(
    ssoReturnResultSchema,
    await send(rt, live, {
      type: "login.sso.return",
      ...(selected ? { username: selected } : {}),
    }).catch(() => undefined),
  );
  const state = v.safeParse(
    stateResultSchema,
    await send(rt, live, {
      type: "login.state",
      ...(selected ? { account: { username: selected } } : {}),
      loadWithinMs: 10_000,
    }).catch(() => undefined),
  );
  selected = undefined;
  if (
    !identity.success ||
    !identity.output.ok ||
    identity.output.identity === "different" ||
    !state.success ||
    !state.output.ok ||
    !state.output.loaded ||
    // A return page's reading has no submitted form, so it never says invalid or alert.
    [state.output.signs.password, state.output.signs.code, state.output.signs.captcha].some(Boolean)
  )
    return false;
  const layout = work.recipe?.sso.layouts.find((entry) => entry.key === work.layout);
  for (const entry of layout?.entries ?? []) {
    // oxlint-disable-next-line no-await-in-loop -- every original SSO entry must still be absent
    if ((await ssoEntryShown(rt, live, entry.target)) !== false) return false;
  }
  const matched = identity.output.identity === "match";
  if (instant && work.form !== "url" && !matched) return false;
  const unconfirmed = instant && !matched;
  const positive =
    matched ||
    (await ssoMarkerShown(rt, work, live)) ||
    (await showsMarkers(
      rt,
      live,
      await returnMarkerProofs(rt, work.account.origin, live.document.origin),
    ));
  const fence = positive ? await ssoScope(rt, work, live) : undefined;
  if (!fence?.()) return false;
  const before = work.parent;
  const ended = parseAttemptMetadata({
    ...before,
    // A return to another origin of the RP's site keeps the record on the RP's own
    // document, since an attempt belongs to its account's origin.
    document: live.document.origin === before.account.origin ? live.document : before.document,
    state: "authenticated",
    outcome: "authenticated",
    ...(unconfirmed ? { unconfirmed: true as const } : {}),
    timing: { ...before.timing, pageMs: Date.now() - work.startedAt },
  });
  // No awaited work between the last delivery fence and the state transition.
  clearTimeout(work.timer);
  work.parent = ended;
  rt.sso.interrupted.delete(live.document.tabId);
  await keep(rt, ended, true, fence);
  if (!fence()) {
    // The page or the flow's scope changed during the write, and the flow's timer no
    // longer runs: it ends unsigned, never left waiting (ADR 0026, amendment of 2026-11-20).
    work.parent = before;
    if (rt.sso.flows.get(live.document.tabId) === work && !work.ended)
      cancelSso(rt, live.document.tabId, "sso-scope-changed");
    else {
      // Ended meanwhile while it read as signed in, so nothing recorded its end: it is
      // recorded with the reason that ended it.
      work.ended = true;
      const unsigned = cancelled(work, before);
      work.parent = unsigned;
      const reason = work.endReason ?? "sso-scope-changed";
      void quietly(rt, async () => {
        await keep(rt, unsigned);
        reportAttempt(rt, unsigned, undefined, undefined, { reason });
      });
    }
    return false;
  }
  work.recorded = true;
  reportAttempt(rt, ended, undefined);
  noteSignedIn(rt, before, ended, work.account.origin);
  countRelogin(rt, before, ended, live.incognito === true);
  // The IdP's login ends signed in with the parent, before any later await.
  await quietly(rt, () => releaseChild(rt, work, true));
  // The flow ends with its transition, whatever a later write does; the RP default below
  // is still saved within its scope.
  try {
    if (work.choice && !unconfirmed && rt.settings.update) {
      const choice = work.choice;
      await rt.settings
        .update(
          undefined,
          "account-choice",
          (snapshot) => {
            if (!fence()) return snapshot;
            return { ...snapshot, settings: withChoice(snapshot.settings, choice) };
          },
          async (snapshot, catalog) => {
            // This callback runs inside the settings queue: never re-enter settings.handle.
            const latestCatalog = await catalog();
            return (
              onlyChoicesSince(snapshot, work.saved.snapshot.revision) &&
              JSON.stringify(latestCatalog) === JSON.stringify(work.saved.catalog) &&
              !!fence()
            );
          },
        )
        .catch(() => undefined);
    }
  } finally {
    work.ended = true;
    if (rt.sso.flows.get(live.document.tabId) === work) rt.sso.flows.delete(live.document.tabId);
  }
  await rt.sso.write();
  await publish(rt, live, ended);
  return true;
}
/**
 * Whether the loaded page asks for the account (`asks`): a visible password input, or an
 * identifier input that is its only input to type into or has a password input in its
 * form; and whether it shows no text yet (`blank`). Undefined when it cannot be read.
 */
async function asksSignIn(
  rt: Runtime,
  live: LiveDocument,
): Promise<{ asks: boolean; blank: boolean } | undefined> {
  const reading = v.safeParse(
    observationSchema,
    await send(rt, live, {
      type: "login.observe",
      path: live.path,
      targets: [],
      signIn: true,
    }).catch(() => undefined),
  );
  if (!reading.success) return undefined;
  const shown = reading.output.signIn;
  return {
    asks: !!shown?.loaded && (shown.signInIdentifier || shown.password),
    blank: shown?.blank === true,
  };
}
async function ssoEntryShown(
  rt: Runtime,
  live: LiveDocument,
  target: LoginTarget,
): Promise<boolean | undefined> {
  const reading = v.safeParse(
    observationSchema,
    await send(rt, live, {
      type: "login.observe",
      path: live.path,
      targets: [target],
      require: ["shown"],
    }).catch(() => undefined),
  );
  // A missing reading proves neither absence, including a visible but disabled entry, nor
  // presence, as when the page navigates away while it is read: it answers undefined.
  if (!reading.success || reading.output.targets[0] === undefined) return undefined;
  return ["unique", "ambiguous"].includes(reading.output.targets[0]);
}
async function ssoMarkerShown(rt: Runtime, work: SsoWork, live: LiveDocument) {
  // Only the markers learned on the page's origin: the recipe's own by default, or another
  // origin of its site a return landed on (ADR 0026, amendment of 2026-11-20).
  const targets =
    work.recipe?.sso.layouts
      .find((entry) => entry.key === work.layout)
      ?.completion?.filter(
        (entry) => (entry.origin ?? work.recipe?.origin) === live.document.origin,
      )
      .map((entry) => entry.target) ?? [];
  if (!targets.length) return false;
  const read = v.safeParse(
    observationSchema,
    await send(rt, live, {
      type: "login.observe",
      path: live.path,
      targets,
      require: targets.map(() => "shown" as const),
      // A marker named by its text is looked up among links too, as every signed-in
      // marker is (`markerProof`): a judge picks a link's text as often as a button's.
      links: targets.map(() => true),
    }).catch(() => undefined),
  );
  return (
    read.success &&
    read.output.targets.some((state) => state === "unique") &&
    !!(await ssoScope(rt, work, live))?.()
  );
}
/**
 * Why an RP page did not complete the flow and waits, for the log: the flow's scope no
 * longer held (as after the page changed its URL in place), the page could not be read,
 * was still loading, the completion's own checks failed, or it shows no text yet. Before
 * the IdP (`instant`), also a code or CAPTCHA, or nothing that proves the sign-in.
 */
export type Waiting =
  | "unscoped"
  | "unread"
  | "loading"
  | "code"
  | "captcha"
  | "incomplete"
  | "no-evidence"
  | "unobserved";
/**
 * Whether the RP page completes the flow: `completed`, `refused` when it shows the site's
 * sign-in again (its SSO entry, a password form or an identifier asking for the account),
 * another account, or, after the IdP, proves nothing that a judge could still confirm; or
 * why it waits. A return must carry positive RP authentication evidence, never just an
 * absent form. With `instant`, after an IdP that showed no page, only the page's own
 * evidence counts and the RP-return judge is never asked.
 */
export async function returned(
  rt: Runtime,
  work: SsoWork,
  live: LiveDocument,
  instant = false,
  /** Only says whether the RP's own evidence would complete (`evidence`), recording nothing. */
  check = false,
): Promise<"completed" | "evidence" | "refused" | Waiting> {
  if (!(await ssoScope(rt, work, live))) return "unscoped";
  let value = work.form === "url" ? undefined : await username(rt, work, live, false);
  const identity = v.safeParse(
    ssoReturnResultSchema,
    await send(rt, live, { type: "login.sso.return", ...(value ? { username: value } : {}) }).catch(
      () => undefined,
    ),
  );
  // Another account, or a page that is never a return (a permission, sharing or account
  // creation page), ends the flow; a page that could not be read proves nothing.
  if (!identity.success) {
    value = undefined;
    return "unread";
  }
  if (
    identity.output.ok
      ? identity.output.identity === "different"
      : identity.output.reason === "unsafe-return"
  ) {
    value = undefined;
    return "refused";
  }
  if (!identity.output.ok) {
    value = undefined;
    return "unread";
  }
  const who = identity.output.identity;
  if (!(await ssoScope(rt, work, live))) {
    value = undefined;
    return "unscoped";
  }
  const reading = v.safeParse(
    stateResultSchema,
    await send(rt, live, {
      type: "login.state",
      ...(value ? { account: { username: value } } : {}),
      loadWithinMs: 10_000,
    }).catch(() => undefined),
  );
  value = undefined;
  if (!reading.success || !reading.output.ok) return "unread";
  if (!reading.output.loaded) return "loading";
  if (!(await ssoScope(rt, work, live))) return "unscoped";
  const signs = reading.output.signs;
  // A sign-in form is the site's sign-in again. Its invalid marks and alert are read only
  // after a submission in the same document, never on a return page.
  if (signs.password) return "refused";
  // After the IdP, a code or CAPTCHA page of the RP proves nothing the flow can confirm.
  if (signs.code || signs.captcha) return instant ? (signs.code ? "code" : "captcha") : "refused";
  const own = work.recipe?.sso.layouts.find((entry) => entry.key === work.layout);
  for (const entry of own?.entries ?? []) {
    // oxlint-disable-next-line no-await-in-loop -- any original entry still shown prevents completion
    const shown = await ssoEntryShown(rt, live, entry.target);
    // Only an entry read as shown is a refusal; an unread page, often one moving on, waits.
    if (shown !== false) return shown === true ? "refused" : "unread";
  }
  // The RP's own markers, those learned on the page's origin first: a return to another
  // origin of the RP's site shows the ones its native login learned there (ADR 0026,
  // amendment of 2026-11-20).
  const marker = await showsMarkers(
    rt,
    live,
    await returnMarkerProofs(rt, work.account.origin, live.document.origin),
  );
  if (who === "match" || marker || (await ssoMarkerShown(rt, work, live)))
    return check
      ? "evidence"
      : (await completeSso(rt, work, live, instant))
        ? "completed"
        : "incomplete";
  // Before the IdP (`instant`), a page without evidence is the RP's own way to its IdP, as
  // one asking for the work email to find the provider, and waits.
  if (instant) return "no-evidence";
  // After it, a page without evidence that asks for an account identifier is the site's
  // sign-in again, as one asking for the email first (ADR 0026, amendment of 2026-11-20).
  // The page ends the flow only while it is still the one read: one that moved on meanwhile,
  // as a callback replacing itself while it is described, is read again where it went.
  const unconfirmed = async () => ((await ssoScope(rt, work, live)) ? "refused" : "unscoped");
  const shown = await asksSignIn(rt, live);
  if (!shown) return "unread";
  if (shown.asks) return unconfirmed();
  // A page that shows no text yet, as a portal still rendering in place, is read again
  // once it describes something. Any other page that proves nothing ends the flow once no
  // judge can confirm it: none is asked, or the judge answered for this page and path.
  if (shown.blank) {
    if (!check) watchReturn(rt, work, live);
    return "unobserved";
  }
  if (work.judged === judgedKey(live) || !work.recipe || !work.layout || !rt.generation?.judgeSso)
    return unconfirmed();
  const page = await ssoObservation(rt, live);
  if (!page) return unconfirmed();
  const rp = await username(rt, work, live, false);
  const idp = await username(rt, work, live, true);
  const hidden = hideUsernames(
    rt,
    page,
    rp !== undefined && idp !== undefined ? [rp, idp] : undefined,
    live,
  );
  if ("reason" in hidden) return unconfirmed();
  if (!(await ssoScope(rt, work, live))) return "unscoped";
  work.judged = judgedKey(live);
  const judged = await rt.generation.judgeSso(work.recipe.id, {
    version: 1,
    kind: "sso-completion",
    revision: work.recipe.revision,
    layout: work.layout,
    observation: hidden.observation,
  });
  // Any answer but `signed-in`, as `rejected`, `unclear` or a page it never judges, ends it.
  if (!judged.signedIn) return unconfirmed();
  if (judged.recipe) {
    work.recipe = judged.recipe;
    if (work.parent)
      work.parent = parseAttemptMetadata({
        ...work.parent,
        recipeRevision: judged.recipe.revision,
      });
  }
  // The page is read again with the learned marker, as a fresh return: its own evidence
  // completes it, and anything else ends the flow, as the judge is not asked again on this
  // document and path.
  return returned(rt, work, live, instant, check);
}
/** The RP page the RP-return judge is asked about once: its document and path. */
const judgedKey = (live: LiveDocument) => `${live.document.documentId} ${live.path}`;
/** Whether the flow completed, read again after an await that may have completed it. */
export const signedIn = (work: SsoWork) => work.parent?.state === "authenticated";
