import * as v from "valibot";
import {
  getItemEligibility,
  resolvePagePermission,
  isSsoFieldName,
  sameLoginDocument,
  sameLoginTarget,
  type LoginObservation,
  type LoginTarget,
} from "@pateat/contracts";
import { newId } from "@pateat/contracts/ids";
import { passkeyScriptsRun } from "../../../passkeys/rp-id";
import { extractResultSchema } from "../../wire";
import { ssoInspectResultSchema } from "../../sso-operation-wire";
import { choose } from "../choice-save";
import { offerChoice } from "../choice";
import { frameKey, acceptedObservation, documentKey } from "../steps";
import { saveSession, send } from "../attempt";
import { quietly } from "../session-store";
import { itemFacts } from "../plan";
import { listedBrowserSite, pauseOf } from "../pause";
import { endManual, manualAuthorizationCurrent, manualChoosing } from "../manual-scope";
import { tabAttempt, heldForLogin } from "../hold";
import { terminal } from "../attempt-state";
import { askFor } from "../choice";
import { reloginLimited } from "../relogin";
import { asksEveryTime } from "../entry-press";
import { beginSso } from "./flow";
import { ssoEntryReaches, ssoEntryReachesOther } from "./learned-entries";
import type { Saved } from "../../sso-choice-model";
import type { AdmitContext } from "../admit-context";
import type { Runtime } from "../state";
import type { LiveDocument } from "../types";

/** Keeps a cancelled automatic offer's document, the 256 newest, across a restart. */
function rememberCancel(rt: Runtime, key: string) {
  rt.ssoCancels.delete(key);
  rt.ssoCancels.add(key);
  for (const old of rt.ssoCancels) {
    if (rt.ssoCancels.size <= 256) break;
    rt.ssoCancels.delete(old);
  }
  void quietly(rt, () => saveSession(rt));
}

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
/**
 * Whether the person's one-page request may hop to `origin`: existing `auto` sign-in on
 * both the page and the IdP, with neither paused. A one-page grant never reaches the IdP.
 */
