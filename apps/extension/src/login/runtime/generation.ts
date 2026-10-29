import * as v from "valibot";
import {
  recipeBranch,
  type LoginDocument,
  type LoginObservation,
  type LoginChooserRecipe,
} from "@pateat/contracts";
import { browser } from "wxt/browser";
import {
  entryCheckResultSchema,
  extractResultSchema,
  START_TRIES,
  START_TRY_WINDOW_MS,
} from "../wire";
import { observedPath } from "../../observation/path";
import {
  type LiveDocument,
  type GenerationScope,
  type Sender,
  type Readiness,
  type Shown,
  type ListOffer,
  type Announced,
  type Unoffered,
} from "./types";
import { report, send, spinning, spendBefore, saveSession } from "./attempt";
import { terminal } from "./attempt-state";
import { type GenerationOutcome } from "./report";
import { frameKey, logCode, acceptedObservation, asksAccount, outcomeFields } from "./steps";
import { EXTRACT_READS, EXTRACT_RETRY_MS, probeMode, CHOICE_SAVED } from "./constants";
import { readUsernames, usernameShape, signedInHint, hideUsernames } from "./markers";
import { usernameReads, customSlots, pausedMeanwhile } from "./generation-scope";
import { tabAttempt } from "./hold";
import { DocumentGone } from "./document-gone";
import { quietly } from "./session-store";
import { admit } from "./admit";
import type { Runtime } from "./state";

/** Logs once per document and reason why it was not sent for generation. */
export function skipGeneration(
  rt: Runtime,
  live: LiveDocument,
  reason: string,
  page?: "entry" | "other" | "repair",
  /** A code that tells more, such as why a vault could not tell (ADR 0019). */
  detail?: string,
): void {
  if (live.generationSkip === reason) return;
  live.generationSkip = reason;
  report(rt, live.document, {
    type: "generation",
    tabId: live.document.tabId,
    origin: live.document.origin,
    outcome: "skipped",
    reason,
    ...(page ? { page } : {}),
    ...(detail ? { detail } : {}),
  });
}

/** Whether a login of the recipe runs, or is watched, in any tab (ADR 0058 A). */
export function recipeInUse(rt: Runtime, recipeId: string): boolean {
  return [...rt.persisted.values(), ...[...rt.attempts.values()].map((run) => run.metadata)].some(
    (metadata) =>
      metadata.recipeId === recipeId && (!terminal(metadata) || metadata.watch !== undefined),
  );
}

/**
 * Sends this page's observation for generation. A returned recipe is in the recipe
 * cache by then; the document announces again and starts it once its first step is
 * ready (ADR 0018).
 */
