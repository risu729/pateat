import * as v from "valibot";
import { sameLoginDocument, type LoginTarget } from "@pateat/contracts";
import { newId } from "@pateat/contracts/ids";
import {
  ssoAuthorizeSchema,
  ssoInspectResultSchema,
  ssoIdpExpectationSchema,
  type SsoIdpExpectation,
} from "../sso-operation-wire";
import { browser } from "wxt/browser";
import { send } from "./attempt";
import { identify } from "./messages";
import { ssoCurrent, ssoScope } from "./sso-scope";
import { accountDestinationRefusal } from "./plan";
import type { Runtime } from "./state";
import type { SsoWork } from "./sso-state";
import type { LiveDocument, Sender } from "./types";

async function destinationsAllowed(
  rt: Runtime,
  work: SsoWork,
  live: LiveDocument,
  destinations: string[],
) {
  for (const destination of destinations) {
    const parsed = URL.parse(destination);
    if (
      !parsed ||
      parsed.username ||
      parsed.password ||
      !["https:", "http:"].includes(parsed.protocol) ||
      (parsed.protocol === "http:" && new URL(live.url).protocol === "https:")
    )
      return false;
    if (parsed.origin === work.selected.origin && live.document.origin === work.account.origin)
      continue;
    if (parsed.origin !== live.document.origin) return false;
    const account =
      live.document.origin === work.selected.origin
        ? { ...work.selected.account, origin: work.selected.origin }
        : work.account;
    // Each origin's own navigation retains that item's full-URI destination rule.
    if (
      // oxlint-disable-next-line no-await-in-loop -- authorization is sequential before any intent
      await accountDestinationRefusal(
        rt,
        { origin: live.document.origin, account, policyRevision: work.saved.snapshot.revision },
        parsed,
      )
    )
      return false;
  }
  return ssoCurrent(rt, work, live);
}
/** Claim once, persist intent, then send the only command that can mutate this prepared object. */
export async function ssoPress(
  rt: Runtime,
  work: SsoWork,
  live: LiveDocument,
  target: LoginTarget,
  purpose: string,
  idp?: SsoIdpExpectation,
): Promise<boolean> {
  const atIdp = live.document.origin === work.selected.origin;
  if ((atIdp && !v.is(ssoIdpExpectationSchema, idp)) || (!atIdp && idp !== undefined)) return false;
  const key = JSON.stringify([purpose, live.document.documentId, live.path, target]);
  if (work.used.has(key)) {
    work.stopReason = "sso-entry-already-used";
    return false;
  }
  // Reserve before the first await. Failed or uncertain operations are never retried.
  work.used.add(key);
  if (!(await ssoScope(rt, work, live))) {
    work.stopReason = "sso-entry-scope";
    return false;
  }
  work.stopReason = "sso-entry-prepare";
  const operationId = newId();
  const prepared = v.safeParse(
    ssoInspectResultSchema,
    await send(rt, live, {
      type: "login.sso.prepare",
      flowId: work.id,
      operationId,
      target,
      ...(idp ? { idp } : {}),
    }).catch(() => undefined),
  );
  if (
    !prepared.success ||
    !prepared.output.ok ||
    !prepared.output.handle ||
    prepared.output.url !== live.url ||
    !(await destinationsAllowed(rt, work, live, prepared.output.destinations)) ||
    !(await ssoScope(rt, work, live))
  )
    return false;
  work.stopReason = "sso-entry-intent";
  work.operation = {
    id: operationId,
    handle: prepared.output.handle,
    live,
    stage: "prepared",
    destinations: prepared.output.destinations,
  };
  work.operation.stage = "intent";
  await rt.sso.write();
  // A policy/document change during the durable write withdraws this intent.
  if (
    !(await ssoScope(rt, work, live)) ||
    work.operation?.id !== operationId ||
    !work.deliveryFence?.()
  )
    return false;
  try {
    work.stopReason = "sso-entry-commit";
    const result = await send(rt, live, {
      type: "login.sso.commit",
      flowId: work.id,
      operationId,
      handle: prepared.output.handle,
    });
    return result !== null && typeof result === "object" && "ok" in result && result.ok === true;
  } catch {
    // Navigation may destroy the reply. The spent journal is never replayed.
    const tab = await browser.tabs.get(live.document.tabId).catch(() => undefined);
    return (work.operation as SsoWork["operation"])?.stage === "spent" && tab?.url !== live.url;
  }
}
/** Final authorization from the browser-identified content script; consumes the intent. */
export async function authorizeSso(
  rt: Runtime,
  message: unknown,
  sender: Sender,
): Promise<{ ok: boolean }> {
  const parsed = v.safeParse(ssoAuthorizeSchema, message);
  if (!parsed.success) return { ok: false };
  const request = parsed.output;
  const document = await identify(rt, sender);
  const work = document && rt.sso.flows.get(document.tabId);
  const operation = work?.operation;
  if (
    !work ||
    !document ||
    !operation ||
    operation.stage !== (request.phase === "pointer" ? "intent" : "pointer") ||
    work.id !== request.flowId ||
    operation.id !== request.operationId ||
    operation.handle !== request.handle ||
    operation.live.token !== request.token ||
    !sameLoginDocument(operation.live.document, document) ||
    !(await ssoScope(rt, work, operation.live)) ||
    !(await destinationsAllowed(rt, work, operation.live, operation.destinations))
  )
    return { ok: false };
  if (
    work.operation !== operation ||
    operation.stage !== (request.phase === "pointer" ? "intent" : "pointer") ||
    !ssoCurrent(rt, work, operation.live) ||
    !work.deliveryFence?.()
  )
    return { ok: false };
  const next = request.phase === "pointer" ? "pointer" : "spent";
  operation.stage = next;
  await rt.sso.write();
  const scoped = await ssoScope(rt, work, operation.live);
  return {
    ok:
      scoped &&
      work.operation === operation &&
      operation.stage === next &&
      work.deliveryFence?.() === true,
  };
}
