import * as v from "valibot";
import {
  keypadStep,
  sameLoginDocument,
  validateLoginOperation,
  type LoginDocument,
} from "@pateat/contracts";
import { browser } from "wxt/browser";
import {
  authorizeSchema,
  destinationCheckSchema,
  keypadPressSchema,
  cancelSchema,
  configureSchema,
  helloSchema,
  observationSchema,
  statusSchema,
  submittedSchema,
  movedSchema,
  personSubmittedSchema,
  probeControlSchema,
} from "../wire";
import { DEMO_PROBE_ACCOUNT } from "../dummy";
import {
  choiceRequestSchema,
  pauseRequestSchema,
  pauseStateRequestSchema,
  pickRequestSchema,
  repromptRequestSchema,
  statusRequestSchema,
  switchRequestSchema,
} from "../choice-wire";
import { senderDocumentOrigin, senderPageUrl } from "../../messaging/sender";
import {
  detailFillRequestSchema,
  detailRemoveRequestSchema,
  detailRequestSchema,
} from "../detail-wire";
import { probeMode } from "./constants";
import { type Sender, type Execution } from "./types";
import { change, send, current, saveSession, report, inProgress } from "./attempt";
import { popupChoice, popupStatus, pickFor, clearChoice } from "./choice";
import {
  pauseFor,
  pauseStateFor,
  pausingSettings,
  settingsPause,
  showTabPause,
  pauseOf,
} from "./pause";
import { switchFor } from "./switch-run";
import { popupDetail, popupDetailFill, popupDetailRemove } from "./detail-popup";
import { repromptFor, dropReprompt } from "./master-password";
import { routedHere, terminal, idle } from "./attempt-state";
import { drive } from "./run-steps";
import { frameKey, choiceKey } from "./steps";
import { ready } from "./generation";
import { destinationRefusal } from "./plan";
import { allowed } from "./plan-2";
import { reviewRequests } from "./passkey";
import { quietly, scopes } from "./session-store";
import { leaveConfirm } from "./markers";
import { rejectedElsewhere, recordFor } from "./hold";
import { forgetClosedSites } from "./relogin";
import type { Runtime } from "./state";

export const probeDocument = (rt: Runtime, url: URL) =>
  probeMode &&
  url.origin === rt.vars.origin &&
  url.protocol === "http:" &&
  url.hostname === "127.0.0.1";

// The synthetic fixture embeds its frames in a page on another loopback port to test refusal.
export const probeTop = (_rt: Runtime, url: URL) =>
  probeMode && url.protocol === "http:" && url.hostname === "127.0.0.1";

export const admitted = async (rt: Runtime, url: URL) =>
  probeDocument(rt, url) ||
  (rt.sites !== undefined && (await rt.sites.admission(url)) === "admitted");

/**
 * The browser-identified document. A frame inside the page is admitted only when the
 * tab's page is admitted too; excluded sites stop it on either side (ADR 0017). A
 * document whose origin is not its URL's, such as a page the site isolates with a CSP
 * `sandbox` header or a sandboxed frame, is not the site and is refused.
 */
export async function identify(rt: Runtime, sender: Sender): Promise<LoginDocument | undefined> {
  if (
    sender.id !== browser.runtime.id ||
    sender.tab?.id === undefined ||
    sender.frameId === undefined ||
    !sender.documentId ||
    // A prerendered page also has a nonzero frame ID; it is not a frame of the tab.
    (sender as { documentLifecycle?: string }).documentLifecycle === "prerender" ||
    !sender.url ||
    senderDocumentOrigin(sender) === undefined
  )
    return undefined;
  if (sender.tab.incognito !== undefined) rt.incognitoTabs.set(sender.tab.id, sender.tab.incognito);
  try {
    const url = new URL(sender.url);
    if (!(await admitted(rt, url))) return undefined;
    if (sender.frameId !== 0) {
      // Only the top page's URL is known here, not its origin. A sandboxed top page still
      // cannot have a login filled under it: its frames inherit the sandbox, so their own
      // origin check above refuses them.
      const top = sender.tab.url ? new URL(sender.tab.url) : undefined;
      if (!top || !(probeTop(rt, top) || (await admitted(rt, top)))) return undefined;
    }
    return {
      origin: url.origin,
      tabId: sender.tab.id,
      frameId: sender.frameId,
      documentId: sender.documentId,
    };
  } catch {
    return undefined;
  }
}

