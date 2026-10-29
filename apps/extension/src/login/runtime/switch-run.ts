import * as v from "valibot";
import { isEntryObservation } from "@pateat/contracts";
import { browser } from "wxt/browser";
import {
  entryCheckResultSchema,
  extractResultSchema,
  localLogoutResultSchema,
  logoutClickResultSchema,
  LOGOUT_REACTION_MS,
  LOGIN_STEP_WAIT_MS,
} from "../wire";
import { switchRequestSchema, type SwitchResponse } from "../choice-wire";
import { runLogout, type LogoutPress } from "../switch";
import { frameKey, siteOf, acceptedObservation, logCode } from "./steps";
import { tabAttempt } from "./hold";
import { terminal, idle } from "./attempt-state";
import { siteHeldElsewhere, hostsOnSite } from "./entry-press";
import { siteCandidates } from "./choice-save";
import { report, send, spinning, saveSession } from "./attempt";
import { type LiveDocument } from "./types";
import { SWITCH_CHECK_MS, SWITCH_POLL_MS, SWITCH_SETTLE_MS, SWITCH_QUIET_MS } from "./constants";
import { quietly, forget } from "./session-store";
import { startsFor } from "./generation-scope";
import type { Runtime } from "./state";

/**
 * Starts an account switch from the popup (ADR 0063) on the tab's top page: only one
 * Pateat watches, that waits for no account choice and runs no login or other switch, whose
 * site no login or switch of another tab sharing its cookies holds, for an account that
 * matches the page, and with a paired service's logout recipes; also on a paused or
 * excluded site, as the switch is the person's pick. The switch's pick is stored first; the logout
 * runs on behind the answer.
 */
export async function switchFor(
  rt: Runtime,
  request: v.InferOutput<typeof switchRequestSchema>,
): Promise<SwitchResponse> {
  await rt.vars.sessionLoaded;
  const { tabId } = request;
  const live = rt.documents.get(frameKey({ tabId, frameId: 0 }));
  const site = live && siteOf(live.document.origin);
  if (!live || site === undefined) return { ok: false, reason: "no-page" };
  if (rt.pending.has(tabId)) return { ok: false, reason: "choice-waiting" };
  if (rt.switchesRunning.has(tabId)) return { ok: false, reason: "in-progress" };
  const running = tabAttempt(rt, tabId);
  if (running && !terminal(running) && !idle(running)) return { ok: false, reason: "tab-busy" };
  // Another tab's login of the site, as one waiting for a code, holds the session the
  // logout would end, and the switch's own login would wait for it (ADR 0022); another
  // tab's switch on the site holds it until it ends.
  if (siteHeldElsewhere(rt, tabId, site)) return { ok: false, reason: "site-held" };
  if (!rt.options.logout) return { ok: false, reason: "unavailable" };
  const snapshot = await rt.settings
    .handle({ version: 1, type: "settings.get" })
    .catch(() => undefined);
  if (!snapshot?.ok) return { ok: false, reason: "settings-unavailable" };
  // A paused site, also one an exclusion rule or a private window pauses, still switches:
  // the switch is the person's pick (ADR 0062, ADR 0063).
  const found = rt.uris ? await siteCandidates(rt, snapshot, live) : { reason: "no-uri-matcher" };
  if (
    "reason" in found ||
    !found.candidates.some(
      (entry) => entry.connectionId === request.connectionId && entry.itemId === request.itemId,
    )
  )
    return { ok: false, reason: "not-a-candidate" };
  // Checked again after the reads: the tab may have started a login or switch meanwhile,
  // and so may another tab of the site.
  if (rt.switchesRunning.has(tabId)) return { ok: false, reason: "in-progress" };
  if (siteHeldElsewhere(rt, tabId, site)) return { ok: false, reason: "site-held" };
  if (rt.documents.get(frameKey(live.document)) !== live) return { ok: false, reason: "no-page" };
  rt.switchesRunning.add(tabId);
  try {
    await rt.accountPicks.startSwitch({
      tabId,
      site,
      incognito: live.incognito === true,
      connectionId: request.connectionId,
      itemId: request.itemId,
      makeDefault: request.makeDefault,
    });
  } catch {
    rt.switchesRunning.delete(tabId);
    return { ok: false, reason: "settings-unavailable" };
  }
  rt.switchStates.set(tabId, {
    state: "running",
    connectionId: request.connectionId,
    itemId: request.itemId,
  });
  report(rt, live.document, {
    type: "switch",
    tabId,
    origin: live.document.origin,
    stage: "start",
    ...(request.makeDefault ? { makeDefault: true as const } : {}),
  });
  // The records the tab holds for the site now are the account being signed out of.
  const before = new Set(
    [...rt.persisted.values()]
      .filter((entry) => entry.document.tabId === tabId && siteOf(entry.account.origin) === site)
      .map((entry) => entry.id),
  );
  const tab = { id: tabId };
  rt.switchTabs.set(tabId, tab);
  void runSwitch(rt, live, site, before, request).finally(() => {
    rt.switchesRunning.delete(tab.id);
    if (rt.switchTabs.get(tab.id) === tab) rt.switchTabs.delete(tab.id);
  });
  return { ok: true };
}

