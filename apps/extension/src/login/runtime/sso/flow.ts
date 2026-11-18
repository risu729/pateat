import { holdInterrupted, interruptedAdmit, releaseInterrupted } from "./interrupted";
import { ssoDependenciesKept } from "./dependencies";
import { browser } from "wxt/browser";
import * as v from "valibot";
import {
  getItemEligibility,
  itemAsksForMasterPassword,
  parseAttemptMetadata,
  normalizeSsoLabel,
  type SsoLayout,
  sameLoginTarget,
  sameLoginDocument,
  ssoLabelSchema,
  type LoginAttemptMetadata,
  type LoginDocument,
  type LoginObservation,
  type LoginTarget,
  type SettingsResponse,
  onlyChoicesSince,
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
import { ssoCurrent, ssoReturnOrigin, ssoScope } from "../sso-scope";
import { ssoPress } from "../sso-effects";
import { ssoChild, type SsoWork } from "../sso-state";
import { ssoObservation, inspectSsoTarget } from "./entry";
import { learnSsoEntry } from "./learned-entries";
import type { AdmitContext } from "../admit-context";
import type { Choice, Execution, LiveDocument } from "../types";
import type { Runtime } from "../state";

type Saved = Extract<SettingsResponse, { ok: true }>;
/** The layout's entry for a label, ignoring letter case; a layout holds one per label. */
const entryFor = (layout: SsoLayout, label: string) =>
  layout.entries.find((entry) => normalizeSsoLabel(entry.label) === normalizeSsoLabel(label));
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
  return (await ssoScope(rt, work, live))?.() ? value : undefined;
}
/**
 * Ends a tab's flow. `goesOn` names a document that goes on with its own login, such as the
 * page whose Log in now ended the flow: it gets no cancel and keeps its state.
 */
export function cancelSso(
  rt: Runtime,
  tabId: number,
  reason = "sso-cancelled",
  goesOn?: LoginDocument,
) {
  const work = rt.sso.flows.get(tabId);
  if (!work || work.ended) return;
  work.ended = true;
  work.abort.abort();
  clearTimeout(work.timer);
  rt.sso.flows.delete(tabId);
  rt.sso.native.delete(tabId);
  holdInterrupted(rt, tabId, work);
  const kept = goesOn !== undefined && sameLoginDocument(work.live.document, goesOn);
  if (!kept) void send(rt, work.live, { type: "login.cancel" }).catch(() => undefined);
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
  if (kept) return;
  work.live.state = "denied";
  work.live.reason = reason;
  void publish(rt, work.live);
}
/**
 * Whether a tab's SSO flow only waits on this RP page, so the person's **Log in now** may
 * end it (ADR 0026, ADR 0088): its entry was spent and the tab came back, or its IdP login
 * finished, and nothing is in flight. An operation being written or pressed, the flow's
 * own step and an admission of the tab's top page still under way keep the request out.
 */
export function ssoWaiting(rt: Runtime, live: LiveDocument, record: LoginAttemptMetadata) {
  const work = rt.sso.flows.get(live.document.tabId);
  return (
    work !== undefined &&
    !work.ended &&
    !work.busy &&
    work.parent?.id === record.id &&
    live.document.frameId === 0 &&
    live.document.origin === work.account.origin &&
    (work.operation === undefined || work.operation.stage === "spent") &&
    ((work.phase === "entering-idp" && work.operation?.stage === "spent") ||
      work.phase === "returning-rp") &&
    !rt.admitting.has(`${live.document.tabId}:0`)
  );
}
/**
 * A vault notice or a settings change ends the flows whose own accounts, pages or rules
 * changed; a status read, another site's account choice or a sync of unrelated settings
 * keeps them, carried over to the newer settings. Each later effect checks the current
 * settings again before it acts.
 */
export async function ssoVaultChanged(
  rt: Runtime,
  reason: "sso-vault-changed" | "sso-settings-changed" = "sso-vault-changed",
): Promise<void> {
  if (rt.sso.flows.size === 0) return;
  const saved = await rt.settings
    .handle({ version: 1, type: "settings.get" })
    .catch(() => undefined);
  for (const [tabId, work] of [...rt.sso.flows]) {
    if (work.ended) continue;
    if (!saved?.ok || !ssoDependenciesKept(work, work.saved, saved)) cancelSso(rt, tabId, reason);
    else work.saved = saved;
  }
}
/**
 * Completes the flow on the RP page's positive evidence. After an IdP that showed no page
 * (`instant`) nothing confirmed which IdP account signed in: a bracket-form method then
 * needs the RP to show the selected identity itself, and a URL-form method completing on
 * a marker alone is recorded as unconfirmed, which saves no account choice, keeps no
 * session pick and leaves no confirmation proof.
 */