export const trusted = (_rt: Runtime, sender: Sender) =>
  sender.id === browser.runtime.id &&
  senderPageUrl(sender) === browser.runtime.getURL("/options.html") &&
  !sender.tab?.url?.startsWith("http:");

export const fromPopup = (_rt: Runtime, sender: Sender) =>
  sender.id === browser.runtime.id &&
  senderPageUrl(sender) === browser.runtime.getURL("/popup.html");

export async function handle(rt: Runtime, message: unknown, sender: Sender): Promise<unknown> {
  // Probe controls are compiled into every build but answer only in the probe build.
  if (probeMode && trusted(rt, sender)) {
    const control = v.safeParse(probeControlSchema, message);
    if (control.success) {
      if (control.output.action === "release") {
        if (!rt.vars.releaseCheckpoint) return { ok: false, reason: "checkpoint-not-paused" };
        rt.vars.releaseCheckpoint();
        return { ok: true };
      }
      if (rt.vars.armed || rt.vars.checkpoint) return { ok: false, reason: "checkpoint-busy" };
      rt.vars.armed = control.output.checkpoint;
      rt.vars.armTimer = setTimeout(() => {
        rt.vars.armed = undefined;
      }, 30000);
      return { ok: true };
    }
    const config = v.safeParse(configureSchema, message);
    if (config.success) {
      await rt.vars.loaded;
      if (rt.persisted.size) return { ok: false, reason: "attempts-exist" };
      rt.vars.origin = config.output.origin;
      rt.vars.account = config.output.account ?? DEMO_PROBE_ACCOUNT;
      rt.vars.probePasskey = config.output.passkey;
      rt.vars.probeTotp = config.output.totp === true;
      rt.vars.probeStepWaitMs = config.output.stepWaitMs;
      await rt.probeConfig.write({
        origin: rt.vars.origin,
        ...(config.output.account ? { account: rt.vars.account } : {}),
        ...(rt.vars.probePasskey ? { passkey: rt.vars.probePasskey } : {}),
        ...(rt.vars.probeTotp ? { totp: true } : {}),
        ...(rt.vars.probeStepWaitMs === undefined ? {} : { stepWaitMs: rt.vars.probeStepWaitMs }),
      });
      return { ok: true };
    }
    if (v.safeParse(statusSchema, message).success) {
      await rt.vars.loaded;
      return {
        version: 1,
        ok: true,
        ...(rt.vars.checkpoint ? { checkpoint: rt.vars.checkpoint } : {}),
        attempts: [...rt.persisted.values()],
        // Tabs that ask because the site rejected their login (ADR 0021 D).
        asks: [...rt.rejectedAsks].map(() => "rejected"),
        documents: [...rt.documents.values()].map((live) => ({
          ...live.document,
          ...(live.state ? { state: live.state } : {}),
          ...(live.reason ? { reason: live.reason } : {}),
          ...(live.observations ? { observations: live.observations } : {}),
        })),
      };
    }
    const cancel = v.safeParse(cancelSchema, message);
    if (cancel.success) {
      const run = rt.attempts.get(cancel.output.tabId);
      if (!run) return { ok: false, reason: "attempt-not-found" };
      await change(rt, run, { type: "CANCEL" });
      await send(rt, run.live, { type: "login.cancel" }).catch(() => undefined);
      return { ok: true };
    }
    return undefined;
  }
  if (fromPopup(rt, sender)) {
    const ask = v.safeParse(choiceRequestSchema, message);
    if (ask.success) return popupChoice(rt, ask.output.tabId);
    const pausing = v.safeParse(pauseRequestSchema, message);
    if (pausing.success)
      return pauseFor(
        rt,
        pausing.output.tabId,
        pausing.output.paused ? pausing.output.length : undefined,
      );
    const pauseState = v.safeParse(pauseStateRequestSchema, message);
    if (pauseState.success) return pauseStateFor(rt, pauseState.output.tabId);
    const asked = v.safeParse(statusRequestSchema, message);
    if (asked.success) return popupStatus(rt, asked.output.tabId);
    const pick = v.safeParse(pickRequestSchema, message);
    if (pick.success) return pickFor(rt, pick.output);
    const switched = v.safeParse(switchRequestSchema, message);
    if (switched.success) return switchFor(rt, switched.output);
    const detail = v.safeParse(detailRequestSchema, message);
    if (detail.success) return popupDetail(rt, detail.output.tabId);
    const fill = v.safeParse(detailFillRequestSchema, message);
    if (fill.success) return popupDetailFill(rt, fill.output);
    const remove = v.safeParse(detailRemoveRequestSchema, message);
    if (remove.success) return popupDetailRemove(rt, remove.output.tabId, remove.output.detail);
    const reprompt = v.safeParse(repromptRequestSchema, message);
    if (reprompt.success) return repromptFor(rt, reprompt.output.tabId);
    return undefined;
  }
  if (v.safeParse(personSubmittedSchema, message).success) {
    // Recorded at once, before the tab's next page announces: the page's own document,
    // as the browser names it, of a page Pateat does not fill (ADR 0035).
    const visit = sender.tab?.id === undefined ? undefined : rt.confirmVisits.get(sender.tab.id);
    if (
      visit &&
      sender.id === browser.runtime.id &&
      sender.frameId === 0 &&
      sender.documentId === visit.document.documentId
    )
      visit.submitted = true;
    return undefined;
  }
  if (v.safeParse(movedSchema, message).success) {
    // A route of the document a login is watched in, or one it took while the login was
    // read, is read once (ADR 0027 amendment of 2026-10-25). The document says its path,
    // which the tab's URL may not show yet.
    const document = await identify(rt, sender);
    const run = document ? rt.attempts.get(document.tabId) : undefined;
    if (!document || document.frameId !== 0 || !run || !current(rt, run)) return undefined;
    if (!sameLoginDocument(run.live.document, document)) return undefined;
    const observed = v.safeParse(
      observationSchema,
      await send(rt, run.live, { type: "login.observe", path: run.live.path, targets: [] }).catch(
        () => undefined,
      ),
    );
    if (!observed.success || !current(rt, run)) return undefined;
    run.live.route = observed.output.path;
    if (routedHere(run)) void drive(rt, run);
    return undefined;
  }
  if (v.safeParse(submittedSchema, message).success) {
    const document = await identify(rt, sender);
    // A sign-in in a frame counts for the tab's page, whose next page is skipped.
    const page =
      document && document.frameId !== 0
        ? rt.documents.get(frameKey({ tabId: document.tabId, frameId: 0 }))?.document
        : document;
    if (page)
      rt.passwordSubmits.set(page.tabId, {
        origin: page.origin,
        documentId: page.documentId,
        at: Date.now(),
      });
    return undefined;
  }
  const hello = v.safeParse(helloSchema, message);
  if (hello.success) {
    rt.options.vault?.refreshIfStale();
    const answer = ready(
      rt,
      sender,
      hello.output.token,
      hello.output.start,
      hello.output.signIn,
      hello.output.shown,
      hello.output.list,
      hello.output.entry,
      hello.output.unoffered,
      hello.output.switched,
    );
    const tabId = sender.tab?.id;
    const { announced } = rt.options;
    if (announced && sender.frameId === 0 && tabId !== undefined && sender.url) {
      const { url } = sender;
      void answer.finally(() => announced(tabId, url)).catch(() => undefined);
    }
    return answer;
  }
  const destinationCheck = v.safeParse(destinationCheckSchema, message);
  if (destinationCheck.success) {
    const found = await operationRun(rt, destinationCheck.output, sender);
    const destination = URL.parse(destinationCheck.output.destination);
    if (
      !found ||
      !destination ||
      !validateLoginOperation(
        found.operation,
        found.run.metadata,
        found.document,
        found.run.metadata.policyRevision,
      )
    )
      return { ok: false, reason: "not-authorized" };
    const reason = await destinationRefusal(rt, found.run, destination);
    return reason ? { ok: false, reason } : { ok: true };
  }
  // Keys are pressed only while the keypad fill is the attempt's own and authorized, and
  // from then on a replaced page may be its own submission (ADR 0067).
  const keypadPress = v.safeParse(keypadPressSchema, message);
  if (keypadPress.success) {
    const found = await operationRun(rt, keypadPress.output, sender);
    if (
      !found ||
      !keypadStep(found.operation.step) ||
      !validateLoginOperation(
        found.operation,
        found.run.metadata,
        found.document,
        found.run.metadata.policyRevision,
      )
    )
      return false;
    rt.keypadPresses.set(found.run.metadata.id, {
      operationId: found.operation.operationId,
      stepIndex: found.operation.stepIndex,
    });
    return true;
  }
  const authorization = v.safeParse(authorizeSchema, message);
  if (!authorization.success) return undefined;
  const found = await operationRun(rt, authorization.output, sender);
  if (!found) return false;
  return validateLoginOperation(
    found.operation,
    found.run.metadata,
    found.document,
    found.run.metadata.policyRevision,
  );
}

