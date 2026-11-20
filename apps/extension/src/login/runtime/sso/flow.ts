import { holdInterrupted, interruptedAdmit, releaseInterrupted } from "./interrupted";
import { ssoDependenciesKept } from "./dependencies";
import { browser } from "wxt/browser";
import * as v from "valibot";
import {
  itemAsksForMasterPassword,
  parseAttemptMetadata,
  normalizeSsoLabel,
  type SsoLayout,
  sameLoginTarget,
  sameLoginDocument,
  ssoLabelSchema,
  type LoginAttemptMetadata,
  type LoginDocument,
  type LoginObservation,
  type LoginTarget,
  type SettingsResponse,
  type LoginMethod,
} from "@pateat/contracts";
import { newId } from "@pateat/contracts/ids";
import type { SsoResolvedChoice } from "../../sso-choice";
import { ssoIdpResultSchema } from "../../sso-operation-wire";
import { send, publish, reportAttempt } from "../attempt";
import { keep, quietly } from "../session-store";
import { choiceAccount, itemMatchesUrl } from "../plan";
import { hideUsernames } from "../markers";
import { openPasswordWindow } from "../master-password";
import { openMethods, type MethodMarks } from "../methods";
import { ssoCurrent, ssoReturnOrigin, ssoScope } from "../sso-scope";
import { ssoPress } from "../sso-effects";
import { ssoChild, type SsoWork } from "../sso-state";
import { ssoObservation, inspectSsoTarget } from "./entry";
import { learnSsoEntry } from "./learned-entries";
import { detachChild, pauseNativeChild, releaseChild } from "./child";
import { SSO_FLOW_MS, ssoReturnMoved } from "./moved";
import { cancelled, returned, signedIn, username } from "./return";
import type { AdmitContext } from "../admit-context";
import type { Readiness } from "../types";
import type { Choice, Execution, LiveDocument } from "../types";
import type { Runtime } from "../state";

type Saved = Extract<SettingsResponse, { ok: true }>;
/** The layout's entry for a label, ignoring letter case; a layout holds one per label. */
const entryFor = (layout: SsoLayout, label: string) =>
  layout.entries.find((entry) => normalizeSsoLabel(entry.label) === normalizeSsoLabel(label));
export async function ssoReprompt(rt: Runtime, work: SsoWork, live: LiveDocument, idp = false) {
  const account = idp ? { ...work.selected.account, origin: work.selected.origin } : work.account;
  const connection = work.saved.catalog.connections.find(
    (entry) => entry.id === account.connectionId,
  );
  const item = connection?.items.find((entry) => entry.id === account.itemId);
  if (!connection || !item) return false;
  if (!itemAsksForMasterPassword(work.saved.snapshot.settings, item, live.url)) return true;
  if (!rt.options.askMasterPassword || !ssoCurrent(rt, work, live)) return false;
  const key = `${live.document.tabId} ${live.document.documentId}`;
  const ask =
    rt.passwordAsks.get(key) ??
    openPasswordWindow(rt, "detail", key, {
      tabId: live.document.tabId,
      origin: live.document.origin,
      account,
      connection,
      item,
    });
  const answer = await ask.answer;
  return (
    answer.answer === "verified" &&
    !answer.aborted &&
    ask.connectionId === connection.id &&
    ssoCurrent(rt, work, live)
  );
}
/**
 * Ends a tab's flow. `goesOn` names a document that goes on with its own login, such as the
 * page whose Log in now ended the flow: it gets no cancel and keeps its state.
 */
