import {
  transitionLoginAttempt,
  type LoginAttemptMetadata,
  type LoginRecipe,
} from "@pateat/contracts";
import { browser } from "wxt/browser";
import { idle, siteWaitOver, terminal } from "./attempt-state";
import { reportAttempt } from "./attempt";
import { armSiteWait, keep } from "./session-store";
import { frameKey } from "./steps";
import type { Runtime } from "./state";

/** The HTTP(S) origin of a tab's URL, or undefined for any other page or none. */
const webOrigin = (url: string | undefined) => {
  if (url === undefined || !URL.canParse(url)) return undefined;
  const parsed = new URL(url);
  return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.origin : undefined;
};

/**
 * The record of a login whose wait for the site ran out at `at` (ADR 0022, amended
 * 2026-11-03), with its tab's top page at `tabUrl`. A top-level login whose tab shows a
 * page of another origin ends as that move would have, `left-origin` after a possible
 * submission, and so does one whose tab shows no web page Pateat can read (amended
 * 2026-11-04): Pateat may read every HTTP(S) page, so a tab without a URL shows
 * `about:blank` or a browser page. Any other settles as a page that proved nothing
 * would, watched from `at` when it is a top-level `password` login. Its wait for the
 * site ends at `at`.
 */
export function lapsed(
  rt: Runtime,
  metadata: LoginAttemptMetadata,
  tabUrl: string | undefined,
  at: number,
): LoginAttemptMetadata {
  const origin = webOrigin(tabUrl);
  if (metadata.document.frameId === 0 && origin === undefined)
    return transitionLoginAttempt(metadata, { type: "LEFT" }, at);
  if (
    metadata.document.frameId === 0 &&
    origin !== undefined &&
    origin !== metadata.document.origin
  ) {
    // The page there is the tab's announced top document when it is on that origin; one
    // that never announced, as when the worker stopped first, has no ID of its own, so the
    // login's last one stands for it.
    const top = rt.documents.get(
      frameKey({ tabId: metadata.document.tabId, frameId: 0 }),
    )?.document;
    return transitionLoginAttempt(
      metadata,
      {
        type: "NAVIGATED",
        document: top?.origin === origin ? top : { ...metadata.document, origin },
      },
      at,
    );
  }
  // As a page that proved nothing ends it (`unproven`): the `passkey` route and a login
  // with a stop never settle as unknown.
  const result =
    metadata.route === "passkey" || metadata.stopAt !== undefined ? "challenge" : "unknown";
  const settled = transitionLoginAttempt(metadata, { type: "OBSERVED", result }, at);
  // A login that submitted nothing goes on at its step instead, which no running step
  // decides any more: it ends `cancelled`, which does not hold the site.
  return terminal(settled) || idle(settled)
    ? settled
    : transitionLoginAttempt(metadata, { type: "CANCEL" }, at);
}

/** Logs a login ended or settled by its wait for the site running out at `at`. */
function reportLapse(
  rt: Runtime,
  before: LoginAttemptMetadata,
  after: LoginAttemptMetadata,
  recipe: LoginRecipe | undefined,
  at: number,
) {
  reportAttempt(rt, after, recipe, undefined, {
    ...(after.settled === true && before.settled !== true ? { settled: true as const } : {}),
    endedAt: at,
  });
}

/**
 * Ends each stored login whose wait for the site ran out (ADR 0022, amended 2026-11-03), at
 * the time it ran out, unless what is kept in memory still decides it: the tab's running
 * login, a page that asked for a passkey holding it, or a check of the tab's new page. Then
 * sets the alarm for the next one. Run when the site-wait alarm fires.
 */
export async function endSiteWaits(rt: Runtime): Promise<void> {
  await rt.vars.loaded;
  if (!rt.vars.storageHealthy) {
    // Nothing is ended without storage; the alarm and the worker's wake are given up.
    void Promise.try(() => rt.options.siteWait?.(undefined)).catch(() => undefined);
    rt.vars.siteWaitAt = undefined;
    return;
  }
  const latest = (stored: LoginAttemptMetadata) => {
    const run = rt.attempts.get(stored.document.tabId);
    return run?.metadata.id === stored.id ? run : undefined;
  };
  const decided = (stored: LoginAttemptMetadata) =>
    latest(stored)?.running === true ||
    // A page of the tab being admitted may resume the login.
    [...rt.admitting.keys()].some((key) => key.startsWith(`${stored.document.tabId}:`)) ||
    rt.passkeyPages.get(stored.document.tabId)?.attemptId === stored.id ||
    rt.siteMoves.has(stored.document.tabId);
  for (const [key, stored] of [...rt.persisted]) {
    const record = latest(stored)?.metadata ?? stored;
    if (siteWaitOver(record, Date.now()) === undefined || decided(stored)) continue;
    // eslint-disable-next-line no-await-in-loop
    const tabUrl = await browser.tabs.get(stored.document.tabId).then(
      (tab) => tab.url,
      () => undefined,
    );
    // The tab's pages may have moved the login on meanwhile.
    const now = rt.persisted.get(key);
    if (now?.id !== stored.id || decided(now)) continue;
    const run = latest(now);
    const before = run?.metadata ?? now;
    const at = siteWaitOver(before, Date.now());
    if (at === undefined) continue;
    const after = lapsed(rt, before, tabUrl, at);
    if (run) run.metadata = after;
    if (terminal(after) || idle(after)) rt.continuations.delete(after.id);
    reportLapse(rt, before, after, run?.recipe, at);
    // It ran out without the login moving on, so the record keeps its time (ADR 0022).
    // eslint-disable-next-line no-await-in-loop
    await keep(rt, after, false).catch(() => undefined);
  }
  armSiteWait(rt);
}

/**
 * At a worker start, before any page announces: the stored logins whose wait for the site
 * ran out while the worker was stopped, with their tabs' URLs, end as `endSiteWaits` ends
 * them. Changes `rt.persisted` only; the caller writes it.
 */
export function endLostSiteWaits(rt: Runtime, tabUrls: Map<number, string | undefined>): void {
  for (const [key, stored] of rt.persisted) {
    const at = siteWaitOver(stored, Date.now());
    if (at === undefined) continue;
    const after = lapsed(rt, stored, tabUrls.get(stored.document.tabId), at);
    reportLapse(rt, stored, after, undefined, at);
    rt.persisted.set(key, after);
  }
}
