import { parseAttemptMetadata, sameLoginDocument, transitionLoginAttempt } from "@pateat/contracts";
import { send, reportAttempt } from "../attempt";
import { terminal } from "../attempt-state";
import { keep } from "../session-store";
import { ssoChild, type SsoWork } from "../sso-state";
import type { Runtime } from "../state";

/**
 * The IdP child of an SSO flow, its native login of the IdP: detached before a finite IdP
 * step, or on the RP return, where its end waits for the flow's (ADR 0026, amendments of
 * 2026-11-18 and 2026-11-20).
 */
export async function pauseNativeChild(rt: Runtime, work: SsoWork): Promise<boolean> {
  const child = rt.attempts.get(work.rpLive.document.tabId);
  if (!child || child.metadata.id !== work.childId || !ssoChild(rt.sso, child.metadata))
    return true;
  // Withdraw background authority synchronously, before any storage or content await.
  rt.attempts.delete(work.rpLive.document.tabId);
  work.childRecord =
    child.metadata.state === "authenticated"
      ? child.metadata
      : parseAttemptMetadata({
          ...child.metadata,
          state: "blocked",
          outcome: "cancelled",
          watch: undefined,
          settled: undefined,
        });
  // The child's end is logged as any of its lines is (ADR 0026, amendment of 2026-11-18).
  if (child.metadata.state !== "authenticated")
    reportAttempt(rt, work.childRecord, child.recipe, undefined, { reason: "sso-detached" });
  const sameDocument =
    sameLoginDocument(child.live.document, work.live.document) &&
    child.live.token === work.live.token;
  const cancelled = await send(
    rt,
    child.live,
    sameDocument
      ? { type: "login.native.cancel", attemptId: child.metadata.id }
      : { type: "login.cancel" },
  ).catch(() => undefined);
  await keep(rt, work.childRecord);
  return (
    !sameDocument ||
    (cancelled !== null &&
      typeof cancelled === "object" &&
      "ok" in cancelled &&
      cancelled.ok === true)
  );
}
/**
 * On the RP return, withdraws the IdP child's execution authority at once; its record ends
 * only with the flow (`releaseChild`), so the RP's evidence decides how it ended.
 */
export async function detachChild(rt: Runtime, work: SsoWork) {
  const tabId = work.rpLive.document.tabId;
  const child = rt.attempts.get(tabId);
  if (child && child.metadata.id === work.childId && ssoChild(rt.sso, child.metadata)) {
    rt.attempts.delete(tabId);
    // Stored released at once, as the flow holds both origins while it runs, and its
    // interrupted hold does after a worker restart, which would leave this record holding
    // the IdP's origin by itself (ADR 0026, amendment of 2026-11-20).
    work.childRecord = parseAttemptMetadata({
      ...child.metadata,
      ssoChild: { parentId: work.id, attemptId: child.metadata.id, released: true },
    });
    work.detached ??= work.live.document;
    await keep(rt, work.childRecord);
    // The child's document is an IdP page the tab has left; a cancel there stops what it
    // still waits for.
    await send(rt, child.live, { type: "login.cancel" }).catch(() => undefined);
  } else if (work.childId !== undefined && work.childRecord?.id === work.childId)
    work.detached ??= work.live.document;
}
/**
 * Ends the IdP child the RP return detached, once, with its true state: signed in when the
 * RP showed the sign-in it led to, else as a login whose tab left its origin after its
 * submission. Its IdP origin hold is released either way, and it supplies no IdP default
 * or authentication proof (ADR 0026, amendment of 2026-11-20).
 */
export async function releaseChild(rt: Runtime, work: SsoWork, signedIn: boolean) {
  const metadata = work.childRecord;
  if (
    !work.detached ||
    work.childEnded ||
    !metadata ||
    metadata.id !== work.childId ||
    !ssoChild(rt.sso, metadata)
  )
    return;
  work.childEnded = true;
  const ended = terminal(metadata)
    ? metadata
    : transitionLoginAttempt(metadata, {
        type: "NAVIGATED",
        document: work.detached,
        ...(signedIn ? { signedIn: true } : {}),
      });
  work.childRecord = parseAttemptMetadata({
    ...ended,
    ssoChild: { parentId: work.id, attemptId: ended.id, released: true },
  });
  // A child that had already ended logged its end; this line only says it was released.
  reportAttempt(rt, work.childRecord, undefined, undefined, {
    ...(terminal(metadata) ? { repeat: true as const } : {}),
    reason: "sso-released",
  });
  await keep(rt, work.childRecord);
}