/**
 * The attempt whose current operation the sender's document asks about, while that
 * document still holds it and the settings still allow it; a frame's attempt holds only
 * while the tab still shows the page it matched.
 */
export async function operationRun(
  rt: Runtime,
  request: { token: string; attemptId: string; operationId: string },
  sender: Sender,
): Promise<
  | { run: Execution; operation: NonNullable<Execution["operation"]>; document: LoginDocument }
  | undefined
> {
  const document = await identify(rt, sender);
  if (!document) return undefined;
  const run = rt.attempts.get(document.tabId);
  const operation = run?.operation;
  if (
    !run ||
    !operation ||
    !current(rt, run) ||
    run.live.token !== request.token ||
    run.metadata.id !== request.attemptId ||
    operation.operationId !== request.operationId ||
    !sameLoginDocument(run.live.document, document) ||
    (run.live.topUrl !== undefined &&
      (!sender.tab?.url || new URL(sender.tab.url).origin !== new URL(run.live.topUrl).origin))
  )
    return undefined;
  if (!(await allowed(rt, run))) return undefined;
  return { run, operation, document };
}

/**
 * Settings were synced from the service or saved locally: stops every running login but
 * a watched one, which only reads, so it is checked against the new settings instead and
 * stops only when they no longer plan its account (ADR 0027).
 */
