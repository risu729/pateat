import * as v from "valibot";
import {
  getItemEligibility,
  resolvePagePermission,
  isSsoFieldName,
  sameLoginDocument,
  type LoginObservation,
  type LoginTarget,
} from "@pateat/contracts";
import { newId } from "@pateat/contracts/ids";
import { passkeyScriptsRun } from "../../../passkeys/rp-id";
import { extractResultSchema } from "../../wire";
import { ssoInspectResultSchema } from "../../sso-operation-wire";
import { choose } from "../choice-save";
import { offerChoice } from "../choice";
import { frameKey, acceptedObservation } from "../steps";
import { send } from "../attempt";
import { itemFacts } from "../plan";
import { listedBrowserSite, pauseOf } from "../pause";
import { endManual, manualAuthorizationCurrent } from "../manual-scope";
import { tabAttempt, heldForLogin } from "../hold";
import { terminal } from "../attempt-state";
import { askFor } from "../choice";
import { reloginLimited } from "../relogin";
import { asksEveryTime } from "../entry-press";
import { beginSso } from "./flow";
import type { AdmitContext } from "../admit-context";
import type { Runtime } from "../state";
import type { LiveDocument } from "../types";

export async function ssoObservation(
  rt: Runtime,
  live: LiveDocument,
): Promise<LoginObservation | undefined> {
  for (const page of ["login", "signed-in", "entry"] as const) {
    const parsed = v.safeParse(
      extractResultSchema,
      // oxlint-disable-next-line no-await-in-loop -- stop after the first complete local observation
      await send(rt, live, { type: "login.extract", page }).catch(() => undefined),
    );
    if (!parsed.success || !parsed.output.ok || rt.documents.get(frameKey(live.document)) !== live)
      continue;
    const accepted = acceptedObservation(parsed.output, {
      origin: live.document.origin,
      path: live.path,
    });
    if (!("detail" in accepted) && accepted.observation.complete) return accepted.observation;
  }
  return undefined;
}
export async function inspectSsoTarget(rt: Runtime, live: LiveDocument, target: LoginTarget) {
  const inspected = v.safeParse(
    ssoInspectResultSchema,
    await send(rt, live, { type: "login.sso.inspect", target }).catch(() => undefined),
  );
  return inspected.success &&
    inspected.output.ok &&
    inspected.output.url === live.url &&
    rt.documents.get(frameKey(live.document)) === live
    ? inspected.output
    : undefined;
}
/** Account selection precedes method selection; an unavailable preferred method never falls through. */
export async function offerSso(rt: Runtime, ctx: AdmitContext) {
  if (
    !rt.options.sso ||
    !rt.ssoChoices ||
    (ctx.paused && !ctx.manual) ||
    rt.sso.flows.has(ctx.document.tabId)
  )
    return undefined;
  const native = rt.sso.native.get(ctx.document.tabId);
  if (native && sameLoginDocument(native.document, ctx.document)) return undefined;
  const existing = tabAttempt(rt, ctx.document.tabId);
  if (
    existing &&
    (!terminal(existing) ||
      (existing.state === "authenticated" &&
        !ctx.signIn &&
        !ctx.start &&
        !ctx.list &&
        !ctx.entryHello))
  )
    return undefined;
  const saved = await rt.settings.handle({ version: 1, type: "settings.get" });
  if (!saved.ok || rt.documents.get(ctx.key) !== ctx.live)
    return ctx.refuse("settings-unavailable");
  if (
    !ctx.manual &&
    resolvePagePermission(saved.snapshot.settings, ctx.live.url, "sign-in")?.permission !== "auto"
  )
    return undefined;
  const asking =
    askFor(rt, ctx.document.tabId, ctx.document.origin) ||
    reloginLimited(rt, ctx.document.origin, ctx.incognito === true) ||
    (await asksEveryTime(rt, ctx.document.origin, ctx.incognito === true, saved));
  const chosen = await choose(rt, saved, ctx.live, asking ? "account-asked" : undefined);
  if ("reason" in chosen) {
    if (chosen.candidates && Array.isArray(chosen.candidates))
      offerChoice(rt, ctx.document, chosen.candidates, chosen.ask ? "stopped-login" : undefined);
    return undefined;
  }
  const eligible = getItemEligibility(
    saved.snapshot.settings,
    saved.catalog,
    chosen.connectionId,
    chosen.itemId,
  );
  if (!eligible.eligible || !eligible.item.fields.some((field) => isSsoFieldName(field.name)))
    return undefined;
  if (ctx.document.frameId !== 0 || heldForLogin(rt, ctx.live))
    return ctx.refuse(ctx.document.frameId !== 0 ? "sso-top-document-only" : "origin-busy");
  const connection = saved.catalog.connections.find((entry) => entry.id === chosen.connectionId);
  if (!connection) return ctx.refuse("vault-unavailable");
  const account = {
    origin: ctx.document.origin,
    connectionId: chosen.connectionId,
    itemId: chosen.itemId,
  };
  const facts = await itemFacts(
    rt,
    connection,
    { ...account, fieldIds: eligible.fieldIds },
    passkeyScriptsRun(account.origin, false) &&
      !listedBrowserSite(rt, saved.snapshot.settings, account.origin),
  );
  if (rt.documents.get(ctx.key) !== ctx.live) return ctx.refuse("stale-document");
  const described = await rt.options.sso.describe(account);
  if (!described.ok) return ctx.refuse(described.reason);
  const targets = new Map<string, { target: LoginTarget; label: string }>();
  if (described.data.methods.some((method) => method.form === "url")) {
    const observation = await ssoObservation(rt, ctx.live);
    for (const candidate of observation?.candidates ?? []) {
      if (
        candidate.target.by === "href" ||
        !["button", "link"].includes(candidate.role) ||
        !candidate.label?.trim()
      )
        continue;
      // oxlint-disable-next-line no-await-in-loop -- observations are checked locally, never inferred from labels
      if (await inspectSsoTarget(rt, ctx.live, candidate.target))
        targets.set(newId(), {
          target: candidate.target,
          label: candidate.label.trim().slice(0, 128),
        });
      if (targets.size >= 100) break;
    }
  }
  const requested = await rt.ssoChoices.request({
    document: ctx.document,
    account,
    native: { passkey: facts.discoverablePasskey, password: facts.password },
    automatic: !ctx.manual,
    entries: [...targets].map(([id, entry]) => ({ id, label: entry.label })),
    entryOrigin: async (id: string, origin: string) => {
      const entry = targets.get(id);
      const inspected = entry && (await inspectSsoTarget(rt, ctx.live, entry.target));
      return (
        !!inspected?.destinations.length &&
        inspected.destinations.every((destination) => URL.parse(destination)?.origin === origin)
      );
    },
    entryCurrent: async (id) => {
      const entry = targets.get(id);
      return !!entry && !!(await inspectSsoTarget(rt, ctx.live, entry.target));
    },
  });
  const result = await requested.result;
  if (ctx.manual && !manualAuthorizationCurrent(rt, ctx.live, ctx.manual))
    return ctx.refuse("manual-request-ended");
  if (!result.ok || rt.documents.get(ctx.key) !== ctx.live)
    return ctx.refuse(result.ok ? "stale-document" : result.reason);
  const receipt = await rt.ssoChoices.consume(result.choiceId);
  if (
    !receipt.ok ||
    !sameLoginDocument(receipt.document, ctx.document) ||
    rt.documents.get(ctx.key) !== ctx.live
  )
    return ctx.refuse("sso-choice-withdrawn");
  if (receipt.selection.kind === "native") {
    rt.sso.native.set(ctx.document.tabId, {
      document: ctx.document,
      account,
      chosen,
      route: receipt.selection.route,
    });
    return undefined;
  }
  if (ctx.manual) {
    if (!manualAuthorizationCurrent(rt, ctx.live, ctx.manual))
      return ctx.refuse("manual-request-ended");
    // A one-page grant cannot authorize a hop. Existing auto permission on both sites can.
    if (
      resolvePagePermission(saved.snapshot.settings, ctx.live.url, "sign-in")?.permission !==
        "auto" ||
      resolvePagePermission(saved.snapshot.settings, receipt.selection.selected.origin, "sign-in")
        ?.permission !== "auto" ||
      (await pauseOf(rt, ctx.live)) ||
      (await pauseOf(rt, { url: receipt.selection.selected.origin, incognito: ctx.incognito }))
    )
      return ctx.refuse("sso-manual-scope-unavailable");
    endManual(rt, ctx.document.tabId, undefined, ctx.manual.request);
  }
  const selectedEntry = receipt.selection.entryId
    ? targets.get(receipt.selection.entryId)
    : undefined;
  return beginSso(rt, ctx, saved, chosen, receipt.selection, selectedEntry);
}
