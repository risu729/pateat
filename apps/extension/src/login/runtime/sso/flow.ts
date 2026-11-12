import { browser } from "wxt/browser";
import * as v from "valibot";
import {
  getItemEligibility,
  itemAsksForMasterPassword,
  parseAttemptMetadata,
  ssoEntryFor,
  type LoginTarget,
  type SettingsResponse,
} from "@pateat/contracts";
import { newId } from "@pateat/contracts/ids";
import type { SsoResolvedChoice } from "../../sso-choice";
import { ssoIdpResultSchema, ssoReturnResultSchema } from "../../sso-operation-wire";
import { stateResultSchema, observationSchema } from "../../wire";
import { loginUsernameFieldId } from "../../vault";
import { send, publish, noteSignedIn, reportAttempt } from "../attempt";
import { keep, quietly } from "../session-store";
import { choiceAccount } from "../plan";
import { withChoice } from "../steps";
import { hideUsernames, markerProofs, showsMarkers } from "../markers";
import { openPasswordWindow } from "../master-password";
import { countRelogin } from "../relogin";
import { ssoCurrent, ssoScope } from "../sso-scope";
import { ssoPress } from "../sso-effects";
import { ssoChild, type SsoWork } from "../sso-state";
import { ssoObservation, inspectSsoTarget } from "./entry";
import type { AdmitContext } from "../admit-context";
import type { Choice, Execution, LiveDocument } from "../types";
import type { Runtime } from "../state";