export async function generateFor(
  rt: Runtime,
  live: LiveDocument,
  scope: GenerationScope,
  /** For a list of accounts (ADR 0028): the shown texts to hide as `[account]`. */
  list?: { names: string[] },
  /**
   * A chooser without an `other` branch whose path shows a form instead of its list: the
   * page is sent as that branch's first page (ADR 0028).
   */
  otherless?: LoginChooserRecipe,
  passkeyOnly = false,
  /**
   * For a stale recipe's page (ADR 0041): the revision it repairs, for a later
   * step's page the layout and the step that did not show, and what to call with the
   * answer once one came.
   */
  repair?: {
    recipeId: string;
    revision: number;
    later?: { layout: string; step: number };
    done(outcome: GenerationOutcome): void;
  },
): Promise<void> {
  if (!rt.generation) return;
  // A chooser's `other` branch is named by its layout (ADR 0060); only the probe build's
  // choosers have none, and their pages are never offered.
  if (otherless && otherless.layout === undefined) return;
  const base = otherless && { recipeId: otherless.id, revision: otherless.revision };
  const otherBranch = otherless?.layout && recipeBranch(otherless.layout, "other");
  // The page kind a skipped page is logged with.
  const skipPage = otherless ? ("other" as const) : repair && ("repair" as const);
  const key = frameKey(live.document);
  let sent = false;
  try {
    let observation: LoginObservation | undefined;
    // A page that renders its form in steps or fades it in may offer itself before the
    // form is whole or opaque, so a page that cannot be described yet is read again
    // (Vpass, 2026-10-12; Microsoft Entra, 2026-10-17).
    for (let read = 1; ; read += 1) {
      const extracted = v.safeParse(
        extractResultSchema,
        // eslint-disable-next-line no-await-in-loop
        await send(
          rt,
          live,
          list
            ? {
                type: "login.extract",
                page: "accounts",
                ...(list.names.length ? { names: list.names } : {}),
              }
            : { type: "login.extract", page: passkeyOnly ? "passkey" : "login" },
        ),
      );
      if (rt.documents.get(key) !== live) return;
      // The content script's refusal, such as `no-locator` or `extract-error`;
      // `extract-failed` for an answer that fails its check or never came.
      let unsent =
        extracted.success && !extracted.output.ok ? extracted.output.reason : "extract-failed";
      // Why a described page is not sent, for the log (ADR 0019).
      let detail: string | undefined =
        extracted.success && !extracted.output.ok && extracted.output.detail
          ? logCode(extracted.output.detail)
          : undefined;
      if (extracted.success && extracted.output.ok) {
        // An incomplete observation is not sent (ADR 0016). A list is sent as one, and
        // only a page announced as one is.
        const accepted = acceptedObservation(extracted.output, {
          origin: live.document.origin,
          path: live.path,
          list: list !== undefined,
        });
        if ("observation" in accepted) {
          observation = accepted.observation;
          break;
        }
        unsent = "incomplete-observation";
        detail = accepted.detail;
      }
      // A page offered as a list of accounts or a passkey button before its form rendered,
      // as x.com's sign-in while it loads (2026-10-23), may show a sign-in form instead by
      // now: it is sent as a sign-in page, only when it shows an input the document would
      // have offered as one (ADR 0016), never for a search or newsletter field alone.
      const shows =
        unsent === "no-candidates" && (list || passkeyOnly)
          ? v.safeParse(
              entryCheckResultSchema,
              // eslint-disable-next-line no-await-in-loop
              await send(rt, live, { type: "login.entry.check", starts: [], timeoutMs: 0 }).catch(
                () => undefined,
              ),
            )
          : undefined;
      if (rt.documents.get(key) !== live) return;
      if (shows?.success && shows.output.signIn) {
        const signIn = v.safeParse(
          extractResultSchema,
          // eslint-disable-next-line no-await-in-loop
          await send(rt, live, { type: "login.extract", page: "login" }),
        );
        if (rt.documents.get(key) !== live) return;
        const accepted =
          signIn.success && signIn.output.ok
            ? acceptedObservation(signIn.output, {
                origin: live.document.origin,
                path: live.path,
                list: false,
              })
            : undefined;
        if (accepted && "observation" in accepted) {
          observation = accepted.observation;
          list = undefined;
          passkeyOnly = false;
          break;
        }
      }
      if (unsent === "cancelled" || read >= EXTRACT_READS) {
        skipGeneration(rt, live, unsent, skipPage, detail);
        return;
      }
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => setTimeout(resolve, EXTRACT_RETRY_MS));
      if (rt.documents.get(key) !== live) return;
    }
    const page = list
      ? ({ page: "accounts" } as const)
      : base
        ? ({ page: "other", recipeId: base.recipeId, baseRevision: base.revision } as const)
        : repair
          ? ({
              page: "repair",
              recipeId: repair.recipeId,
              baseRevision: repair.revision,
            } as const)
          : {};
    // The `other` branch's first page asks for the account. A form without such a field,
    // as the password form after the person's own click on a listed profile, belongs to
    // the account branch and is never stored as `other` (ADR 0028).
    if (otherless && !asksAccount(observation)) {
      skipGeneration(rt, live, "no-account-field", "other");
      return;
    }
    const usernames = await readUsernames(rt, live.document.origin, usernameReads(rt, scope));
    const shape = usernames && usernameShape(rt, scope, usernames);
    // A recipe's first page carries whether it shows the person signed in, read before
    // the usernames are dropped; a list, a chooser's branch and a later step's repair carry
    // none (ADR 0035).
    const signedIn =
      list || base || repair?.later || !usernames
        ? undefined
        : await signedInHint(rt, live, usernames);
    // The account's own usernames never reach the service.
    const hidden = hideUsernames(rt, observation, usernames, live);
    if (rt.documents.get(key) !== live) return;
    if ("reason" in hidden) {
      skipGeneration(rt, live, hidden.reason, skipPage);
      return;
    }
    // A passkey-only page fills nothing, and a list of accounts is sent without slots or
    // value shapes: no field of the vault helps tell whether it leads on to a sign-in, and
    // its branches' pages offer them (ADR 0028, owner 2026-10-23 11:48 UTC). So no custom
    // field is read for either.
    const slotless = passkeyOnly || list !== undefined;
    const custom = slotless ? [] : await customSlots(rt, live.document.origin, scope);
    if (rt.documents.get(key) !== live) return;
    if (await pausedMeanwhile(rt, live, otherless ? "other" : undefined)) return;
    const spin = spinning(rt, live.document.tabId);
    const asked = Date.now();
    const result = await rt.generation
      .generate(
        {
          version: 1,
          observation: hidden.observation,
          ...(passkeyOnly ? { passkeyOnly: true } : {}),
          ...(signedIn === undefined ? {} : { signedIn }),
          slots: slotless
            ? []
            : [
                ...scope.slots.map((slot) =>
                  slot.id === "username" && shape ? { ...slot, valueShape: shape } : slot,
                ),
                ...custom,
              ],
          ...(base && otherBranch ? { base, branch: otherBranch } : {}),
          ...(repair
            ? {
                repair: {
                  recipeId: repair.recipeId,
                  revision: repair.revision,
                  ...repair.later,
                },
              }
            : {}),
        },
        spin.sent(() =>
          report(rt, live.document, {
            type: "generation",
            tabId: live.document.tabId,
            origin: live.document.origin,
            outcome: "sent",
            ...page,
            ...(signedIn === undefined ? {} : { signedIn }),
          }),
        ),
      )
      .finally(spin.stop)
      .catch((): GenerationOutcome => ({ outcome: "failed", reason: "error" }));
    // A page not sent waited for no service.
    if (result.outcome !== "skipped") spendBefore(rt, live, Date.now() - asked, result.timing);
    sent = true;
    report(rt, live.document, {
      type: "generation",
      tabId: live.document.tabId,
      origin: live.document.origin,
      ...outcomeFields(result),
      ...page,
      ...(signedIn === undefined ? {} : { signedIn }),
    });
    repair?.done(result);
    if (result.outcome !== "recipe") return;
    // Every tab's page still tracked on this origin and path that holds no login announces
    // again and starts the recipe: this document, and one refused for want of a recipe
    // while the request was in flight, such as a page that replaced this one or the same
    // page in another tab.
    const pages = [...rt.documents.values()].filter((other) => {
      const running = tabAttempt(rt, other.document.tabId);
      return (
        other.document.frameId === 0 &&
        other.document.origin === live.document.origin &&
        other.path === live.path &&
        rt.attempts.get(other.document.tabId)?.live !== other &&
        !(running && !terminal(running))
      );
    });
    await Promise.all(
      pages.map(async (other) => {
        try {
          await browser.tabs.sendMessage(
            other.document.tabId,
            { version: 1, type: "login.reconnect" },
            { documentId: other.document.documentId, frameId: other.document.frameId },
          );
        } catch {
          // The page starts nothing until it announces again (ADR 0019). A tab that no
          // longer shows it has moved on, which is not worth more than a debug line.
          if (rt.documents.get(frameKey(other.document)) !== other) return;
          const tab = await browser.tabs.get(other.document.tabId).catch(() => undefined);
          const url = tab?.url ? new URL(tab.url) : undefined;
          const shown =
            url?.origin === other.document.origin && observedPath(url.pathname) === other.path;
          note(rt, other.document, other.url, "reconnect-failed", undefined, !shown);
        }
      }),
    );
  } catch (error) {
    // The document went away or did not answer (`unreachable`, with how), or reading the
    // vault threw; nothing was started. Only a page still tracked is worth the reason
    // (ADR 0019).
    if (!sent && rt.documents.get(key) === live)
      if (error instanceof DocumentGone)
        skipGeneration(rt, live, "unreachable", skipPage, error.reason);
      else skipGeneration(rt, live, "exception", skipPage);
  }
}

