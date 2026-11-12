import * as v from "valibot";
import { confirmBusy } from "./confirm-state";
import { sameLoginDocument, type LoginAttemptMetadata } from "@pateat/contracts";
import { browser } from "wxt/browser";
import {
  manualStartRequestSchema,
  type ManualOfferResponse,
  type ManualStartResponse,
} from "../manual-wire";
import { frameKey, recordKey, logCode, siteOf } from "./steps";
import { siteCandidates } from "./choice-save";
import { clearChoice } from "./choice";
import { manualHeldElsewhere, tabAttempt, recordFor } from "./hold";
import { terminal, passiveFillWaiting } from "./attempt-state";
import { forget } from "./session-store";
import { MANUAL_START_MS, endManual, type ManualStart } from "./manual-scope";
import type { LiveDocument } from "./types";
import type { Runtime } from "./state";

const preparing = (request: ManualStart | undefined) => request?.pick !== undefined;
const passiveRetryable = (rt: Runtime, live: LiveDocument, record: LoginAttemptMetadata) =>
  sameLoginDocument(record.document, live.document) &&
  passiveFillWaiting(record, rt.attempts.get(live.document.tabId)) &&
  !rt.continuations.has(record.id) &&
  rt.passkeyPages.get(live.document.tabId)?.attemptId !== record.id &&
  !rt.options.passkeyActive?.(live.document.documentId);
const retryable = (rt: Runtime, live: LiveDocument, record: LoginAttemptMetadata) =>
  terminal(record) ||
  (record.state === "reconciling" && record.settled === true) ||
  passiveRetryable(rt, live, record);