type Saved = Extract<SettingsResponse, { ok: true }>;
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
async function username(rt: Runtime, work: SsoWork, live: LiveDocument, idp: boolean) {
  const account = idp ? { ...work.selected.account, origin: work.selected.origin } : work.account;
  const connection = work.saved.catalog.connections.find(
    (entry) => entry.id === account.connectionId,
  );
  const eligible = getItemEligibility(
    work.saved.snapshot.settings,
    work.saved.catalog,
    account.connectionId,
    account.itemId,
  );
  const fieldId = connection && loginUsernameFieldId(connection, account.itemId);
  if (
    !connection ||
    !fieldId ||
    !eligible.eligible ||
    !eligible.fieldIds.includes(fieldId) ||
    !(await ssoScope(rt, work, live))
  )
    return undefined;
  const value = await rt.fields({ connection, account, fieldId }).catch(() => undefined);
  return (await ssoScope(rt, work, live)) && work.deliveryFence?.() ? value : undefined;
}
export function cancelSso(rt: Runtime, tabId: number, reason = "sso-cancelled") {
  const work = rt.sso.flows.get(tabId);
  if (!work || work.ended) return;
  work.ended = true;
  work.abort.abort();
  clearTimeout(work.timer);
  rt.sso.flows.delete(tabId);
  rt.sso.native.delete(tabId);
  if (work.parent?.state !== "authenticated")
    rt.sso.interrupted.set(tabId, {
      id: work.id,
      document: work.rpLive.document,
      account: work.account,
      idp: { ...work.selected.account, origin: work.selected.origin },
      method: work.source.method.number,
      sourceEvidence: work.source.sourceEvidence,
      phase: work.phase,
    });
  void send(rt, work.live, { type: "login.cancel" }).catch(() => undefined);
  void rt.sso.write().catch(() => undefined);
  if (work.parent && work.parent.state !== "authenticated") {
    const ended = parseAttemptMetadata({
      ...work.parent,
      state: "blocked",
      outcome: "cancelled",
      timing: { ...work.parent.timing, pageMs: Date.now() - work.startedAt },
    });
    work.parent = ended;
    void quietly(rt, async () => {
      await keep(rt, ended);
      reportAttempt(rt, ended, undefined, undefined, { reason });
    });
  }
  work.live.state = "denied";
  work.live.reason = reason;
  void publish(rt, work.live);
}
async function completeSso(rt: Runtime, work: SsoWork, live: LiveDocument) {
  if (!work.parent || !(await ssoScope(rt, work, live)) || !work.deliveryFence?.()) return false;
  let selected = work.form === "url" ? undefined : await username(rt, work, live, false);
  const identity = v.safeParse(
    ssoReturnResultSchema,
    await send(rt, live, {
      type: "login.sso.return",
      ...(selected ? { username: selected } : {}),
    }).catch(() => undefined),
  );
  const state = v.safeParse(
    stateResultSchema,
    await send(rt, live, {
      type: "login.state",
      ...(selected ? { account: { username: selected } } : {}),
      loadWithinMs: 10_000,
    }).catch(() => undefined),
  );
  selected = undefined;
  if (
    !identity.success ||
    !identity.output.ok ||
    identity.output.identity === "different" ||
    !state.success ||
    !state.output.ok ||
    !state.output.loaded ||
    [
      state.output.signs.password,
      state.output.signs.code,
      state.output.signs.captcha,
      state.output.signs.invalid,
      state.output.signs.alert,
    ].some(Boolean)
  )
    return false;
  const layout = work.recipe?.sso.layouts.find((entry) => entry.key === work.layout);
  for (const entry of layout?.entries ?? []) {
    // oxlint-disable-next-line no-await-in-loop -- every original SSO entry must still be absent
    if (await ssoEntryShown(rt, live, entry.target)) return false;
  }
  const positive =
    identity.output.identity === "match" ||
    (await ssoMarkerShown(rt, work, live)) ||
    (await showsMarkers(
      rt,
      live,
      await markerProofs(rt, work.account.origin, work.account.origin),
    ));
  if (!positive || !(await ssoScope(rt, work, live)) || !work.deliveryFence?.()) return false;
  const before = work.parent;
  const ended = parseAttemptMetadata({
    ...before,
    document: live.document,
    state: "authenticated",
    outcome: "authenticated",
    timing: { ...before.timing, pageMs: Date.now() - work.startedAt },
  });
  // No awaited work between the last delivery fence and the state transition.
  clearTimeout(work.timer);
  work.parent = ended;
  rt.sso.interrupted.delete(live.document.tabId);
  await keep(rt, ended, true, work.deliveryFence);
  if (!work.deliveryFence?.()) return false;
  reportAttempt(rt, ended, undefined);
  noteSignedIn(rt, before, ended, work.account.origin);
  countRelogin(rt, before, ended, live.incognito === true);
  if (work.choice && rt.settings.update) {
    const choice = work.choice;
    const fence = work.deliveryFence;
    await rt.settings
      .update(
        work.saved.snapshot.revision,
        "account-choice",
        (snapshot) => {
          if (!fence?.()) return snapshot;
          return { ...snapshot, settings: withChoice(snapshot.settings, choice) };
        },
        async (snapshot, catalog) => {
          // This callback runs inside the settings queue: never re-enter settings.handle.
          const latestCatalog = await catalog();
          return (
            snapshot.revision === work.saved.snapshot.revision &&
            JSON.stringify(latestCatalog) === JSON.stringify(work.saved.catalog) &&
            !!fence?.()
          );
        },
      )
      .catch(() => undefined);
  }
  work.ended = true;
  rt.sso.flows.delete(live.document.tabId);
  await rt.sso.write();
  await publish(rt, live, ended);
  return true;
}
async function pauseNativeChild(rt: Runtime, work: SsoWork) {
  const child = rt.attempts.get(work.rpLive.document.tabId);
  if (!child || child.metadata.id !== work.childId || !ssoChild(rt.sso, child.metadata)) return;
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
  await keep(rt, work.childRecord);
  rt.attempts.delete(work.rpLive.document.tabId);
  void send(rt, child.live, { type: "login.cancel" }).catch(() => undefined);
}
async function releaseChild(rt: Runtime, work: SsoWork) {
  await pauseNativeChild(rt, work);
  const metadata = work.childRecord;
  if (!metadata || metadata.id !== work.childId || !ssoChild(rt.sso, metadata)) return;
  work.childRecord = parseAttemptMetadata({
    ...metadata,
    ssoChild: { parentId: work.id, attemptId: metadata.id, released: true },
  });
  await keep(rt, work.childRecord);
}
async function ssoEntryShown(
  rt: Runtime,
  live: LiveDocument,
  target: LoginTarget,
): Promise<boolean> {
  const reading = v.safeParse(
    observationSchema,
    await send(rt, live, {
      type: "login.observe",
      path: live.path,
      targets: [target],
      require: ["shown"],
    }).catch(() => undefined),
  );
  // A missing reading cannot prove absence, including a visible but disabled entry.
  return (
    !reading.success ||
    reading.output.targets[0] === undefined ||
    ["unique", "ambiguous"].includes(reading.output.targets[0])
  );
}
async function ssoMarkerShown(rt: Runtime, work: SsoWork, live: LiveDocument) {
  const targets =
    work.recipe?.sso.layouts
      .find((entry) => entry.key === work.layout)
      ?.completion?.map((entry) => entry.target) ?? [];
  if (!targets.length) return false;
  const read = v.safeParse(
    observationSchema,
    await send(rt, live, {
      type: "login.observe",
      path: live.path,
      targets,
      require: targets.map(() => "shown" as const),
      links: targets.map((target) => target.by === "href"),
    }).catch(() => undefined),
  );
  return (
    read.success &&
    read.output.targets.some((state) => state === "unique") &&
    (await ssoScope(rt, work, live)) &&
    !!work.deliveryFence?.()
  );
}
/** A return must carry positive RP authentication evidence, never just an absent form. */
async function returned(rt: Runtime, work: SsoWork, live: LiveDocument) {
  if (!(await ssoScope(rt, work, live))) return false;
  let value = work.form === "url" ? undefined : await username(rt, work, live, false);
  const identity = v.safeParse(
    ssoReturnResultSchema,
    await send(rt, live, { type: "login.sso.return", ...(value ? { username: value } : {}) }).catch(
      () => undefined,
    ),
  );
  if (
    !identity.success ||
    !identity.output.ok ||
    identity.output.identity === "different" ||
    !(await ssoScope(rt, work, live))
  ) {
    value = undefined;
    return false;
  }
  const reading = v.safeParse(
    stateResultSchema,
    await send(rt, live, {
      type: "login.state",
      ...(value ? { account: { username: value } } : {}),
      loadWithinMs: 10_000,
    }).catch(() => undefined),
  );
  value = undefined;
  if (
    !reading.success ||
    !reading.output.ok ||
    !reading.output.loaded ||
    !(await ssoScope(rt, work, live))
  )
    return false;
  const signs = reading.output.signs;
  if (signs.password || signs.code || signs.captcha || signs.invalid || signs.alert) return false;
  const own = work.recipe?.sso.layouts.find((entry) => entry.key === work.layout);
  for (const entry of own?.entries ?? []) {
    // oxlint-disable-next-line no-await-in-loop -- any original entry still shown prevents completion
    if (await ssoEntryShown(rt, live, entry.target)) return false;
  }
  const marker = await showsMarkers(
    rt,
    live,
    await markerProofs(rt, work.account.origin, work.account.origin),
  );
  if (identity.output.identity === "match" || marker || (await ssoMarkerShown(rt, work, live)))
    return completeSso(rt, work, live);
  if (work.completionTried || !work.recipe || !work.layout || !rt.generation?.judgeSso)
    return false;
  work.completionTried = true;
  const page = await ssoObservation(rt, live);
  if (!page) return false;
  const rp = await username(rt, work, live, false);
  const idp = await username(rt, work, live, true);
  const hidden = hideUsernames(
    rt,
    page,
    rp !== undefined && idp !== undefined ? [rp, idp] : undefined,
    live,
  );
  if ("reason" in hidden || !(await ssoScope(rt, work, live))) return false;
  const judged = await rt.generation.judgeSso(work.recipe.id, {
    version: 1,
    kind: "sso-completion",
    revision: work.recipe.revision,
    layout: work.layout,
    observation: hidden.observation,
  });
  if (!judged.signedIn) return false;
  if (judged.recipe) {
    work.recipe = judged.recipe;
    if (work.parent)
      work.parent = parseAttemptMetadata({
        ...work.parent,
        recipeRevision: judged.recipe.revision,
      });
  }
  if (!(await ssoScope(rt, work, live)) || !(await ssoMarkerShown(rt, work, live))) return false;
  let selected = work.form === "url" ? undefined : await username(rt, work, live, false);
  const finalIdentity = v.safeParse(
    ssoReturnResultSchema,
    await send(rt, live, {
      type: "login.sso.return",
      ...(selected ? { username: selected } : {}),
    }).catch(() => undefined),
  );
  const finalState = v.safeParse(
    stateResultSchema,
    await send(rt, live, {
      type: "login.state",
      ...(selected ? { account: { username: selected } } : {}),
      loadWithinMs: 10_000,
    }).catch(() => undefined),
  );
  selected = undefined;
  return (
    finalIdentity.success &&
    finalIdentity.output.ok &&
    finalIdentity.output.identity !== "different" &&
    finalState.success &&
    finalState.output.ok &&
    finalState.output.loaded &&
    ![
      finalState.output.signs.password,
      finalState.output.signs.code,
      finalState.output.signs.captcha,
      finalState.output.signs.invalid,
      finalState.output.signs.alert,
    ].some(Boolean) &&
    (await completeSso(rt, work, live))
  );
}
export async function beginSso(
  rt: Runtime,
  ctx: AdmitContext,
  saved: Saved,
  chosen: Choice,
  selection: Extract<SsoResolvedChoice, { kind: "sso" }>,
  observed?: { target: LoginTarget; label: string },
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
  work.timer = setTimeout(() => cancelSso(rt, ctx.document.tabId, "sso-expired"), 600_000);
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
    const label = selection.label ?? observed?.label;
    let target = observed?.target;
    let heads = (await rt.recipes.sso?.(account.origin, ctx.live.path)) ?? [];
    const matches = heads
      .flatMap((head) =>
        head.sso.layouts.flatMap((layout) => {
          const entry = label && ssoEntryFor(layout, label);
          return entry ? [{ head, layout, target: entry.target }] : [];
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
      const page = await ssoObservation(rt, ctx.live);
      if (!page) throw new Error("sso-observation-unavailable");
      const rp = await username(rt, work, ctx.live, false);
      // The source and the selected account's native username are redacted locally.
      const idp = await username(rt, work, ctx.live, true);
      const hidden = hideUsernames(
        rt,
        page,
        rp !== undefined && idp !== undefined ? [rp, idp] : undefined,
        ctx.live,
      );
      if ("reason" in hidden || !(await ssoScope(rt, work)))
        throw new Error("sso-observation-private");
      const generated = await rt.generation.generateSso({
        version: 1,
        kind: "sso",
        observation: hidden.observation,
        labels: [label],
        ...(heads.length === 1
          ? { repair: { recipeId: heads[0]!.id, revision: heads[0]!.revision } }
          : {}),
      });
      if (generated.outcome !== "recipe") throw new Error("sso-generation-refused");
      work.recipe = generated.recipe;
      const layout = generated.recipe.sso.layouts.find((entry) => ssoEntryFor(entry, label));
      if (!layout) throw new Error("sso-entry-missing");
      work.layout = layout.key;
      target = ssoEntryFor(layout, label)!.target;
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
    work.phase = "entering-idp";
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
export async function ssoAdmit(rt: Runtime, ctx: AdmitContext) {
  await rt.sso.loaded;
  const work = rt.sso.flows.get(ctx.document.tabId);
  if (!work) {
    if (rt.sso.interrupted.has(ctx.document.tabId)) {
      if (ctx.manual || rt.picked.get(ctx.document.tabId)?.documentId === ctx.document.documentId) {
        rt.sso.interrupted.delete(ctx.document.tabId);
        await rt.sso.write();
      } else return ctx.refuse("sso-interrupted");
    }
    return undefined;
  }
  if (ctx.document.frameId !== 0) return ctx.refuse("sso-top-document-only");
  if (work.parent?.state === "authenticated") return ctx.refuse("sso-completed");
  if (ctx.document.origin !== work.account.origin && ctx.document.origin !== work.selected.origin) {
    cancelSso(rt, ctx.document.tabId, "sso-forbidden-origin");
    return ctx.refuse("sso-forbidden-origin");
  }
  work.live = ctx.live;
  if (!(await ssoScope(rt, work))) {
    cancelSso(rt, ctx.document.tabId, "sso-scope-changed");
    return ctx.refuse("sso-scope-changed");
  }
  if (ctx.document.origin === work.account.origin) {
    if (
      ctx.live.document.documentId === work.rpLive.document.documentId &&
      ctx.live.path === work.rpLive.path
    )
      return ctx.refuse("sso-in-progress");
    work.phase = "returning-rp";
    await releaseChild(rt, work);
    if (await returned(rt, work, ctx.live)) return { ok: false as const, reason: "sso-completed" };
    cancelSso(rt, ctx.document.tabId, "sso-return-unconfirmed");
    return ctx.refuse("sso-return-unconfirmed");
  }
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
  value = undefined;
  if (!parsed.success || !(await ssoScope(rt, work))) {
    cancelSso(rt, ctx.document.tabId);
    return ctx.refuse("sso-idp-unreadable");
  }
  if (
    parsed.output.kind === "native" ||
    (parsed.output.kind === "unknown" && ctx.signIn?.passkey)
  ) {
    if (
      !work.childId ||
      (child &&
        child.metadata.id === work.childId &&
        !["authenticated", "blocked"].includes(child.metadata.state))
    )
      return undefined;
  }
  if (
    parsed.output.kind === "account" ||
    parsed.output.kind === "continue" ||
    parsed.output.kind === "stay-signed-in"
  ) {
    await pauseNativeChild(rt, work);
    if (!(await ssoPress(rt, work, ctx.live, parsed.output.target, `idp-${parsed.output.kind}`)))
      cancelSso(rt, ctx.document.tabId, "sso-idp-stopped");
    return { ok: false as const, reason: "sso-in-progress" };
  }
  cancelSso(rt, ctx.document.tabId, "sso-idp-stop");
  return ctx.refuse("sso-idp-stop");
}
export function ssoChildChanged(rt: Runtime, run: Execution) {
  if (!ssoChild(rt.sso, run.metadata)) return;
  const work = rt.sso.flows.get(run.metadata.document.tabId);
  if (!work || work.childId !== run.metadata.id || work.ended) return;
  work.childRecord = run.metadata;
  if (run.metadata.state === "blocked" || run.metadata.state === "watching" || run.metadata.settled)
    cancelSso(rt, run.metadata.document.tabId, "sso-idp-child-stopped");
  else if (run.metadata.state === "authenticated") {
    work.phase = "returning-rp";
    void rt.sso.write().catch(() => undefined);
  }
}

export function installSsoLifecycle(rt: Runtime) {
  browser.tabs.onUpdated.addListener((tabId, change) => {
    const work = rt.sso.flows.get(tabId);
    if (!work || !change.url) return;
    const url = URL.parse(change.url);
    if (!url || ![work.account.origin, work.selected.origin].includes(url.origin))
      cancelSso(rt, tabId, "sso-forbidden-origin");
  });
  browser.tabs.onCreated?.addListener((tab) => {
    if (tab.openerTabId !== undefined && rt.sso.flows.has(tab.openerTabId))
      cancelSso(rt, tab.openerTabId, "sso-new-context");
  });
}
