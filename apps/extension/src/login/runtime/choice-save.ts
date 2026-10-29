import * as v from "valibot";
import {
  isFieldExcluded,
  sameLoginDocument,
  siteDefaultConnection,
  type LoginFieldTarget,
  type LoginDocument,
  type LocalSettings,
  type SettingsResponse,
} from "@pateat/contracts";
import { siteAccountResultSchema } from "../wire";
import { findLiveSiteCandidates, type LiveSiteCandidate } from "../../vault/site-candidates";
import type { PasskeyItem } from "../../passkeys/runtime";
import { loginUsernameFieldId } from "../vault";
import {
  type Execution,
  type LiveDocument,
  type Choice,
  type Refusal,
  type ChoicePasskeys,
  type ParkedRequest,
} from "./types";
import { type LoginReport } from "./report";
import { report, loginElsewhere, saveSession, send } from "./attempt";
import { withChoice, siteOf, choiceKey, frameKey } from "./steps";
import { choiceDefaults } from "./messages";
import { type PendingChoice, type PickedAccount } from "./session-schemas";
import { quietly } from "./session-store";
import { recordFor } from "./hold";
import { parkedFor, reviewRequests } from "./passkey";
import type { Runtime } from "./state";

/**
 * Saves an automatic account choice after confirmed `authenticated` (ADR 0013). The settings must
 * still be the revision the attempt was authorized under, or the newer one a watch took
 * over after checking its account; otherwise nothing is saved and the next login chooses
 * again.
 */
export async function remember(rt: Runtime, run: Execution): Promise<void> {
  const choice = run.choice;
  delete run.choice;
  const { account: used } = run.metadata;
  if (!choice || !rt.settings.update) return;
  const outcome = (value: Extract<LoginReport, { type: "choice" }>["outcome"]) =>
    report(rt, run.metadata.document, {
      type: "choice",
      tabId: run.metadata.document.tabId,
      origin: run.metadata.document.origin,
      outcome: value,
    });
  // Only the account this attempt authenticated with may be saved.
  if (
    choice.connectionId !== used.connectionId ||
    choice.binding.itemId !== used.itemId ||
    choice.binding.origin !== used.origin
  ) {
    outcome("account-changed");
    return;
  }
  if (loginElsewhere(rt, run)) {
    outcome("login-in-progress");
    return;
  }
  // A login another tab is admitting waits for this save, which the checks above may not
  // see yet: it has no run or record before its first step (see `admit`).
  const { promise: saving, resolve: finish } = Promise.withResolvers<void>();
  rt.savingChoices.add(saving);
  let writing = false;
  try {
    // Writing bumps the policy revision for every attempt, so skip a choice already saved.
    const latest = await rt.settings
      .handle({ version: 1, type: "settings.get" })
      .catch((error: unknown) => {
        outcome("settings-unavailable");
        throw error;
      });
    if (!latest.ok) {
      outcome("settings-unavailable");
      return;
    }
    if (withChoice(latest.snapshot.settings, choice) === latest.snapshot.settings) {
      outcome("already-saved");
      return;
    }
    writing = true;
    const written = await rt.settings
      .update(run.metadata.policyRevision, "account-choice", (snapshot) => ({
        ...snapshot,
        settings: withChoice(snapshot.settings, choice),
      }))
      .then(
        () => "saved" as const,
        () => "write-failed" as const,
      );
    outcome(written);
    // The saved default ends another tab's choice of the same origin (ADR 0034).
    if (written === "saved") void choiceDefaults(rt);
  } finally {
    if (writing) rt.vars.remembered += 1;
    rt.savingChoices.delete(saving);
    finish();
  }
}

/**
 * Every eligible provider URI match for the document across all enabled connections;
 * in a frame, only items that also match the tab's URL (ADR 0017). Any connection or
 * item that could not be evaluated refuses rather than listing part of them.
 */