export function cancelSso(
  rt: Runtime,
  tabId: number,
  reason = "sso-cancelled",
  goesOn?: LoginDocument,
) {
  const work = rt.sso.flows.get(tabId);
  if (!work || work.ended) return;
  work.ended = true;
  work.endReason = reason;
  work.abort.abort();
  clearTimeout(work.timer);
  rt.sso.flows.delete(tabId);
  rt.sso.native.delete(tabId);
  holdInterrupted(rt, tabId, work);
  // A flow whose sign-in was already recorded ends its IdP login signed in too.
  void quietly(rt, () => releaseChild(rt, work, work.recorded === true));
  const kept = goesOn !== undefined && sameLoginDocument(work.live.document, goesOn);
  if (!kept) void send(rt, work.live, { type: "login.cancel" }).catch(() => undefined);
  void rt.sso.write().catch(() => undefined);
  if (work.parent && work.parent.state !== "authenticated") {
    const ended = cancelled(work, work.parent);
    work.parent = ended;
    void quietly(rt, async () => {
      await keep(rt, ended);
      reportAttempt(rt, ended, undefined, undefined, { reason });
    });
  }
  if (kept) return;
  work.live.state = "denied";
  work.live.reason = reason;
  void publish(rt, work.live);
}
/**
 * Whether a tab's SSO flow only waits on this RP page, so the person's **Log in now** may
 * end it (ADR 0026, ADR 0088): its entry was spent and the tab came back, or its IdP login
 * finished, and nothing is in flight. An operation being written or pressed, the flow's
 * own step and an admission of the tab's top page still under way keep the request out.
 */
export function ssoWaiting(rt: Runtime, live: LiveDocument, record: LoginAttemptMetadata) {
  const work = rt.sso.flows.get(live.document.tabId);
  return (
    work !== undefined &&
    !work.ended &&
    !work.busy &&
    work.parent?.id === record.id &&
    live.document.frameId === 0 &&
    ssoReturnOrigin(work, live.document.origin) &&
    (work.operation === undefined || work.operation.stage === "spent") &&
    ((work.phase === "entering-idp" && work.operation?.stage === "spent") ||
      work.phase === "returning-rp") &&
    !rt.admitting.has(`${live.document.tabId}:0`)
  );
}
/**
 * A vault notice or a settings change ends the flows whose own accounts, pages or rules
 * changed; a status read, another site's account choice or a sync of unrelated settings
 * keeps them, carried over to the newer settings. Each later effect checks the current
 * settings again before it acts.
 */