/**
 * After a refusal because no vault item matches, a vault check may bring the item from
 * another device. Once a check applied a new snapshot in time, only the refused document
 * is asked to announce again, and only while it is still that refused document.
 */
export function retryAfterSync(rt: Runtime, live: LiveDocument, reason: string): void {
  // A document replaced while the refusal was published could never be reconnected.
  if (rt.documents.get(frameKey(live.document)) !== live) return;
  let synced: Promise<boolean> | undefined;
  try {
    synced = rt.options.vault?.checkAfterMiss?.();
  } catch {
    return;
  }
  void synced
    ?.then(async (applied) => {
      if (
        !applied ||
        rt.documents.get(frameKey(live.document)) !== live ||
        live.state !== "denied" ||
        live.reason !== reason
      )
        return undefined;
      await browser.tabs.sendMessage(
        live.document.tabId,
        { version: 1, type: "login.reconnect" },
        { frameId: live.document.frameId, documentId: live.document.documentId },
      );
      return undefined;
    })
    .catch(() => undefined);
}

/**
 * Logs why Pateat did nothing on a page. The same reason again on the same page is
 * logged as a repeat (ADR 0019).
 */
export function note(
  rt: Runtime,
  document: LoginDocument,
  url: string,
  reason: string,
  detail?: string,
  unrelated?: boolean,
  candidates?: number,
): void {
  const key = `${document.tabId} ${document.documentId} ${new URL(url).pathname}`;
  const reasons = rt.noted.get(key) ?? new Set<string>();
  const id = `${reason} ${detail ?? ""}`;
  const repeat = reasons.has(id);
  reasons.add(id);
  rt.noted.delete(key);
  rt.noted.set(key, reasons);
  for (const old of rt.noted.keys()) {
    if (rt.noted.size <= 256) break;
    rt.noted.delete(old);
  }
  // Kept for the worker's next start. A repeat changes nothing worth storing, and
  // ordinary browsing logs only at debug.
  if (!repeat && !unrelated) void quietly(rt, () => saveSession(rt));
  report(rt, document, {
    type: "refused",
    tabId: document.tabId,
    origin: document.origin,
    reason,
    ...(detail ? { detail } : {}),
    ...(candidates === undefined ? {} : { candidates }),
    ...(document.frameId === 0 ? {} : { frame: true as const }),
    ...(repeat ? { repeat: true as const } : {}),
    ...(unrelated ? { unrelated: true as const } : {}),
    // The refused page's own URL, which may not be the tab's admitted page yet.
    url: document.frameId === 0 ? url : undefined,
  });
}