export async function siteCandidates(
  rt: Runtime,
  snapshot: Extract<SettingsResponse, { ok: true }>,
  live: LiveDocument,
) {
  const find = (url: string) =>
    findLiveSiteCandidates({
      settings: snapshot.snapshot.settings,
      catalog: snapshot.catalog,
      url,
      match: rt.uris!,
    });
  const scope = await find(live.url);
  if (!scope.ok) return { reason: scope.reason };
  if (scope.unavailableConnections.length > 0) return { reason: "vault-unavailable" };
  if (scope.incompleteItems.length > 0) return { reason: "item-uri-unevaluated" };
  if (!live.topUrl) return { candidates: scope.candidates };
  const top = await find(live.topUrl);
  if (!top.ok) return { reason: top.reason };
  if (top.unavailableConnections.length > 0) return { reason: "vault-unavailable" };
  if (top.incompleteItems.length > 0) return { reason: "item-uri-unevaluated" };
  return {
    candidates: scope.candidates.filter((entry) =>
      top.candidates.some(
        (other) => other.connectionId === entry.connectionId && other.itemId === entry.itemId,
      ),
    ),
  };
}

/**
 * The accounts a paused page offers in the popup (ADR 0062): the saved default when its
 * connection is there, then every item that matches the page, at most 100. Matches that
 * could not be listed leave the saved default alone.
 */
export async function pausedCandidates(
  rt: Runtime,
  snapshot: Extract<SettingsResponse, { ok: true }>,
  live: LiveDocument,
  saved: LocalSettings["siteDefaults"][number] | undefined,
): Promise<PendingChoice["candidates"]> {
  const listed: PendingChoice["candidates"] = [];
  const mapped = saved && siteDefaultConnection(saved, snapshot.catalog);
  if (saved && mapped?.ok) listed.push({ connectionId: mapped.connectionId, itemId: saved.itemId });
  const found = rt.uris ? await siteCandidates(rt, snapshot, live) : undefined;
  for (const entry of found && !("reason" in found) ? found.candidates : [])
    if (
      !listed.some(
        (other) => other.connectionId === entry.connectionId && other.itemId === entry.itemId,
      )
    )
      listed.push({ connectionId: entry.connectionId, itemId: entry.itemId });
  return listed.slice(0, 100);
}

/**
 * The account for this document. A saved site default wins. Without one, a single
 * eligible provider URI match across all enabled connections is used for this attempt
 * only (ADR 0013); none, several, or any connection or item that could not be evaluated
 * refuses rather than guessing. While the tab asks (`asking`, the refusal's reason), only
 * a pick logs in; with `fill`, the one account to use fills the page without pressing
 * anything (ADR 0021 D).
 */