export function settingsChanged(rt: Runtime, source: "synced" | "saved"): void {
  const stopped = new Set<number>();
  for (const run of rt.attempts.values()) {
    if (terminal(run.metadata)) continue;
    if (run.metadata.watch !== undefined) {
      void allowed(rt, run).catch(() => undefined);
      continue;
    }
    stopped.add(run.live.document.tabId);
    // Stop in-flight DOM waits promptly; the journal write may be slower.
    void send(rt, run.live, { type: "login.cancel" }).catch(() => undefined);
    void change(
      rt,
      run,
      { type: "POLICY_CHANGED" },
      { cause: source === "synced" ? "settings-synced" : "settings-saved" },
    ).catch(() => undefined);
  }
  // A site default saved for a page's origin ends its popup choice (ADR 0034).
  void choiceDefaults(rt);
  void rulesChanged(rt, stopped).catch(() => undefined);
}

/**
 * Applies changed pausing settings, exclusion rules or automatic login in private
 * windows, as the popup's pause and resume apply a pause (ADR 0062): every tab's badge
 * shows its page's pause, waiting conditional passkey requests of a page the settings now
 * pause go to the browser, and the tabs of a login that the settings change stopped on
 * such a page announce again, so they ask as paused pages. A page refused as paused, or a
 * choice offered because of a pause, that only the old settings paused announces again,
 * so it logs in at once; one a running pause still covers stays.
 */