/**
 * Whether a page is login-related: its origin has a recipe, or it is the tab's page and a
 * login runs in the tab (ADR 0019). Other pages are ordinary browsing.
 */
export async function loginRelated(
  rt: Runtime,
  tabId: number,
  frameId: number,
  documentOrigin: string,
): Promise<boolean> {
  // A frame counts only on its own origin's recipe, as a login form embedded in the page.
  const running = frameId === 0 ? tabAttempt(rt, tabId) : undefined;
  if (running && !terminal(running)) return true;
  if (probeMode && documentOrigin === rt.vars.origin) return true;
  return (await rt.recipes.starts(documentOrigin).catch(() => [])).length > 0;
}

/**
 * Logs why the tab's own page was not admitted, such as an excluded site, when the page
 * is login-related. A frame or a prerendered page is not the tab's page.
 */
export async function noteUnadmitted(rt: Runtime, sender: Sender): Promise<void> {
  const tabId = sender.tab?.id;
  if (
    !rt.sites ||
    sender.id !== browser.runtime.id ||
    tabId === undefined ||
    sender.frameId !== 0 ||
    !sender.documentId ||
    (sender as { documentLifecycle?: string }).documentLifecycle === "prerender" ||
    !sender.url
  )
    return;
  try {
    const url = new URL(sender.url);
    const refusal = await rt.sites.admission(url);
    // A page that is not HTTP(S) never runs the content script.
    if (refusal === "admitted" || refusal === "not-web") return;
    if (!(await loginRelated(rt, tabId, 0, url.origin))) return;
    note(
      rt,
      { tabId, frameId: 0, documentId: sender.documentId, origin: url.origin },
      url.href,
      refusal,
    );
  } catch {
    // A report must never change the answer.
  }
}