export async function choose(
  rt: Runtime,
  snapshot: Extract<SettingsResponse, { ok: true }>,
  live: LiveDocument,
  asking?: "account-asked" | "relogin-limit",
  paused = false,
  fill = false,
  /** The recipe's inputs for the `username` slot on the document's path. */
  accountTargets: readonly LoginFieldTarget[] = [],
): Promise<Choice | Refusal> {
  await rt.vars.sessionLoaded;
  // An account switch's pick (ADR 0063) wins for the tab's next login page of its site,
  // over an older pick, a logout's asking and the saved default: it becomes the pick of
  // this document, and of the login it starts, which ends the switch's pick.
  const switching = await rt.accountPicks.switchFor(
    live.document.tabId,
    siteOf(live.document.origin),
    live.incognito === true,
  );
  if (switching) {
    const held = rt.picked.get(live.document.tabId);
    const pick =
      held?.attemptId === undefined &&
      held?.documentId === live.document.documentId &&
      held.origin === live.document.origin &&
      held.connectionId === switching.connectionId &&
      held.itemId === switching.itemId
        ? held
        : {
            tabId: live.document.tabId,
            origin: live.document.origin,
            documentId: live.document.documentId,
            connectionId: switching.connectionId,
            itemId: switching.itemId,
            makeDefault: switching.makeDefault,
            waitedMs: 0,
          };
    if (pick !== held) {
      rt.picked.set(live.document.tabId, pick);
      void quietly(rt, () => saveSession(rt));
    }
    return {
      connectionId: pick.connectionId,
      itemId: pick.itemId,
      saved: false,
      source: "switch",
      pick,
    };
  }
  // An account picked in the popup wins for the document it restarted and the attempt that
  // document started; its item must still match the page and pass every check below.
  let pick = rt.picked.get(live.document.tabId);
  // The page's own account input is honoured only where an automatic login would choose
  // among several matches: never on a paused site or a tab that asks (ADR 0062), where
  // only the person's pick logs in.
  if (pick?.site && pick.attemptId === undefined && (paused || asking)) {
    rt.picked.delete(live.document.tabId);
    void quietly(rt, () => saveSession(rt));
    pick = undefined;
  }
  const owner = recordFor(rt, live.document.tabId, live.document.origin);
  if (
    pick?.origin === live.document.origin &&
    (pick.attemptId === undefined
      ? pick.documentId === live.document.documentId
      : owner?.id === pick.attemptId)
  )
    return {
      connectionId: pick.connectionId,
      itemId: pick.itemId,
      saved: false,
      source: pick.site ? "site-value" : "pick",
      pick,
    };
  const saved = snapshot.snapshot.settings.siteDefaults.find(
    (entry) => entry.origin === live.document.origin,
  );
  if (paused) {
    // A paused site logs in only with an account picked in the popup, which lists any
    // matching account, the saved default first (ADR 0062).
    const listed = await pausedCandidates(rt, snapshot, live, saved);
    return { reason: "paused", paused: true, ...(listed.length ? { candidates: listed } : {}) };
  }
  if (asking) {
    // The tab asks, with the saved default first (ADR 0021 D).
    const listed: PendingChoice["candidates"] = [];
    const mapped = saved && siteDefaultConnection(saved, snapshot.catalog);
    if (saved && mapped?.ok)
      listed.push({ connectionId: mapped.connectionId, itemId: saved.itemId });
    if (rt.uris) {
      const found = await siteCandidates(rt, snapshot, live);
      // Without the matches, the saved default alone is still offered.
      if ("reason" in found && !listed.length) return { reason: found.reason };
      for (const entry of "reason" in found ? [] : found.candidates)
        if (
          !listed.some(
            (other) => other.connectionId === entry.connectionId && other.itemId === entry.itemId,
          )
        )
          listed.push({ connectionId: entry.connectionId, itemId: entry.itemId });
    }
    if (!listed.length) return { reason: saved ? "default-unavailable" : "default-not-set" };
    // With one account to use, the saved default or the only match, the page is filled
    // without any click or submitting fill; the tab still asks (ADR 0021 D). A saved
    // default that cannot be used fills nothing, as it would refuse a login.
    const only = saved
      ? mapped?.ok
        ? listed[0]
        : undefined
      : listed.length === 1
        ? listed[0]
        : undefined;
    if (fill && only)
      return {
        ...only,
        saved: Boolean(saved),
        source: saved ? "default" : "match",
        candidates: listed.length,
        fillOnly: true,
        asked: listed.slice(0, 100),
      };
    return { reason: asking, candidates: listed.slice(0, 100), ask: true };
  }
  if (saved) {
    const connection = siteDefaultConnection(saved, snapshot.catalog);
    return connection.ok
      ? {
          connectionId: connection.connectionId,
          itemId: saved.itemId,
          saved: true,
          source: "default",
        }
      : { reason: connection.reason };
  }
  if (!rt.uris) return { reason: "default-not-set" };
  // Any sync replaces a snapshot ID, so a new match from a later sync is still noticed.
  const snapshots = JSON.stringify(
    snapshot.catalog.connections.map((entry) => [entry.id, entry.snapshotId, entry.state]),
  );
  const cached = live.autoChoice;
  if (cached?.snapshots === snapshots)
    return {
      connectionId: cached.connectionId,
      itemId: cached.itemId,
      saved: false,
      source: "match",
      candidates: 1,
    };
  delete live.autoChoice;
  const found = await siteCandidates(rt, snapshot, live);
  if ("reason" in found) return { reason: found.reason };
  const { candidates } = found;
  if (candidates.length > 1) {
    // The account the page itself put into the recipe's account input picks one of them,
    // for this document and the login it starts only, and is never saved (ADR 0028
    // amendment of 2026-10-23). It is kept as a pick, which the login's later pages use.
    const shown =
      accountTargets.length > 0 && !live.siteAsked
        ? await siteAccount(rt, snapshot, live, candidates, accountTargets)
        : undefined;
    if (shown) {
      const site: PickedAccount = {
        tabId: live.document.tabId,
        origin: live.document.origin,
        documentId: live.document.documentId,
        connectionId: shown.connectionId,
        itemId: shown.itemId,
        makeDefault: false,
        waitedMs: 0,
        site: true,
      };
      // A running login's pick in the tab stays; this choice then covers this document.
      if (rt.picked.get(live.document.tabId)?.attemptId === undefined) {
        rt.picked.set(live.document.tabId, site);
        await quietly(rt, () => saveSession(rt));
      }
      return {
        connectionId: shown.connectionId,
        itemId: shown.itemId,
        saved: false,
        source: "site-value",
        candidates: candidates.length,
        pick: site,
      };
    }
  }
  if (candidates.length > 1)
    return {
      reason: "account-ambiguous",
      candidates: candidates.map((entry) => ({
        connectionId: entry.connectionId,
        itemId: entry.itemId,
      })),
    };
  const [only] = candidates;
  if (!only) return { reason: "default-not-set", noUriMatch: true };
  // The same answer covers the item origin check below; no second query is needed.
  live.uriMatch = {
    connectionId: only.connectionId,
    itemId: only.itemId,
    snapshotId: only.snapshotId,
  };
  live.autoChoice = { snapshots, connectionId: only.connectionId, itemId: only.itemId };
  return {
    connectionId: only.connectionId,
    itemId: only.itemId,
    saved: false,
    source: "match",
    candidates: candidates.length,
  };
}