export async function ssoVaultChanged(
  rt: Runtime,
  reason: "sso-vault-changed" | "sso-settings-changed" = "sso-vault-changed",
): Promise<void> {
  if (rt.sso.flows.size === 0) return;
  const saved = await rt.settings
    .handle({ version: 1, type: "settings.get" })
    .catch(() => undefined);
  for (const [tabId, work] of [...rt.sso.flows]) {
    if (work.ended) continue;
    if (!saved?.ok || !ssoDependenciesKept(work, work.saved, saved)) cancelSso(rt, tabId, reason);
    else work.saved = saved;
  }
}
export async function beginSso(
  rt: Runtime,
  ctx: AdmitContext,
  saved: Saved,
  chosen: Choice,
  selection: Extract<SsoResolvedChoice, { kind: "sso" }>,
  /** `labeled`: the entry was chosen by its label alone (ADR 0085, amended 2026-11-18). */
  observed?: { target: LoginTarget; label: string; labeled?: true },
  /** What the item holds and why the chooser took this method (ADR 0055, amended 2026-11-18). */
  methods?: { held: readonly LoginMethod[]; marks: MethodMarks },
) {
  await rt.sso.loaded;
  if (
    !rt.sso.healthy() ||
    rt.sso.flows.has(ctx.document.tabId) ||
    rt.documents.get(ctx.key) !== ctx.live
  )
    return ctx.refuse("sso-scope-changed");
  const account = {
    origin: ctx.document.origin,
    connectionId: chosen.connectionId,
    itemId: chosen.itemId,
  };
  const work: SsoWork = {
    id: newId(),
    account,
    chosen,
    source: selection.source,
    selected: selection.selected,
    ...(selection.label ? { label: selection.label } : {}),
    ...(selection.entryId ? { entryId: selection.entryId } : {}),
    phase: "prepared",
    rpLive: ctx.live,
    live: ctx.live,
    saved,
    abort: new AbortController(),
    startedAt: Date.now(),
    used: new Set(),
    busy: true,
    ended: false,
  };
  rt.sso.flows.set(ctx.document.tabId, work);
  work.timer = setTimeout(() => cancelSso(rt, ctx.document.tabId, "sso-expired"), SSO_FLOW_MS);
  try {
    if (!(await ssoScope(rt, work)) || !(await ssoReprompt(rt, work, ctx.live)))
      throw new Error("sso-scope-changed");
    const described = await rt.options.sso!.describe(account);
    const method =
      described.ok &&
      described.data.methods.find((entry) => entry.method.number === work.source.method.number);
    if (!method || !described.ok || described.data.sourceEvidence !== work.source.sourceEvidence)
      throw new Error("sso-source-changed");
    work.form = method.form;
    work.reprompted = true;
    let label = selection.label ?? observed?.label;
    let target = observed?.target;
    let privatePage: LoginObservation | undefined;
    if (method.form === "url") {
      if (!observed) throw new Error("sso-entry-unresolved");
      const page = await ssoObservation(rt, ctx.live);
      if (!page) throw new Error("sso-observation-unavailable");
      const rp = await username(rt, work, ctx.live, false);
      const idp = await username(rt, work, ctx.live, true);
      const hidden = hideUsernames(
        rt,
        page,
        rp !== undefined && idp !== undefined ? [rp, idp] : undefined,
        ctx.live,
      );
      if ("reason" in hidden || !(await ssoScope(rt, work)))
        throw new Error("sso-observation-private");
      const candidates = hidden.observation.candidates.filter((candidate) =>
        sameLoginTarget(candidate.target, observed.target),
      );
      const sanitized = candidates.length === 1 && candidates[0]!.label?.trim();
      // A label holds no bracket (ADR 0085), so a redaction such as `[account]` reads
      // `(account)` in it; the description the model reads keeps its own form.
      const entryLabel = sanitized && sanitized.replaceAll(/\[([a-z]+)\]/gu, "($1)");
      if (!sanitized || !entryLabel || !v.is(ssoLabelSchema, entryLabel))
        throw new Error("sso-entry-label-private");
      const publicText = sanitized
        .replaceAll(/\[[a-z]+\]/gu, "")
        .normalize("NFKC")
        .toLowerCase();
      if (
        [rp, idp].some(
          (value) => value && publicText.includes(value.trim().normalize("NFKC").toLowerCase()),
        )
      )
        throw new Error("sso-entry-label-private");
      label = entryLabel;
      work.label = entryLabel;
      privatePage = hidden.observation;
    }
    let heads = (await rt.recipes.sso?.(account.origin, ctx.live.path)) ?? [];
    const matches = heads
      .flatMap((head) =>
        head.sso.layouts.flatMap((layout) => {
          const entry = label && entryFor(layout, label);
          return entry &&
            (method.form !== "url" || (observed && sameLoginTarget(entry.target, observed.target)))
            ? [{ head, layout, target: entry.target }]
            : [];
        }),
      )
      .sort((a, b) => b.layout.createdAt - a.layout.createdAt);
    for (const match of matches) {
      // oxlint-disable-next-line no-await-in-loop -- one currently observed layout is selected
      if (await inspectSsoTarget(rt, ctx.live, match.target)) {
        work.recipe = match.head;
        work.layout = match.layout.key;
        target = match.target;
        break;
      }
    }
    if (!work.recipe && label && rt.generation?.generateSso) {
      if (!privatePage) {
        const page = await ssoObservation(rt, ctx.live);
        if (!page) throw new Error("sso-observation-unavailable");
        const rp = await username(rt, work, ctx.live, false);
        const idp = await username(rt, work, ctx.live, true);
        const hidden = hideUsernames(
          rt,
          page,
          rp !== undefined && idp !== undefined ? [rp, idp] : undefined,
          ctx.live,
        );
        if ("reason" in hidden) throw new Error("sso-observation-private");
        privatePage = hidden.observation;
      }
      if (!(await ssoScope(rt, work))) throw new Error("sso-scope-changed");
      const generated = await rt.generation.generateSso({
        version: 1,
        kind: "sso",
        observation: privatePage,
        labels: [label],
        ...(heads.length === 1
          ? { repair: { recipeId: heads[0]!.id, revision: heads[0]!.revision } }
          : {}),
      });
      if (generated.outcome !== "recipe") throw new Error("sso-generation-refused");
      const repaired = generated.recipe.sso.layouts
        .flatMap((layout) => {
          const entry = entryFor(layout, label);
          return entry &&
            (method.form !== "url" || (observed && sameLoginTarget(entry.target, observed.target)))
            ? [{ layout, target: entry.target }]
            : [];
        })
        .sort((a, b) => b.layout.createdAt - a.layout.createdAt);
      let selected = false;
      for (const candidate of repaired) {
        // oxlint-disable-next-line no-await-in-loop -- only a currently observed repaired layout may execute
        if (await inspectSsoTarget(rt, ctx.live, candidate.target)) {
          work.recipe = generated.recipe;
          work.layout = candidate.layout.key;
          target = candidate.target;
          selected = true;
          break;
        }
      }
      if (!selected) throw new Error("sso-entry-missing");
    }
    if (!target || !work.recipe || !work.layout) throw new Error("sso-entry-unresolved");
    work.parent = parseAttemptMetadata({
      version: 1,
      id: work.id,
      recipeId: work.recipe.id,
      recipeRevision: work.recipe.revision,
      layout: work.layout,
      policyRevision: saved.snapshot.revision,
      account,
      route: "sso",
      ssoParent: true,
      facts: { password: false, totp: false, passkey: false, discoverablePasskey: false },
      handlers: [],
      document: ctx.document,
      state: "reconciling",
      stepIndex: 0,
      stepCount: 1,
      submissions: 1,
      maxSubmissions: 1,
      retries: 0,
      maxRetries: 2,
      usedOperationIds: [],
      timing: { ...ctx.live.timing, pageMs: 0 },
    });
    const owner = choiceAccount(rt, saved.catalog, chosen, account.origin);
    if (
      owner &&
      !chosen.saved &&
      chosen.source !== "site-value" &&
      (!chosen.pick || chosen.pick.makeDefault)
    )
      work.choice = {
        binding: owner,
        connectionId: chosen.connectionId,
        ...(chosen.pick?.makeDefault ? { replace: true } : {}),
      };
    if (chosen.pick) chosen.pick.attemptId = work.id;
    if (methods) openMethods(rt, work.id, methods.held, methods.marks, ["sso"]);
    work.phase = "entering-idp";
    if (method.form === "url")
      work.entry = { path: ctx.live.path, target, ...(observed?.labeled ? { labeled: true } : {}) };
    await rt.sso.write();
    if (!(await ssoPress(rt, work, ctx.live, target, "rp-entry")))
      throw new Error(work.stopReason ?? "sso-entry-stopped");
    return { ok: false as const, reason: "sso-in-progress" };
  } catch (error) {
    cancelSso(rt, ctx.document.tabId, error instanceof Error ? error.message : "sso-stopped");
    return ctx.refuse(work.live.reason ?? "sso-stopped");
  } finally {
    work.busy = false;
  }
}
/** The URL-form entry this flow pressed and is on its way through, if any. */
const pressedEntry = (work: SsoWork) =>
  work.phase === "entering-idp" && work.form === "url" ? work.entry : undefined;
