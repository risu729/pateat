import { SSO_INTERRUPTED_HOLD_MS, type SsoWork } from "../sso-state";
import type { AdmitContext } from "../admit-context";
import type { Runtime } from "../state";

/**
 * Whether an ended flow may have spent its entry: a click intent was made durable or
 * pressed, or the tab already reached the IdP. A flow that stopped before that, as when
 * preparing its entry failed, pressed nothing, so it leaves no hold.
 */
const mayHaveSpent = (work: SsoWork) =>
  work.phase === "at-idp" ||
  work.phase === "returning-rp" ||
  (work.operation !== undefined && work.operation.stage !== "prepared");

/** Holds the tab's RP and IdP origins after a flow ended unconfirmed and may have clicked. */
export function holdInterrupted(rt: Runtime, tabId: number, work: SsoWork): void {
  if (work.parent?.state === "authenticated" || !mayHaveSpent(work)) return;
  rt.sso.interrupted.delete(tabId);
  rt.sso.interrupted.set(tabId, {
    id: work.id,
    document: work.rpLive.document,
    account: work.account,
    idp: { ...work.selected.account, origin: work.selected.origin },
    method: work.source.method.number,
    sourceEvidence: work.source.sourceEvidence,
    phase: work.phase,
    at: Date.now(),
  });
}

/**
 * Ends a tab's interrupted hold once the tab's top document is on another origin than the
 * flow's RP and IdP, or once the hold has run its time. Returns whether one was ended.
 */
export function releaseInterrupted(rt: Runtime, tabId: number, topOrigin?: string): boolean {
  const held = rt.sso.interrupted.get(tabId);
  if (
    !held ||
    (Date.now() - (held.at ?? 0) < SSO_INTERRUPTED_HOLD_MS &&
      (topOrigin === undefined || [held.account.origin, held.idp.origin].includes(topOrigin)))
  )
    return false;
  rt.sso.interrupted.delete(tabId);
  void rt.sso.write().catch(() => undefined);
  return true;
}

/**
 * An interrupted flow is never replayed: until its hold ends, an automatic login on its
 * RP or IdP origin in that tab waits for the person. Other origins are not held.
 */
export async function interruptedAdmit(rt: Runtime, ctx: AdmitContext) {
  const { tabId, frameId, origin } = ctx.document;
  releaseInterrupted(rt, tabId, frameId === 0 ? origin : undefined);
  const held = rt.sso.interrupted.get(tabId);
  if (!held || ![held.account.origin, held.idp.origin].includes(origin)) return undefined;
  if (ctx.manual || rt.picked.get(tabId)?.documentId === ctx.document.documentId) {
    rt.sso.interrupted.delete(tabId);
    await rt.sso.write();
    return undefined;
  }
  return ctx.refuse("sso-interrupted");
}