/**
 * The one candidate whose username equals the value the page itself set in one of
 * `targets` before anyone typed, as the document's content script compares them (ADR
 * 0028 amendment of 2026-10-23). The usernames are read one at a time, only for this
 * comparison, and never kept, logged or sent; a username that cannot be read, or one
 * the person excluded, compares nothing.
 */
export async function siteAccount(
  rt: Runtime,
  snapshot: Extract<SettingsResponse, { ok: true }>,
  live: LiveDocument,
  candidates: readonly LiveSiteCandidate[],
  targets: readonly LoginFieldTarget[],
): Promise<LiveSiteCandidate | undefined> {
  if (candidates.length > 32) return undefined;
  const settingsValue = snapshot.snapshot.settings;
  const usernames: string[] = [];
  try {
    for (const candidate of candidates) {
      const connection = snapshot.catalog.connections.find(
        (entry) => entry.id === candidate.connectionId,
      );
      if (!connection) return undefined;
      const fieldId = loginUsernameFieldId(connection, candidate.itemId);
      if (!fieldId) {
        usernames.push("");
        continue;
      }
      if (
        isFieldExcluded(settingsValue, snapshot.catalog, connection.id, candidate.itemId, fieldId)
      )
        return undefined;
      // Serial reads through the shared vault host, as for a fill.
      // eslint-disable-next-line no-await-in-loop
      const value = await rt
        .fields({
          account: {
            origin: live.document.origin,
            connectionId: connection.id,
            itemId: candidate.itemId,
          },
          connection,
          fieldId,
        })
        .catch(() => undefined);
      if (value === undefined) return undefined;
      usernames.push(value);
    }
    const parsed = v.safeParse(
      siteAccountResultSchema,
      await send(rt, live, {
        type: "login.site.account",
        path: live.path,
        targets: targets.slice(0, 8),
        usernames,
      }).catch(() => undefined),
    );
    if (!parsed.success) return undefined;
    // The document compared its value and answers no more (ADR 0028 amendment of
    // 2026-10-23), so it is not asked again.
    if (!parsed.output.ok) {
      if (parsed.output.spent) live.siteAsked = true;
      return undefined;
    }
    live.siteAsked = true;
    return candidates[parsed.output.index];
  } finally {
    usernames.fill("");
  }
}