/** A fingerprint carries no URL, and makes a same-document navigation invalidate an offer. */
async function fingerprint(rt: Runtime, live: LiveDocument): Promise<string> {
  const top = rt.documents.get(frameKey({ tabId: live.document.tabId, frameId: 0 }));
  const bytes = new TextEncoder().encode(
    JSON.stringify([
      live.document,
      live.url,
      live.path,
      live.topUrl,
      top?.document.documentId,
      top?.url,
    ]),
  );
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function pageRefusal(rt: Runtime, live: LiveDocument): Promise<string | undefined> {
  if (rt.documents.get(frameKey(live.document)) !== live) return "page-changed";
  const tab = await browser.tabs.get(live.document.tabId).catch(() => undefined);
  if (!tab?.url || tab.url !== (live.topUrl ?? live.url)) return "page-changed";
  const urls = [live.url, ...(live.topUrl ? [live.topUrl] : [])];
  const admissions = await Promise.all(
    urls.map((url) => rt.sites?.admission(new URL(url)).catch(() => "settings-unavailable")),
  );
  const refusal = admissions.find((admission) => admission !== "admitted");
  if (admissions.some((admission) => admission !== "admitted")) return refusal ?? "no-site-access";
  const switching = await rt.accountPicks.switchFor(
    live.document.tabId,
    siteOf(live.document.origin),
    live.incognito === true,
  );
  if (switching) return "login-running";
  return rt.documents.get(frameKey(live.document)) === live ? undefined : "page-changed";
}

function attemptRefusal(rt: Runtime, live: LiveDocument): string | undefined {
  if (confirmBusy(rt, live.document.tabId)) return "login-running";
  const running = rt.attempts.get(live.document.tabId);
  if (
    rt.options.passkeyActive?.(live.document.documentId) ||
    (running?.running && !passiveRetryable(rt, live, running.metadata))
  )
    return "login-running";
  if (
    rt.switchesRunning.has(live.document.tabId) ||
    rt.accountPicks.switchingHere(live.document.tabId, siteOf(live.document.origin), live.incognito)
  )
    return "login-running";
  const record = tabAttempt(rt, live.document.tabId);
  if (
    record &&
    !terminal(record) &&
    (record.account.origin !== live.document.origin || !retryable(rt, live, record))
  )
    return "login-running";
  const own = recordFor(rt, live.document.tabId, live.document.origin);
  if (own && !retryable(rt, live, own))
    return own.state === "authenticated" ? "already-signed-in" : "login-running";
  return manualHeldElsewhere(rt, live.document.tabId, live.document.origin)
    ? "origin-busy"
    : undefined;
}

/** Lists only live, admitted documents and completely evaluated, eligible URI matches. */
export async function manualOffer(rt: Runtime, tabId: number): Promise<ManualOfferResponse> {
  await rt.vars.loaded;
  await rt.vars.sessionLoaded;
  const tab = await browser.tabs.get(tabId).catch(() => undefined);
  if (!tab?.url || !/^https?:/.test(tab.url)) return { ok: false, reason: "no-page" };
  const snapshot = await rt.settings
    .handle({ version: 1, type: "settings.get" })
    .catch(() => undefined);
  const request = rt.manualStarts.get(tabId);
  if (request?.pick && Date.now() >= request.expiresAt) endManual(rt, tabId, "timed-out", request);
  if (request?.pick && tab.url !== request.topUrl) endManual(rt, tabId, "page-changed", request);
  if (request?.pick) return { ok: true, targets: [], status: request.status };
  const targets: Extract<ManualOfferResponse, { ok: true }>["targets"] = [];
  let reason = snapshot?.ok ? undefined : "settings-unavailable";
  if (snapshot?.ok) {
    // The top page is first. A popup choice's frame follows it, before any other frames.
    const waiting = rt.pending.get(tabId)?.document;
    const pages = [...rt.documents.values()]
      .filter((live) => live.document.tabId === tabId)
      .sort(
        (a, b) =>
          Number(b.document.frameId === 0) - Number(a.document.frameId === 0) ||
          Number(waiting && sameLoginDocument(b.document, waiting)) -
            Number(waiting && sameLoginDocument(a.document, waiting)),
      );
    const offers = await Promise.all(
      pages.slice(0, 100).map(async (live) => {
        const refused = (await pageRefusal(rt, live)) ?? attemptRefusal(rt, live);
        if (refused) return { reason: refused };
        const found = rt.uris
          ? await siteCandidates(rt, snapshot, live).catch(() => ({ reason: "vault-unavailable" }))
          : { reason: "no-account" };
        if ("reason" in found) return { reason: found.reason };
        if (!found.candidates.length) return { reason: "no-account" };
        const scope = await fingerprint(rt, live);
        if (rt.documents.get(frameKey(live.document)) !== live) return { reason: "page-changed" };
        return {
          target: {
            document: live.document,
            scope,
            candidates: found.candidates
              .slice(0, 100)
              .map(({ connectionId, itemId }) => ({ connectionId, itemId })),
          },
        };
      }),
    );
    for (const offer of offers) {
      if ("target" in offer) targets.push(offer.target);
      else reason ??= offer.reason;
    }
  }
  return {
    ok: true,
    targets,
    ...(request ? { status: request.status } : {}),
    ...(!targets.length ? { reason: reason ?? "no-document" } : {}),
  };
}

/** An explicit request grants one new attempt; it never changes the site's automatic policy. */
export async function manualStart(
  rt: Runtime,
  request: v.InferOutput<typeof manualStartRequestSchema>,
): Promise<ManualStartResponse> {
  await rt.vars.loaded;
  await rt.vars.sessionLoaded;
  const { tabId } = request.document;
  if (preparing(rt.manualStarts.get(tabId))) return { ok: false, reason: "preparing" };
  const live = rt.documents.get(frameKey(request.document));
  if (!live || !sameLoginDocument(live.document, request.document))
    return { ok: false, reason: "page-changed" };
  const refuse = (reason: string): ManualStartResponse => ({ ok: false, reason: logCode(reason) });
  const refused = (await pageRefusal(rt, live)) ?? attemptRefusal(rt, live);
  if (refused) return refuse(refused);
  if ((await fingerprint(rt, live)) !== request.scope) return refuse("page-changed");
  const snapshot = await rt.settings
    .handle({ version: 1, type: "settings.get" })
    .catch(() => undefined);
  if (!snapshot?.ok) return refuse("settings-unavailable");
  const found = rt.uris
    ? await siteCandidates(rt, snapshot, live).catch(() => undefined)
    : undefined;
  if (!found || "reason" in found) return refuse(found?.reason ?? "vault-unavailable");
  if (
    !found.candidates.some(
      (entry) => entry.connectionId === request.connectionId && entry.itemId === request.itemId,
    )
  )
    return refuse("not-a-candidate");
  const changed = (await pageRefusal(rt, live)) ?? attemptRefusal(rt, live);
  if (changed) return refuse(changed);
  if ((await fingerprint(rt, live)) !== request.scope) return refuse("page-changed");
  // A late second click or a competing request must not replace a pending authorization.
  if (preparing(rt.manualStarts.get(tabId))) return refuse("preparing");
  const competing = attemptRefusal(rt, live);
  if (competing) return refuse(competing);
  const pick = {
    tabId,
    origin: live.document.origin,
    documentId: live.document.documentId,
    connectionId: request.connectionId,
    itemId: request.itemId,
    makeDefault: false,
    waitedMs: 0,
    manual: true as const,
    manualRequestId: request.requestId,
  };
  const pending: ManualStart = {
    document: live.document,
    url: live.url,
    path: live.path,
    topUrl: live.topUrl ?? live.url,
    topDocumentId: rt.documents.get(frameKey({ tabId, frameId: 0 }))?.document.documentId,
    expiresAt: Date.now() + MANUAL_START_MS,
    status: { requestId: request.requestId, state: "evaluating" },
    pick,
  };
  rt.manualStarts.set(tabId, pending);
  pending.timer = setTimeout(() => {
    if (rt.manualStarts.get(tabId) === pending && pending.pick)
      endManual(rt, tabId, "timed-out", pending);
  }, MANUAL_START_MS);
  try {
    const recorded = recordFor(rt, tabId, live.document.origin);
    if (recorded) {
      if (!retryable(rt, live, recorded)) {
        endManual(rt, tabId, "login-running", pending);
        return refuse("login-running");
      }
      const busy = attemptRefusal(rt, live);
      if (busy) {
        endManual(rt, tabId, busy, pending);
        return refuse(busy);
      }
      // Remove only the idle run before the storage write yields; an observer must not wake it meanwhile.
      if (rt.attempts.get(tabId)?.metadata.id === recorded.id) rt.attempts.delete(tabId);
      if (rt.effects.get(tabId)?.attemptId === recorded.id) rt.effects.delete(tabId);
      rt.continuations.delete(recorded.id);
      await forget(rt, recordKey(tabId, live.document.origin));
    }
    const stale = await pageRefusal(rt, live);
    if (stale || rt.manualStarts.get(tabId) !== pending) {
      endManual(rt, tabId, stale ?? "page-changed", pending);
      return refuse(stale ?? "page-changed");
    }
    const scope = await fingerprint(rt, live);
    const latest = attemptRefusal(rt, live);
    if (
      rt.manualStarts.get(tabId) !== pending ||
      pending.pick !== pick ||
      Date.now() >= pending.expiresAt ||
      scope !== request.scope ||
      latest ||
      recordFor(rt, tabId, live.document.origin) ||
      rt.documents.get(frameKey(live.document)) !== live
    ) {
      endManual(rt, tabId, latest ?? "page-changed", pending);
      return refuse(latest ?? "page-changed");
    }
    rt.picked.set(tabId, pick);
    clearChoice(rt, tabId);
    await browser.tabs.sendMessage(
      tabId,
      { version: 1, type: "login.reconnect", fresh: true },
      {
        frameId: live.document.frameId,
        documentId: live.document.documentId,
      },
    );
    await rt.admitting.get(tabId + ":" + live.document.frameId)?.catch(() => undefined);
    if (pending.status.state === "blocked") return refuse(pending.status.reason ?? "not-started");
    return { ok: true, state: pending.status.state };
  } catch {
    endManual(rt, tabId, "unavailable", pending);
    return refuse("unavailable");
  }
}