/**
 * Signs the tab out for its switch (ADR 0063), then lets the site's next login page log
 * in with the picked account: the tab's records of the signed-out account are released,
 * as after a logout, and its page announces again.
 */
export async function runSwitch(
  rt: Runtime,
  started: LiveDocument,
  site: string,
  before: ReadonlySet<string>,
  request: v.InferOutput<typeof switchRequestSchema>,
): Promise<void> {
  // The tab, followed when Chrome replaces it (`tabs.onReplaced`).
  const tab = rt.switchTabs.get(request.tabId) ?? { id: request.tabId };
  const top = () => {
    const live = rt.documents.get(frameKey({ tabId: tab.id, frameId: 0 }));
    return live && siteOf(live.document.origin) === site ? live : undefined;
  };
  const logout = rt.options.logout!;
  let run: Awaited<ReturnType<typeof runLogout>>;
  try {
    run = await runLogout<LiveDocument>(
      {
        page: top,
        describe: async (live) => {
          const extracted = v.safeParse(
            extractResultSchema,
            await send(rt, live, { type: "login.extract", page: "logout" }).catch(() => undefined),
          );
          if (!extracted.success) return { unsent: "extract-failed" };
          if (!extracted.output.ok) return { unsent: extracted.output.reason };
          const accepted = acceptedObservation(extracted.output, {
            origin: live.document.origin,
            path: live.path,
          });
          if ("detail" in accepted) return { unsent: accepted.detail };
          return isEntryObservation(accepted.observation)
            ? { observation: accepted.observation }
            : { unsent: "not-entry" };
        },
        click: async (live, target, purpose): Promise<LogoutPress> => {
          let answer: unknown;
          try {
            answer = await send(rt, live, {
              type: "login.logout.click",
              target,
              purpose,
              timeoutMs: LOGIN_STEP_WAIT_MS,
            });
          } catch {
            // The page went while it was pressed: the press led there.
            return "clicked";
          }
          const parsed = v.safeParse(logoutClickResultSchema, answer);
          if (!parsed.success) return "missing";
          if (parsed.output.ok) return "clicked";
          const { reason } = parsed.output;
          return reason === "ambiguous" || reason === "missing" || reason === "unsafe"
            ? reason
            : "page-changed";
        },
        findLocal: async (live) => {
          // A logout link elsewhere is not this site's (ADR 0031's link check).
          const onSite = await hostsOnSite(rt, live);
          if (onSite === undefined) return "none";
          const parsed = v.safeParse(
            localLogoutResultSchema,
            await send(rt, live, { type: "login.logout.local", onSite }).catch(() => undefined),
          );
          if (!parsed.success) return "none";
          return parsed.output.ok ? parsed.output.target : parsed.output.reason;
        },
        pressLocal: async (live, target) => {
          let answer: unknown;
          try {
            answer = await send(rt, live, {
              type: "login.logout.click",
              target,
              purpose: "logout",
              timeoutMs: SWITCH_CHECK_MS,
              watchMs: LOGOUT_REACTION_MS,
            });
          } catch {
            // The page went while it was pressed or watched: the press led there.
            return { press: "clicked", reacted: "navigated" };
          }
          const parsed = v.safeParse(logoutClickResultSchema, answer);
          if (!parsed.success) return { press: "missing" };
          if (parsed.output.ok)
            return { press: "clicked", reacted: parsed.output.reacted ?? "none" };
          const { reason } = parsed.output;
          return {
            press:
              reason === "ambiguous" || reason === "missing" || reason === "unsafe"
                ? reason
                : "page-changed",
          };
        },
        settle: (live) => settleSwitch(rt, tab, site, live),
      },
      {
        recipes: (recipeOrigin) => logout.recipes(recipeOrigin),
        generate: async (logoutRequest) => {
          const spin = spinning(rt, tab.id);
          spin.sent(() => undefined)();
          try {
            return await logout.generate(logoutRequest);
          } finally {
            spin.stop();
          }
        },
      },
      (purpose, learned, source) =>
        report(rt, started.document, {
          type: "switch",
          tabId: tab.id,
          origin: started.document.origin,
          stage: "click",
          purpose,
          source,
          ...(learned ? { learned: true as const } : {}),
        }),
    );
  } catch {
    run = { outcome: "failed", reason: "page-unreadable", detail: "exception", clicks: 0 };
  }
  report(rt, top()?.document ?? started.document, {
    type: "switch",
    tabId: tab.id,
    origin: started.document.origin,
    stage: "end",
    outcome: run.outcome,
    ...(run.outcome === "failed" ? { reason: run.reason } : {}),
    ...(run.outcome === "failed" && run.detail ? { detail: logCode(run.detail) } : {}),
    clicks: run.clicks,
    ...(run.recipe ? { recipeId: run.recipe.id, recipeRevision: run.recipe.revision } : {}),
    ...(run.learned ? { learned: true as const } : {}),
  });
  if (run.outcome === "failed") {
    rt.switchStates.set(tab.id, {
      state: "failed",
      reason: run.reason,
      connectionId: request.connectionId,
      itemId: request.itemId,
    });
    await rt.accountPicks.endSwitch(tab.id).catch(() => undefined);
    return;
  }
  // The login the switch's pick started may already have taken it over.
  if (rt.switchStates.get(tab.id)?.state === "running")
    rt.switchStates.set(tab.id, {
      state: "signed-out",
      connectionId: request.connectionId,
      itemId: request.itemId,
    });
  // Signed out, the pick waits for the login page also past a worker restart.
  await rt.accountPicks.signedOut(tab.id).catch(() => undefined);
  // The signed-out account's records no longer hold the tab: its next login page logs in
  // as a new one, and a page without a login form may press the site's sign-in entry.
  for (const [key, entry] of rt.persisted)
    if (before.has(entry.id) && entry.document.tabId === tab.id) {
      if (rt.attempts.get(tab.id)?.metadata.id === entry.id) rt.attempts.delete(tab.id);
      if (rt.picked.get(tab.id)?.attemptId === entry.id) {
        rt.picked.delete(tab.id);
        void quietly(rt, () => saveSession(rt));
      }
      await forget(rt, key).catch(() => undefined);
    }
  const page = top();
  if (page)
    await browser.tabs
      .sendMessage(
        tab.id,
        { version: 1, type: "login.reconnect" },
        { frameId: 0, documentId: page.document.documentId },
      )
      .catch(() => undefined);
}