/**
 * Records the popup choice a refused top document was offered, and whether the page's own
 * conditional request may wait for its pick: only outside an ask, on a recipe without a
 * passkey button (ADR 0034). The same choice offered again keeps its check.
 */
export function noteChoice(
  rt: Runtime,
  document: LoginDocument,
  candidates: PendingChoice["candidates"],
  applies: boolean,
): void {
  if (!applies) {
    rt.choicePasskeys.delete(document.tabId);
    return;
  }
  const key = choiceKey({ document, candidates });
  const known = rt.choicePasskeys.get(document.tabId);
  // The same choice offered again keeps a passkey found or a check running; one that found
  // none, as with a locked vault, or that a default ended, is checked again.
  if (known?.key !== key || known.defaulted || (!known.checking && known.holds !== true))
    rt.choicePasskeys.set(document.tabId, { key, documentId: document.documentId });
  // A request already waiting has its choice checked at once.
  if (parkedFor(rt, document)) reviewRequests(rt);
}

/**
 * Looks up once whether an item of a popup choice holds a discoverable, usable passkey
 * (ADR 0034), holding vault replacement off meanwhile. A locked vault, a search that
 * could not finish or a failed lookup count as none.
 */
export function checkChoice(rt: Runtime, entry: ChoicePasskeys, waiting: PendingChoice): void {
  if (entry.checking || entry.holds !== undefined) return;
  const lookup = rt.options.passkeyItems;
  if (!lookup) {
    entry.holds = false;
    return;
  }
  entry.checking = true;
  void (async () => {
    // A default saved before the choice was noted ends it too.
    await choiceDefaults(rt);
    let held: readonly PasskeyItem[] = [];
    const leave = await rt.options.vault?.enter(false).catch(() => undefined);
    try {
      held = await lookup(waiting.document.origin);
    } catch {
      held = [];
    } finally {
      leave?.();
    }
    entry.holds = waiting.candidates.some((candidate) =>
      held.some(
        (item) => item.connectionId === candidate.connectionId && item.itemId === candidate.itemId,
      ),
    );
    delete entry.checking;
    reviewRequests(rt);
  })();
}

/**
 * Whether the request's document waits for a pick in a popup choice outside an ask
 * (ADR 0034): `waits` while that choice is offered and one of its items holds a
 * discoverable passkey, or while its pick has not started a login yet; `checking` while
 * the choice's items are looked up, which starts the lookup once per choice.
 */
export function choiceWaits(rt: Runtime, parked: ParkedRequest): "waits" | "checking" | "none" {
  const waiting = rt.pending.get(parked.tabId);
  const entry = rt.choicePasskeys.get(parked.tabId);
  // As the popup sees it: a document that announced again and started a login, or
  // another document of the frame, no longer offers it.
  const live = waiting && rt.documents.get(frameKey(waiting.document));
  if (
    waiting &&
    entry &&
    !waiting.ask &&
    !entry.defaulted &&
    waiting.document.frameId === 0 &&
    waiting.document.documentId === parked.documentId &&
    waiting.document.origin === parked.origin &&
    entry.key === choiceKey(waiting) &&
    (!live || sameLoginDocument(live.document, waiting.document)) &&
    recordFor(rt, parked.tabId, parked.origin) === undefined
  ) {
    checkChoice(rt, entry, waiting);
    if (entry.holds === undefined) return "checking";
    if (entry.holds) return "waits";
  }
  // The pick clears the choice; until its login starts, the request waits for it too.
  const pick = rt.picked.get(parked.tabId);
  if (
    pick === undefined ||
    pick.attemptId !== undefined ||
    pick.origin !== parked.origin ||
    pick.documentId !== parked.documentId
  )
    return "none";
  if (parked.picking) return "waits";
  // Picked while its choice was still being checked.
  if (entry?.documentId !== parked.documentId || entry.defaulted) return "none";
  if (entry.checking) return "checking";
  return entry.holds ? "waits" : "none";
}