/**
 * Records once that the pressed URL-form entry reached the mapped IdP: a later automatic
 * press of it on this page is for this IdP only (ADR 0085 amendment of 2026-11-18).
 */
function learnPressedEntry(work: SsoWork, entry = pressedEntry(work)) {
  if (!entry) return;
  delete work.entry;
  void learnSsoEntry(work.account.origin, entry.path, entry.target, work.selected.origin).catch(
    () => undefined,
  );
}
export async function ssoAdmit(rt: Runtime, ctx: AdmitContext): Promise<Readiness | undefined> {
  await rt.sso.loaded;
  const work = rt.sso.flows.get(ctx.document.tabId);
  if (!work) return interruptedAdmit(rt, ctx);
  // The person's own Log in now on the RP ends the flow, and the page is admitted as any
  // manual request is: an RP page never waits for a flow the person has moved past.
  if (ctx.manual && ctx.document.frameId === 0 && ssoReturnOrigin(work, ctx.document.origin)) {
    cancelSso(rt, ctx.document.tabId, "sso-manual-request", ctx.document);
    return interruptedAdmit(rt, ctx);
  }
  if (ctx.document.frameId !== 0) return ctx.refuse("sso-top-document-only");
  if (work.parent?.state === "authenticated") return ctx.refuse("sso-completed");
  if (!ssoReturnOrigin(work, ctx.document.origin) && ctx.document.origin !== work.selected.origin) {
    cancelSso(rt, ctx.document.tabId, "sso-forbidden-origin");
    return ctx.refuse("sso-forbidden-origin");
  }
  work.live = ctx.live;
  if (!(await ssoScope(rt, work))) {
    // An RP page after the IdP whose URL changed in place since it announced is asked to
    // announce again, as it now shows (ADR 0026, amendment of 2026-11-20).
    if (ssoReturnMoved(rt, ctx.document.tabId, await tabUrl(ctx.document.tabId)))
      return ctx.refuse("sso-in-progress", "rp-return:moved");
    cancelSso(rt, ctx.document.tabId, "sso-scope-changed");
    return ctx.refuse("sso-scope-changed");
  }
  if (ssoReturnOrigin(work, ctx.document.origin)) {
    const original = ctx.live.document.documentId === work.rpLive.document.documentId;
    if (work.phase === "prepared" || work.phase === "entering-idp") {
      // An IdP with an existing grant and session can send the tab straight back, so no
      // IdP page is ever admitted: once the entry was pressed, a new RP page may be the
      // return. It completes only on the page's own evidence, with no judge, and without
      // it the flow waits, as an RP page on the way to the IdP does.
      if (!original && work.phase === "entering-idp" && work.operation?.stage === "spent") {
        const pressed = pressedEntry(work);
        // An entry pressed for its label alone and never seen at the mapped origin may
        // have gone to another provider that answered by a redirect alone, as an IdP with
        // a live grant does. Where the RP's evidence would complete, it cannot tell which
        // IdP signed in, so the flow neither completes nor learns it; any other RP page,
        // as an interstitial on the way to the IdP, waits as for any press (ADR 0085,
        // amended 2026-11-18).
        const result = await returned(rt, work, ctx.live, true, pressed?.labeled);
        if (result === "evidence") {
          cancelSso(rt, ctx.document.tabId, "sso-idp-unseen");
          return ctx.refuse("sso-idp-unseen");
        }
        if (result === "completed") {
          // The IdP's own session sent the tab back without a page: the completion is
          // where the pressed entry led.
          learnPressedEntry(work, pressed);
          return { ok: false as const, reason: "sso-completed" };
        }
        // The IdP refused at once, as a failed silent sign-in or a revoked grant does: the
        // site shows its sign-in again, so the flow ends rather than waiting for nothing.
        if (result === "refused") {
          cancelSso(rt, ctx.document.tabId, "sso-return-unconfirmed");
          return ctx.refuse("sso-return-unconfirmed");
        }
        return ctx.refuse("sso-in-progress");
      }
      // Before that no RP page is the return: the original page waits while its entry is
      // pressed. A new page before anything was pressed ends the flow.
      if (original || work.phase === "entering-idp") return ctx.refuse("sso-in-progress");
      cancelSso(rt, ctx.document.tabId, "sso-page-changed");
      return ctx.refuse("sso-page-changed");
    }
    if (original) {
      // The original page shown again once the IdP was reached comes back from the
      // back/forward cache: the person left the flow.
      cancelSso(rt, ctx.document.tabId, "sso-abandoned");
      return ctx.refuse("sso-abandoned");
    }
    // One RP page is read at a time: a page that announced again meanwhile, as after its
    // URL changed in place, is read after it, as it then shows.
    if (work.reading) {
      await work.reading;
      if (signedIn(work)) return { ok: false as const, reason: "sso-completed" };
      return rt.documents.get(ctx.key) === ctx.live
        ? ssoAdmit(rt, ctx)
        : { ok: false as const, reason: "stale-document" };
    }
    work.phase = "returning-rp";
    const reading = Promise.withResolvers<void>();
    work.reading = reading.promise;
    let result: Awaited<ReturnType<typeof returned>>;
    try {
      await detachChild(rt, work);
      result = await returned(rt, work, ctx.live);
    } finally {
      delete work.reading;
      reading.resolve();
    }
    if (result === "completed") return { ok: false as const, reason: "sso-completed" };
    if (result === "refused") {
      cancelSso(rt, ctx.document.tabId, "sso-return-unconfirmed");
      return ctx.refuse("sso-return-unconfirmed");
    }
    if (result === "unscoped")
      ssoReturnMoved(rt, ctx.document.tabId, await tabUrl(ctx.document.tabId));
    // An RP page that proves nothing yet, as the RP's own callback or a page still loading
    // on the way to its signed-in page, waits for the tab's next page, as an instant return
    // does, bounded by the flow's ten minutes (ADR 0026, amendment of 2026-11-20).
    return ctx.refuse("sso-in-progress", `rp-return:${result}`);
  }
  learnPressedEntry(work);
  work.phase = "at-idp";
  const child = rt.attempts.get(ctx.document.tabId);
  if (!(await ssoReprompt(rt, work, ctx.live, true))) {
    cancelSso(rt, ctx.document.tabId, "sso-reprompt-required");
    return ctx.refuse("sso-reprompt-required");
  }
  let value = await username(rt, work, ctx.live, true);
  if (!value) {
    cancelSso(rt, ctx.document.tabId, "sso-username-unavailable");
    return ctx.refuse("sso-username-unavailable");
  }
  const parsed = v.safeParse(
    ssoIdpResultSchema,
    await send(rt, ctx.live, { type: "login.sso.idp", username: value }).catch(() => undefined),
  );
  if (!parsed.success || !(await ssoScope(rt, work))) {
    value = undefined;
    cancelSso(rt, ctx.document.tabId);
    return ctx.refuse("sso-idp-unreadable");
  }
  // The IdP's own login runs in the tab: it has not ended signed in or stopped, and it is
  // watched only for its result (ADR 0027).
  const childRuns =
    child !== undefined &&
    child.metadata.id === work.childId &&
    !["authenticated", "blocked"].includes(child.metadata.state);
  if (
    parsed.output.kind === "native" ||
    (parsed.output.kind === "unknown" && ctx.signIn?.passkey)
  ) {
    if (!work.childId || childRuns) return undefined;
  }
  if (
    parsed.output.kind === "account" ||
    parsed.output.kind === "continue" ||
    parsed.output.kind === "stay-signed-in"
  ) {
    if (!(await pauseNativeChild(rt, work))) {
      value = undefined;
      cancelSso(rt, ctx.document.tabId, "sso-native-detach-failed");
      return ctx.refuse("sso-native-detach-failed");
    }
    const pressed = await ssoPress(
      rt,
      work,
      ctx.live,
      parsed.output.target,
      `idp-${parsed.output.kind}`,
      { username: value, kind: parsed.output.kind },
    );
    value = undefined;
    if (!pressed) cancelSso(rt, ctx.document.tabId, "sso-idp-stopped");
    return { ok: false as const, reason: "sso-in-progress" };
  }
  value = undefined;
  // A page of the IdP's own origin that is neither its sign-in form nor a finite step, as a
  // risk check or a method chooser after the IdP's own submit, is that login's next page:
  // it is admitted with its record, as a direct login of the IdP goes on to its handlers
  // or its watch there (ADR 0026, amendment of 2026-11-18). An unsafe page still ends the
  // flow.
  if (parsed.output.kind === "unknown") {
    if (childRuns) return undefined;
    // Before that login began, or after it signed in, only a page that offers the person
    // nothing to choose, as an interstitial that sends the tab on by itself, waits as a
    // sign-in in progress: nothing is pressed, the flow's own time bounds it, and only the
    // RP's own evidence completes the flow. A page with its own choices, and any page
    // after that login stopped, ends it.
    const ended = child?.metadata.id === work.childId ? child?.metadata : work.childRecord;
    if (!parsed.output.controls && (!work.childId || ended?.state === "authenticated"))
      return ctx.refuse("sso-in-progress");
  }
  cancelSso(rt, ctx.document.tabId, "sso-idp-stop");
  return ctx.refuse("sso-idp-stop");
}
export function ssoChildChanged(rt: Runtime, run: Execution) {
  if (!ssoChild(rt.sso, run.metadata)) return;
  const work = rt.sso.flows.get(run.metadata.document.tabId);
  if (!work || work.childId !== run.metadata.id || work.ended) return;
  work.childRecord = run.metadata;
  // A result that settled as unknown or a challenge is watched (ADR 0027): its next IdP page
  // may enter a handler, or the IdP may send the tab back to the RP, whose own evidence
  // completes the flow. Only a login that stopped ends it (ADR 0026, amendment of
  // 2026-11-18).
  if (run.metadata.state === "blocked")
    cancelSso(rt, run.metadata.document.tabId, "sso-idp-child-stopped");
  else if (run.metadata.state === "authenticated") {
    work.phase = "returning-rp";
    void rt.sso.write().catch(() => undefined);
  }
}