export async function rulesChanged(rt: Runtime, stopped: ReadonlySet<number>): Promise<void> {
  await rt.vars.sessionLoaded;
  await rt.vars.policyRead;
  const after = await pausingSettings(rt);
  if (!after) return;
  const before = rt.vars.appliedPolicy;
  rt.vars.appliedPolicy = after;
  if (before !== undefined && JSON.stringify(before) === JSON.stringify(after)) return;
  const was = (page: {
    url: string;
    topUrl?: string | undefined;
    incognito?: boolean | undefined;
  }) => settingsPause(rt, before, page) !== undefined;
  const tabs = await browser.tabs.query({}).catch(() => []);
  await Promise.all(tabs.map((tab) => showTabPause(rt, tab).catch(() => undefined)));
  const incognitoOf = new Map(tabs.map((tab) => [tab.id, tab.incognito]));
  const announce = new Set<number>();
  for (const parked of [...rt.parkedRequests])
    if (
      settingsPause(rt, after, {
        url: parked.origin,
        incognito: parked.incognito ?? incognitoOf.get(parked.tabId),
      })
    )
      parked.settle({ kind: "delegate", reason: "paused" });
  reviewRequests(rt);
  for (const live of rt.documents.values()) {
    // eslint-disable-next-line no-await-in-loop
    const now = await pauseOf(rt, live);
    if (now && stopped.has(live.document.tabId)) announce.add(live.document.tabId);
    else if (!now && live.reason === "paused" && was(live)) announce.add(live.document.tabId);
  }
  for (const [tabId, waiting] of [...rt.pending]) {
    if (!waiting.paused) continue;
    const live = rt.documents.get(frameKey(waiting.document));
    const page = live ?? { url: waiting.document.origin, incognito: incognitoOf.get(tabId) };
    // eslint-disable-next-line no-await-in-loop
    if (!(await pauseOf(rt, page)) && was(page) && rt.pending.get(tabId) === waiting) {
      clearChoice(rt, tabId);
      announce.add(tabId);
    }
  }
  for (const id of announce)
    void browser.tabs
      .sendMessage(id, { version: 1, type: "login.reconnect" })
      .catch(() => undefined);
}

/**
 * Ends each popup choice whose origin has a site default by now, so the page's own
 * conditional request no longer waits for a pick (ADR 0034): after settings are saved or
 * synced, after a pick saves its account, and before a choice is checked.
 */
export async function choiceDefaults(rt: Runtime): Promise<void> {
  if (!rt.choicePasskeys.size) return;
  const snapshot = await rt.settings
    .handle({ version: 1, type: "settings.get" })
    .catch(() => undefined);
  if (!snapshot?.ok) return;
  let ended = false;
  for (const [tabId, entry] of rt.choicePasskeys) {
    const waiting = rt.pending.get(tabId);
    if (
      waiting &&
      !entry.defaulted &&
      entry.key === choiceKey(waiting) &&
      snapshot.snapshot.settings.siteDefaults.some(
        (saved) => saved.origin === waiting.document.origin,
      )
    ) {
      entry.defaulted = true;
      ended = true;
    }
  }
  if (ended) reviewRequests(rt);
}

/**
 * The last incognito window closed: the browser dropped that session, so what Pateat kept
 * for it ends too (ADR 0062, ADR 0063): its pauses, its sites that ask every time, its
 * switch picks and its relogin counts. A later incognito window starts afresh.
 */
export async function incognitoClosed(rt: Runtime): Promise<void> {
  const windows = await browser.windows.getAll().catch(() => undefined);
  if (!windows || windows.some((window) => window.incognito)) return;
  await rt.vars.sessionLoaded;
  let changed = false;
  for (const [key, entry] of rt.relogins)
    if (entry.incognito) {
      rt.relogins.delete(key);
      changed = true;
    }
  if (changed) void quietly(rt, () => saveSession(rt));
  await Promise.all([
    rt.pauses.clearIncognito().catch(() => undefined),
    rt.accountPicks.forgetIncognito().catch(() => undefined),
  ]);
}