/**
 * Waits for the tab's page after a switch's click to settle (ADR 0063): a new top
 * document of the site once it announced, or the same one after a short quiet time, as
 * when a menu opened. Then reads whether it shows a sign-in input or a recipe's first
 * step. Nothing once the tab left the site or closed.
 */
export async function settleSwitch(
  rt: Runtime,
  tab: { readonly id: number },
  site: string,
  before: LiveDocument,
): Promise<{ page: LiveDocument; signIn: boolean } | undefined> {
  const since = Date.now();
  let page: LiveDocument | undefined;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, SWITCH_POLL_MS));
    // eslint-disable-next-line no-await-in-loop
    const shown = await browser.tabs.get(tab.id).catch(() => undefined);
    if (shown?.url === undefined) return undefined;
    const over = Date.now() - since >= SWITCH_SETTLE_MS;
    const live = rt.documents.get(frameKey({ tabId: tab.id, frameId: 0 }));
    // The tab may pass through another site, as an identity provider's logout does, and
    // a page still loading may yet be replaced.
    if (siteOf(shown.url) !== site || shown.status === "loading") {
      if (over) return undefined;
      continue;
    }
    // A new document, or the same one announcing again, as after a URL change in place.
    if (live && live !== before && siteOf(live.document.origin) === site) {
      page = live;
      break;
    }
    // The same document after a quiet time: a menu or dialog opened in place.
    if (live === before && Date.now() - since >= SWITCH_QUIET_MS) {
      page = live;
      break;
    }
    if (over) return undefined;
  }
  if (!page) return undefined;
  const starts = await startsFor(rt, page.document.origin).catch(() => []);
  const checked = v.safeParse(
    entryCheckResultSchema,
    await send(rt, page, { type: "login.entry.check", starts, timeoutMs: SWITCH_CHECK_MS }).catch(
      () => undefined,
    ),
  );
  return { page, signIn: checked.success && (checked.output.signIn || checked.output.start) };
}