const tabUrl = async (tabId: number) => (await browser.tabs.get(tabId).catch(() => undefined))?.url;
const siblingMatches = async (rt: Runtime, work: SsoWork, url: string) => {
  const matched = await itemMatchesUrl(rt, work.saved, work.account, url, work.saved.catalog).catch(
    () => undefined,
  );
  return matched !== undefined && !("reason" in matched);
};
export function installSsoLifecycle(rt: Runtime) {
  browser.tabs.onUpdated.addListener((tabId, change) => {
    const work = rt.sso.flows.get(tabId);
    const url = change.url ? URL.parse(change.url) : null;
    // A tab that went on to another site ends its interrupted hold.
    if (url) releaseInterrupted(rt, tabId, url.origin);
    if (!work || !change.url) return;
    if (!url || (!ssoReturnOrigin(work, url.origin) && url.origin !== work.selected.origin))
      cancelSso(rt, tabId, "sso-forbidden-origin");
    // An RP page waiting after the IdP that changed its URL in place is read again.
    else if (ssoReturnMoved(rt, tabId, change.url)) return;
    // The tab reached the IdP after the press, even before any IdP page is admitted.
    else if (url.origin === work.selected.origin && !work.ended) learnPressedEntry(work);
    // Another origin of the RP's site is a return only where the RP item matches it, as
    // under a Domain rule; a Host-match item's flow stops there, as on any other site.
    else if (url.origin !== work.account.origin)
      void siblingMatches(rt, work, url.href).then((matches) => {
        if (!matches && rt.sso.flows.get(tabId) === work && !work.ended)
          cancelSso(rt, tabId, "sso-forbidden-origin");
        return undefined;
      });
  });
  browser.tabs.onCreated?.addListener((tab) => {
    if (tab.openerTabId !== undefined && rt.sso.flows.has(tab.openerTabId))
      cancelSso(rt, tab.openerTabId, "sso-new-context");
  });
}