/** Forgets a closed tab, or the gone page of a replaced one. */
export function forgetTab(rt: Runtime, tabId: number): void {
  rt.switchStates.delete(tabId);
  void rt.accountPicks.endSwitch(tabId);
  const visit = rt.confirmVisits.get(tabId);
  if (visit) leaveConfirm(rt, visit);
  dropReprompt(rt, tabId);
  rt.passwordSubmits.delete(tabId);
  rt.passwordFills.delete(tabId);
  rt.afterSignIn.delete(tabId);
  for (const key of rt.hellos.keys()) if (key.startsWith(`${tabId}:`)) rt.hellos.delete(key);
  for (const [key, live] of rt.documents)
    if (live.document.tabId === tabId) rt.documents.delete(key);
  const closed = rt.attempts.get(tabId);
  if (closed) rt.continuations.delete(closed.metadata.id);
  rt.attempts.delete(tabId);
  rt.effects.delete(tabId);
  rt.passkeyPages.delete(tabId);
  rt.signInUrls.delete(tabId);
  rt.choicePasskeys.delete(tabId);
  rt.popupAnswers.delete(tabId);
  clearTimeout(rt.entryTimers.get(tabId));
  rt.entryTimers.delete(tabId);
  for (const key of rt.entryRefused) if (key.startsWith(`${tabId} `)) rt.entryRefused.delete(key);
  for (const map of [rt.passkeyRequests, rt.passkeyAnswers])
    for (const key of map.keys()) if (key.startsWith(`${tabId} `)) map.delete(key);
  void rt.vars.sessionLoaded.then(async () => {
    let changed = rt.pending.delete(tabId);
    if (rt.picked.delete(tabId)) changed = true;
    if (rt.detailOffers.delete(tabId)) changed = true;
    if (rt.pendingDetails.delete(tabId)) changed = true;
    // Each origin the tab asked for, logged once its asking ends, since the origin's other
    // tabs stop asking with it after a rejection and log in again (ADR 0021 D).
    const ended = new Map<string, "rejected" | "stopped-login">();
    for (const { origin: asked } of scopes(rt, rt.rejectedAsks).filter(
      (entry) => entry.tabId === tabId,
    ))
      ended.set(asked, "rejected");
    for (const { origin: asked } of scopes(rt, rt.stoppedAsks).filter(
      (entry) => entry.tabId === tabId,
    ))
      if (!ended.has(asked)) ended.set(asked, "stopped-login");
    for (const keys of [rt.stoppedAsks, rt.rejectedAsks])
      for (const key of keys)
        if (key.startsWith(`${tabId} `)) changed = keys.delete(key) || changed;
    for (const [asked, ask] of ended)
      report(
        rt,
        { frameId: 0 },
        {
          type: "ask-ended",
          tabId,
          origin: asked,
          ask,
          cause: "tab-closed",
          ...(rejectedElsewhere(rt, tabId, asked) ? { elsewhere: true as const } : {}),
        },
      );
    for (const key of rt.askFills)
      if (key.startsWith(`${tabId} `)) changed = rt.askFills.delete(key) || changed;
    if (rt.entryPresses.delete(tabId)) changed = true;
    // A site's re-logins count until all of its tabs closed (ADR 0062).
    if (rt.relogins.size && (await forgetClosedSites(rt))) changed = true;
    for (const key of rt.noted.keys())
      if (key.startsWith(`${tabId} `)) changed = rt.noted.delete(key) || changed;
    // Kept until here, so `elsewhere` above compares the closed tab's window.
    rt.incognitoTabs.delete(tabId);
    if (changed) await quietly(rt, () => saveSession(rt));
    return undefined;
  });
  rt.vars.storageQueue = rt.vars.storageQueue
    .then(async () => {
      await rt.vars.loaded;
      for (const [key, metadata] of rt.persisted)
        if (metadata.document.tabId === tabId) rt.persisted.delete(key);
      await rt.attemptRecords.write([...rt.persisted.values()]);
      return undefined;
    })
    .catch(() => {
      rt.vars.storageHealthy = false;
    });
}

/**
 * Whether a login is in progress; a policy write now would stop it. An attempt between
 * pages has no current document, so its saved state counts too, once it is loaded;
 * a settled one counts only as `inProgress` says.
 */
export async function active(rt: Runtime): Promise<boolean> {
  await rt.vars.loaded;
  return (
    rt.attempts.values().some((run: Execution) => inProgress(rt, run)) ||
    rt.persisted.values().some((metadata) => !terminal(metadata) && !idle(metadata))
  );
}

/**
 * The vault item of the login a tab is running on an origin. The passkey bridge answers
 * that login's requests with this item only (ADR 0027). A login runs while its record,
 * in memory or read back from storage after a worker restart, is neither authenticated
 * nor blocked, its result has not settled as unknown since it last moved on, and it is
 * not watched (ADR 0027).
 */
export async function loginAccount(
  rt: Runtime,
  tabId: number,
  siteOrigin: string,
): Promise<{ connectionId: string; itemId: string } | undefined> {
  await rt.vars.loaded;
  const metadata = recordFor(rt, tabId, siteOrigin);
  return metadata && !terminal(metadata) && !idle(metadata)
    ? { connectionId: metadata.account.connectionId, itemId: metadata.account.itemId }
    : undefined;
}