async function manualHopAllowed(rt: Runtime, ctx: AdmitContext, saved: Saved, origin: string) {
  const { settings } = saved.snapshot;
  return (
    resolvePagePermission(settings, ctx.live.url, "sign-in")?.permission === "auto" &&
    resolvePagePermission(settings, origin, "sign-in")?.permission === "auto" &&
    !(await pauseOf(rt, ctx.live)) &&
    !(await pauseOf(rt, { url: origin, incognito: ctx.incognito }))
  );
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
  // The person cancelled this document's automatic offer, perhaps before a worker
  // restart: only their own Log in now offers it again (ADR 0085, amended 2026-11-18).
  // Nothing else is read first, and the tab's passkey refusal stays for that request.
  const cancelKey = documentKey(ctx.document);
  if (!ctx.manual && rt.ssoCancels.has(cancelKey)) return ctx.refuse("sso-offer-cancelled");
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
  // The label of every other observed button or link, as one by `href` or whose
  // inspection failed: one that names the IdP keeps the label rule from pressing anything
  // (ADR 0085, amended 2026-11-18). A field's label, as "Email or IBMid", is not counted.
  const otherLabels: string[] = [];
  if (described.data.methods.some((method) => method.form === "url")) {
    const observation = await ssoObservation(rt, ctx.live);
    const pressable = new Set<unknown>();
    for (const candidate of observation?.candidates ?? []) {
      if (
        candidate.target.by === "href" ||
        !["button", "link"].includes(candidate.role) ||
        !candidate.label?.trim()
      )
        continue;
      // oxlint-disable-next-line no-await-in-loop -- observations are checked locally, never inferred from labels
      if (await inspectSsoTarget(rt, ctx.live, candidate.target)) {
        pressable.add(candidate);
        targets.set(newId(), {
          target: candidate.target,
          label: candidate.label.trim().slice(0, 128),
        });
      }
      if (targets.size >= 100) break;
    }
    for (const candidate of observation?.candidates ?? [])
      if (
        !pressable.has(candidate) &&
        ["button", "link"].includes(candidate.role) &&
        candidate.label?.trim() &&
        otherLabels.length < 200
      )
        otherLabels.push(candidate.label.trim().slice(0, 128));
  }
  // After the site refused this account's passkey, the chooser picks again without it.
  const refused = rt.sso.passkeyRefused.get(ctx.document.tabId);
  rt.sso.passkeyRefused.delete(ctx.document.tabId);
  const passkeyRefused =
    refused?.origin === account.origin &&
    refused.connectionId === account.connectionId &&
    refused.itemId === account.itemId;
  // The person's own request presses by itself only an SSO method the automatic order
  // decides and its scope reaches; otherwise it opens the method offer they choose from
  // (ADR 0088 amendment of 2026-11-18). The offer ends with that request, as on its time
  // running out or the person's cancel, so it never waits for a choice nothing could use.
  if (ctx.manual && !manualAuthorizationCurrent(rt, ctx.live, ctx.manual))
    return ctx.refuse("manual-request-ended");
  const methodOffer = ctx.manual ? new AbortController() : undefined;
  /** A fresh inspection finds the entry going nowhere but the page's own origin, if anywhere. */
  const ownOriginOnly = async (target: LoginTarget) => {
    const inspected = await inspectSsoTarget(rt, ctx.live, target);
    return (
      !!inspected &&
      inspected.destinations.every(
        (destination) => URL.parse(destination)?.origin === ctx.document.origin,
      )
    );
  };
  if (ctx.manual && methodOffer) ctx.manual.request.methodOffer = methodOffer;
  const requested = await rt.ssoChoices.request({
    document: ctx.document,
    account,
    incognito: ctx.incognito === true,
    basis: saved,
    ...(methodOffer ? { signal: methodOffer.signal } : {}),
    native: { passkey: facts.discoverablePasskey && !passkeyRefused, password: facts.password },
    automatic: ctx.manual ? "sso" : true,
    // `saved` is the snapshot this request read; ssoScope reads the settings and pauses
    // again before any press, so a later change still stops the hop.
    ...(ctx.manual
      ? { hopAllowed: (origin: string) => manualHopAllowed(rt, ctx, saved, origin) }
      : {}),
    entries: [...targets].map(([id, entry]) => ({ id, label: entry.label })),
    otherLabels,
    // A first visit (owner, 2026-11-18 14:14 UTC): the entry whose label names the mapped
    // IdP, as `entryLearned` checks its destinations, and never one a flow learned to
    // reach another IdP.
    entryLabeled: async (id: string, selectedOrigin: string) => {
      const entry = targets.get(id);
      return (
        !!entry &&
        (await ownOriginOnly(entry.target)) &&
        !(await ssoEntryReachesOther(
          ctx.document.origin,
          ctx.live.path,
          entry.target,
          selectedOrigin,
        ))
      );
    },
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
    // A broker page's provider button submits to the site itself (ADR 0085 amendment of
    // 2026-11-18): it may be pressed only as the entry the page's own SSO layout learned
    // and a flow pressed there to reach this very IdP origin.
    entryLearned: async (id: string, selectedOrigin: string) => {
      const entry = targets.get(id);
      if (!entry || !(await ownOriginOnly(entry.target))) return false;
      if (
        !(await ssoEntryReaches(ctx.document.origin, ctx.live.path, entry.target, selectedOrigin))
      )
        return false;
      const heads = (await rt.recipes.sso?.(ctx.document.origin, ctx.live.path)) ?? [];
      return (
        rt.documents.get(ctx.key) === ctx.live &&
        heads.some((head) =>
          head.sso.layouts.some((layout) =>
            layout.entries.some((known) => sameLoginTarget(known.target, entry.target)),
          ),
        )
      );
    },
  });
  // The popup says the request waits for the person's choice, and its start answers now.
  if (ctx.manual && requested.waiting) manualChoosing(rt, ctx.live, ctx.manual, true);
  const result = await requested.result;
  if (!ctx.manual && !result.ok && result.reason === "cancelled") rememberCancel(rt, cancelKey);
  if (ctx.manual && !manualAuthorizationCurrent(rt, ctx.live, ctx.manual))
    return ctx.refuse("manual-request-ended");
  if (!result.ok || rt.documents.get(ctx.key) !== ctx.live)
    return ctx.refuse(result.ok ? "stale-document" : result.reason);
  if (ctx.manual) manualChoosing(rt, ctx.live, ctx.manual, false);
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
      // Log in now never takes a native route by itself: it is the person's pick.
      ...(ctx.manual ? {} : { automatic: true as const }),
      ...(described.data.methods.length ? { methods: true as const } : {}),
      ...(receipt.picked ? { picked: true as const } : {}),
      ...(passkeyRefused ? { passkeyRefused: true as const } : {}),
    });
    return undefined;
  }
  if (ctx.manual) {
    if (!manualAuthorizationCurrent(rt, ctx.live, ctx.manual))
      return ctx.refuse("manual-request-ended");
    // A one-page grant cannot authorize a hop. Existing auto permission on both sites can.
    // ssoScope reads the current settings again before any press.
    if (!(await manualHopAllowed(rt, ctx, saved, receipt.selection.selected.origin)))
      return ctx.refuse("sso-manual-scope-unavailable");
    endManual(rt, ctx.document.tabId, undefined, ctx.manual.request);
  }
  const selectedEntry = receipt.selection.entryId
    ? targets.get(receipt.selection.entryId)
    : undefined;
  // What the item holds and why the login takes an SSO method, for its record (ADR 0055,
  // amended 2026-11-18).
  const methods = {
    held: [
      ...(facts.discoverablePasskey ? (["passkey"] as const) : []),
      "sso" as const,
      ...(facts.password ? (["password"] as const) : []),
    ],
    marks: {
      ...(receipt.picked ? { picked: true as const } : {}),
      ...(passkeyRefused ? { passkeyRefused: true as const } : {}),
    },
  };
  return beginSso(
    rt,
    ctx,
    saved,
    chosen,
    receipt.selection,
    selectedEntry && receipt.labeled ? { ...selectedEntry, labeled: true } : selectedEntry,
    methods,
  );
}