async function completeSso(rt: Runtime, work: SsoWork, live: LiveDocument, instant = false) {
  if (!work.parent || !(await ssoScope(rt, work, live))?.()) return false;
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
    if ((await ssoEntryShown(rt, live, entry.target)) !== false) return false;
  }
  const matched = identity.output.identity === "match";
  if (instant && work.form !== "url" && !matched) return false;
  const unconfirmed = instant && !matched;
  const positive =
    matched ||
    (await ssoMarkerShown(rt, work, live)) ||
    (await showsMarkers(
      rt,
      live,
      await markerProofs(rt, work.account.origin, work.account.origin),
    ));
  const fence = positive ? await ssoScope(rt, work, live) : undefined;
  if (!fence?.()) return false;
  const before = work.parent;
  const ended = parseAttemptMetadata({
    ...before,
    // A return to another origin of the RP's site keeps the record on the RP's own
    // document, since an attempt belongs to its account's origin.
    document: live.document.origin === before.account.origin ? live.document : before.document,
    state: "authenticated",
    outcome: "authenticated",
    ...(unconfirmed ? { unconfirmed: true as const } : {}),
    timing: { ...before.timing, pageMs: Date.now() - work.startedAt },
  });
  // No awaited work between the last delivery fence and the state transition.
  clearTimeout(work.timer);
  work.parent = ended;
  rt.sso.interrupted.delete(live.document.tabId);
  await keep(rt, ended, true, fence);
  if (!fence()) return false;
  reportAttempt(rt, ended, undefined);
  noteSignedIn(rt, before, ended, work.account.origin);
  countRelogin(rt, before, ended, live.incognito === true);
  if (work.choice && !unconfirmed && rt.settings.update) {
    const choice = work.choice;
    await rt.settings
      .update(
        undefined,
        "account-choice",
        (snapshot) => {
          if (!fence()) return snapshot;
          return { ...snapshot, settings: withChoice(snapshot.settings, choice) };
        },
        async (snapshot, catalog) => {
          // This callback runs inside the settings queue: never re-enter settings.handle.
          const latestCatalog = await catalog();
          return (
            onlyChoicesSince(snapshot, work.saved.snapshot.revision) &&
            JSON.stringify(latestCatalog) === JSON.stringify(work.saved.catalog) &&
            !!fence()
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
async function pauseNativeChild(rt: Runtime, work: SsoWork): Promise<boolean> {
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
): Promise<boolean | undefined> {
  const reading = v.safeParse(
    observationSchema,
    await send(rt, live, {
      type: "login.observe",
      path: live.path,
      targets: [target],
      require: ["shown"],
    }).catch(() => undefined),
  );
  // A missing reading proves neither absence, including a visible but disabled entry, nor
  // presence, as when the page navigates away while it is read: it answers undefined.
  if (!reading.success || reading.output.targets[0] === undefined) return undefined;
  return ["unique", "ambiguous"].includes(reading.output.targets[0]);
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
    !!(await ssoScope(rt, work, live))?.()
  );
}
/**
 * Whether the RP page completes the flow: `completed`, `refused` when it shows the site's
 * sign-in again (its SSO entry, a password form or a rejected sign-in) or another account,
 * or false when it proves nothing. A return must carry positive RP authentication
 * evidence, never just an absent form. With `instant`, after an IdP that showed no page,
 * only the page's own evidence counts and the RP-return judge is never asked.
 */
async function returned(
  rt: Runtime,
  work: SsoWork,
  live: LiveDocument,
  instant = false,
): Promise<"completed" | "refused" | false> {
  if (!(await ssoScope(rt, work, live))) return false;
  let value = work.form === "url" ? undefined : await username(rt, work, live, false);
  const identity = v.safeParse(
    ssoReturnResultSchema,
    await send(rt, live, { type: "login.sso.return", ...(value ? { username: value } : {}) }).catch(
      () => undefined,
    ),
  );
  if (identity.success && identity.output.ok && identity.output.identity === "different") {
    value = undefined;
    return "refused";
  }
  if (!identity.success || !identity.output.ok || !(await ssoScope(rt, work, live))) {
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
  if (signs.password || signs.invalid) return "refused";
  if (signs.code || signs.captcha || signs.alert) return false;
  const own = work.recipe?.sso.layouts.find((entry) => entry.key === work.layout);
  for (const entry of own?.entries ?? []) {
    // oxlint-disable-next-line no-await-in-loop -- any original entry still shown prevents completion
    const shown = await ssoEntryShown(rt, live, entry.target);
    // Only an entry read as shown is a refusal; an unread page, often one moving on, waits.
    if (shown !== false) return shown === true ? "refused" : false;
  }
  const marker = await showsMarkers(
    rt,
    live,
    await markerProofs(rt, work.account.origin, work.account.origin),
  );
  if (identity.output.identity === "match" || marker || (await ssoMarkerShown(rt, work, live)))
    return (await completeSso(rt, work, live, instant)) && "completed";
  if (instant || work.completionTried || !work.recipe || !work.layout || !rt.generation?.judgeSso)
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
    (await completeSso(rt, work, live)) &&
    "completed"
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
    let label = selection.label ?? observed?.label;
    let target = observed?.target;
    let privatePage: LoginObservation | undefined;
    if (method.form === "url") {
      if (!observed) throw new Error("sso-entry-unresolved");
      const page = await ssoObservation(rt, ctx.live);
      if (!page) throw new Error("sso-observation-unavailable");
      const rp = await username(rt, work, ctx.live, false);
      const idp = await username(rt, work, ctx.live, true);
      const hidden = hideUsernames(
        rt,
        page,
        rp !== undefined && idp !== undefined ? [rp, idp] : undefined,
        ctx.live,
      );
      if ("reason" in hidden || !(await ssoScope(rt, work)))
        throw new Error("sso-observation-private");
      const candidates = hidden.observation.candidates.filter((candidate) =>
        sameLoginTarget(candidate.target, observed.target),
      );
      const sanitized = candidates.length === 1 && candidates[0]!.label?.trim();
      // A label holds no bracket (ADR 0085), so a redaction such as `[account]` reads
      // `(account)` in it; the description the model reads keeps its own form.
      const entryLabel = sanitized && sanitized.replaceAll(/\[([a-z]+)\]/gu, "($1)");
      if (!sanitized || !entryLabel || !v.is(ssoLabelSchema, entryLabel))
        throw new Error("sso-entry-label-private");
      const publicText = sanitized
        .replaceAll(/\[[a-z]+\]/gu, "")
        .normalize("NFKC")
        .toLowerCase();
      if (
        [rp, idp].some(
          (value) => value && publicText.includes(value.trim().normalize("NFKC").toLowerCase()),
        )
      )
        throw new Error("sso-entry-label-private");
      label = entryLabel;
      work.label = entryLabel;
      privatePage = hidden.observation;
    }
    let heads = (await rt.recipes.sso?.(account.origin, ctx.live.path)) ?? [];
    const matches = heads
      .flatMap((head) =>
        head.sso.layouts.flatMap((layout) => {
          const entry = label && entryFor(layout, label);
          return entry &&
            (method.form !== "url" || (observed && sameLoginTarget(entry.target, observed.target)))
            ? [{ head, layout, target: entry.target }]
            : [];
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
      if (!privatePage) {
        const page = await ssoObservation(rt, ctx.live);
        if (!page) throw new Error("sso-observation-unavailable");
        const rp = await username(rt, work, ctx.live, false);
        const idp = await username(rt, work, ctx.live, true);
        const hidden = hideUsernames(
          rt,
          page,
          rp !== undefined && idp !== undefined ? [rp, idp] : undefined,
          ctx.live,
        );
        if ("reason" in hidden) throw new Error("sso-observation-private");
        privatePage = hidden.observation;
      }
      if (!(await ssoScope(rt, work))) throw new Error("sso-scope-changed");
      const generated = await rt.generation.generateSso({
        version: 1,
        kind: "sso",
        observation: privatePage,
        labels: [label],
        ...(heads.length === 1
          ? { repair: { recipeId: heads[0]!.id, revision: heads[0]!.revision } }
          : {}),
      });
      if (generated.outcome !== "recipe") throw new Error("sso-generation-refused");
      const repaired = generated.recipe.sso.layouts
        .flatMap((layout) => {
          const entry = entryFor(layout, label);
          return entry &&
            (method.form !== "url" || (observed && sameLoginTarget(entry.target, observed.target)))
            ? [{ layout, target: entry.target }]
            : [];
        })
        .sort((a, b) => b.layout.createdAt - a.layout.createdAt);
      let selected = false;
      for (const candidate of repaired) {
        // oxlint-disable-next-line no-await-in-loop -- only a currently observed repaired layout may execute
        if (await inspectSsoTarget(rt, ctx.live, candidate.target)) {
          work.recipe = generated.recipe;
          work.layout = candidate.layout.key;
          target = candidate.target;
          selected = true;
          break;
        }
      }
      if (!selected) throw new Error("sso-entry-missing");
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
    if (method.form === "url") work.entry = { path: ctx.live.path, target };
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
  if (!work) return interruptedAdmit(rt, ctx);
  // The person's own Log in now on the RP ends the flow, and the page is admitted as any
  // manual request is: an RP page never waits for a flow the person has moved past.
  if (ctx.manual && ctx.document.frameId === 0 && ctx.document.origin === work.account.origin) {
    cancelSso(rt, ctx.document.tabId, "sso-manual-request", ctx.document);
    return interruptedAdmit(rt, ctx);
  }
  if (ctx.document.frameId !== 0) return ctx.refuse("sso-top-document-only");
  if (work.parent?.state === "authenticated") return ctx.refuse("sso-completed");
  if (!ssoReturnOrigin(work, ctx.document.origin) && ctx.document.origin !== work.selected.origin) {
    cancelSso(rt, ctx.document.tabId, "sso-forbidden-origin");
    return ctx.refuse("sso-forbidden-origin");
  }
  work.live = ctx.live;
  if (!(await ssoScope(rt, work))) {
    cancelSso(rt, ctx.document.tabId, "sso-scope-changed");
    return ctx.refuse("sso-scope-changed");
  }
  if (ssoReturnOrigin(work, ctx.document.origin)) {
    const original = ctx.live.document.documentId === work.rpLive.document.documentId;
    if (work.phase === "prepared" || work.phase === "entering-idp") {
      // An IdP with an existing grant and session can send the tab straight back, so no
      // IdP page is ever admitted: once the entry was pressed, a new RP page may be the
      // return. It completes only on the page's own evidence, with no judge, and without
      // it the flow waits, as an RP page on the way to the IdP does.
      if (!original && work.phase === "entering-idp" && work.operation?.stage === "spent") {
        const result = await returned(rt, work, ctx.live, true);
        if (result === "completed") return { ok: false as const, reason: "sso-completed" };
        // The IdP refused at once, as a failed silent sign-in or a revoked grant does: the
        // site shows its sign-in again, so the flow ends rather than waiting for nothing.
        if (result === "refused") {
          cancelSso(rt, ctx.document.tabId, "sso-return-unconfirmed");
          return ctx.refuse("sso-return-unconfirmed");
        }
        return ctx.refuse("sso-in-progress");
      }
      // Before that no RP page is the return: the original page waits while its entry is
      // pressed. A new page before anything was pressed ends the flow.
      if (original || work.phase === "entering-idp") return ctx.refuse("sso-in-progress");
      cancelSso(rt, ctx.document.tabId, "sso-page-changed");
      return ctx.refuse("sso-page-changed");
    }
    if (original) {
      // The original page shown again once the IdP was reached comes back from the
      // back/forward cache: the person left the flow.
      cancelSso(rt, ctx.document.tabId, "sso-abandoned");
      return ctx.refuse("sso-abandoned");
    }
    work.phase = "returning-rp";
    await releaseChild(rt, work);
    if ((await returned(rt, work, ctx.live)) === "completed")
      return { ok: false as const, reason: "sso-completed" };
    cancelSso(rt, ctx.document.tabId, "sso-return-unconfirmed");
    return ctx.refuse("sso-return-unconfirmed");
  }
  // The pressed URL-form entry reached the mapped IdP: a later automatic press of it on
  // this page is for this IdP only (ADR 0085 amendment of 2026-11-18).
  if (work.phase === "entering-idp" && work.entry)
    void learnSsoEntry(
      work.account.origin,
      work.entry.path,
      work.entry.target,
      work.selected.origin,
    ).catch(() => undefined);
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
  if (!parsed.success || !(await ssoScope(rt, work))) {
    value = undefined;
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
    if (!(await pauseNativeChild(rt, work))) {
      value = undefined;
      cancelSso(rt, ctx.document.tabId, "sso-native-detach-failed");
      return ctx.refuse("sso-native-detach-failed");
    }
    const pressed = await ssoPress(
      rt,
      work,
      ctx.live,
      parsed.output.target,
      `idp-${parsed.output.kind}`,
      { username: value, kind: parsed.output.kind },
    );
    value = undefined;
    if (!pressed) cancelSso(rt, ctx.document.tabId, "sso-idp-stopped");
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
    const url = change.url ? URL.parse(change.url) : null;
    // A tab that went on to another site ends its interrupted hold.
    if (url) releaseInterrupted(rt, tabId, url.origin);
    if (!work || !change.url) return;
    if (!url || (!ssoReturnOrigin(work, url.origin) && url.origin !== work.selected.origin))
      cancelSso(rt, tabId, "sso-forbidden-origin");
  });
  browser.tabs.onCreated?.addListener((tab) => {
    if (tab.openerTabId !== undefined && rt.sso.flows.has(tab.openerTabId))
      cancelSso(rt, tab.openerTabId, "sso-new-context");
  });
}