export function countStartTry(
  rt: Runtime,
  sender: Sender,
  helloKey: string,
  result: Readiness,
): void {
  const key = `${helloKey}:${sender.documentId}`;
  if (
    result.reason !== "stale-document" &&
    result.reason !== "closed-tab" &&
    result.starts === undefined
  ) {
    rt.startTries.delete(key);
    return;
  }
  const now = Date.now();
  const last = rt.startTries.get(key);
  const count = last && now - last.at < START_TRY_WINDOW_MS ? last.count + 1 : 1;
  rt.startTries.delete(key);
  rt.startTries.set(key, { count, at: now });
  for (const old of rt.startTries.keys()) {
    if (rt.startTries.size <= 256) break;
    rt.startTries.delete(old);
  }
  const tabId = sender.tab?.id;
  if (
    count !== START_TRIES ||
    result.reason !== "stale-document" ||
    tabId === undefined ||
    sender.frameId === undefined ||
    !sender.documentId ||
    !sender.url
  )
    return;
  try {
    const url = new URL(sender.url);
    note(
      rt,
      { tabId, frameId: sender.frameId, documentId: sender.documentId, origin: url.origin },
      url.href,
      "stale-document",
      "gave-up",
    );
  } catch {
    // A report must never change the answer.
  }
}

export async function ready(
  rt: Runtime,
  sender: Sender,
  token: string,
  start?: { path: string },
  signIn?: { path: string; identifier?: true | undefined; passkey?: true | undefined },
  shown?: Shown,
  list?: ListOffer,
  entryHello?: Announced,
  unoffered?: Unoffered,
  switchedInPlace?: true,
): Promise<Readiness> {
  // Admission is async; a later hello from the same frame must not be overtaken by an older one.
  const helloKey = `${sender.tab?.id}:${sender.frameId}`;
  const sequence = (rt.hellos.get(helloKey) ?? 0) + 1;
  rt.hellos.set(helloKey, sequence);
  // Entered after the sequence is taken, so a hello waiting on the vault check is stale
  // once a later one from the same frame arrives (ADR 0025).
  const admission = (async () => {
    const leave = await rt.options.vault?.enter(start !== undefined);
    try {
      // A site count's job already sent delays the page; the count stops before its next.
      await rt.vars.counting?.catch(() => undefined);
      return await admitFresh(
        rt,
        sender,
        token,
        helloKey,
        sequence,
        start,
        signIn,
        shown,
        list,
        entryHello,
        unoffered,
        switchedInPlace,
      );
    } finally {
      leave?.();
    }
  })();
  rt.admitting.set(helloKey, admission);
  try {
    const result = await admission;
    if (start) countStartTry(rt, sender, helloKey, result);
    return result;
  } finally {
    if (rt.admitting.get(helloKey) === admission) rt.admitting.delete(helloKey);
  }
}

/**
 * A new login is admitted again with fresh settings when another login's account choice
 * was saved meanwhile.
 */
export async function admitFresh(
  rt: Runtime,
  sender: Sender,
  token: string,
  helloKey: string,
  sequence: number,
  start?: { path: string },
  signIn?: { path: string; identifier?: true | undefined; passkey?: true | undefined },
  shown?: Shown,
  list?: ListOffer,
  entryHello?: Announced,
  unoffered?: Unoffered,
  switchedInPlace?: true,
  tries = 0,
): Promise<Readiness> {
  const result = await admit(
    rt,
    sender,
    token,
    helloKey,
    sequence,
    start,
    signIn,
    shown,
    list,
    entryHello,
    unoffered,
    switchedInPlace,
  );
  if (result.reason !== CHOICE_SAVED) return result;
  return tries < 2
    ? admitFresh(
        rt,
        sender,
        token,
        helloKey,
        sequence,
        start,
        signIn,
        shown,
        list,
        entryHello,
        unoffered,
        switchedInPlace,
        tries + 1,
      )
    : { ok: false, reason: "stale-document" };
}

/** Resolves once no account choice is being saved. */
export async function choicesSaved(rt: Runtime): Promise<void> {
  if (!rt.savingChoices.size) return;
  await Promise.all(rt.savingChoices);
  return choicesSaved(rt);
}
