import * as v from "valibot";
import {
  isSiteAllowed,
  isSiteExcluded,
  isEntryObservation,
  type LoginDocument,
  type LoginObservation,
  type LocalSettings,
  type LoginEntryRecipe,
  type SettingsResponse,
} from "@pateat/contracts";
import { browser } from "wxt/browser";
import {
  entryCheckResultSchema,
  entryHostsResultSchema,
  entryInspectResultSchema,
  entryPressResultSchema,
  extractResultSchema,
  LOGIN_STEP_WAIT_MS,
} from "../wire";
import { findLiveSiteCandidates } from "../../vault/site-candidates";
import { observedPath } from "../../observation/path";
import { linkRefusal, namesReturnPath } from "../entry";
import { isoTime, isoTimeMs } from "../../time";
import { siteDefaultsMark } from "../switch";
import {
  siteOf,
  documentKey,
  sameSiteAs,
  catalogItems,
  frameKey,
  acceptedObservation,
  outcomeFields,
} from "./steps";
import { switchingElsewhere, sharesCookies } from "./hold";
import { holdsOthers } from "./attempt-state";
import { type EntryBlock, entryBlockSchema, type EntryPress } from "./session-schemas";
import { type EntryBlockReason, type LiveDocument, type VaultMatch } from "./types";
import { MAX_ENTRY_BLOCKS, ENTRY_NEXT_PAGE_MS, ENTRY_PRESS_MS } from "./constants";
import { report, saveSession, send, spinning, spendBefore } from "./attempt";
import { quietly } from "./session-store";
import { startsFor, usernameReads, pausedMeanwhile } from "./generation-scope";
import { type EntryGenerationOutcome } from "./report";
import { skipGeneration } from "./generation";
import { readUsernames, hideUsernames } from "./markers";
import { DocumentGone } from "./document-gone";
import { pauseOf } from "./pause";
import { repairEntry } from "./repair-run";
import type { Runtime } from "./state";

/** Whether the tab holds an attempt record for an origin of `site`, ended or not. */
export function siteRecorded(rt: Runtime, tabId: number, site: string): boolean {
  const run = rt.attempts.get(tabId);
  return (
    (run !== undefined && siteOf(run.metadata.account.origin) === site) ||
    rt.persisted
      .values()
      .some((entry) => entry.document.tabId === tabId && siteOf(entry.account.origin) === site)
  );
}

/** Whether another tab's login of an origin of `site`, or its switch, holds it (ADR 0022). */
export function siteHeldElsewhere(rt: Runtime, tabId: number, site: string): boolean {
  const now = Date.now();
  return (
    switchingElsewhere(rt, tabId, site) ||
    rt.persisted
      .values()
      .some(
        (entry) =>
          entry.document.tabId !== tabId &&
          siteOf(entry.account.origin) === site &&
          sharesCookies(rt, entry.document.tabId, tabId) &&
          holdsOthers(entry, now),
      )
  );
}

export function readEntryBlocks(rt: Runtime): Promise<EntryBlock[] | undefined> {
  const read: Promise<EntryBlock[] | undefined> = rt.entryBlockRecords.read().then(
    (stored) => {
      const parsed = v.safeParse(v.array(entryBlockSchema), stored ?? []);
      return parsed.success ? parsed.output : [];
    },
    () => {
      if (rt.vars.entryBlocks === read) rt.vars.entryBlocks = undefined;
      return undefined;
    },
  );
  rt.vars.entryBlocks ??= read;
  return rt.vars.entryBlocks;
}

/**
 * Blocks an entry recipe revision on this device, and whether the block was stored. A
 * read of the stored blocks that failed writes nothing, so other recipes' blocks are
 * never lost; that block, like one whose write failed, holds in this worker only.
 */
export async function blockEntry(
  rt: Runtime,
  press: EntryPress,
  reason: EntryBlockReason,
): Promise<boolean> {
  const block: EntryBlock = {
    recipeId: press.recipeId,
    revision: press.revision,
    reason,
    blockedAt: isoTime(Date.now()),
  };
  const stored = await readEntryBlocks(rt);
  if (!stored) {
    rt.unsavedBlocks.push(block);
    return false;
  }
  const next = [
    // A block of an older revision of the same recipe no longer applies.
    ...stored.filter((entry) => entry.recipeId !== press.recipeId),
    block,
  ].slice(-MAX_ENTRY_BLOCKS);
  rt.vars.entryBlocks = Promise.resolve(next);
  try {
    await rt.entryBlockRecords.write(next);
    return true;
  } catch {
    rt.unsavedBlocks.push(block);
    return false;
  }
}

/** Logs one sign-in entry decision (ADR 0031). */
export function reportEntry(
  rt: Runtime,
  tabId: number,
  recipe: { origin: string; id?: string; recipeId?: string; revision: number },
  outcome: "pressed" | "refused" | "blocked",
  reason?: string,
  extra: { detail?: string; repeat?: true } = {},
): void {
  report(
    rt,
    { frameId: 0 },
    {
      type: "entry",
      tabId,
      origin: recipe.origin,
      recipeId: recipe.id ?? recipe.recipeId ?? "",
      recipeRevision: recipe.revision,
      outcome,
      ...(reason ? { reason } : {}),
      ...extra,
    },
  );
}

/**
 * Ends the check of the page after an entry press: it passed, or the recipe revision is
 * blocked on this device and a warning logged (ADR 0031). Each press is settled once.
 * `refused` is the page that blocked it, which is then refused for as long as this
 * worker runs; a page that only came too late is not.
 */
export async function settleEntry(
  rt: Runtime,
  press: EntryPress,
  verdict: EntryBlockReason | "passed",
  refused?: LoginDocument,
): Promise<void> {
  clearTimeout(rt.entryTimers.get(press.tabId));
  rt.entryTimers.delete(press.tabId);
  const latest = rt.entryPresses.get(press.tabId);
  if (latest?.pressedAt !== press.pressedAt || latest.checked) return;
  rt.entryPresses.set(press.tabId, { ...latest, checked: true });
  // Recorded before anything is awaited, so no announcement of the page slips past it.
  if (verdict !== "passed" && refused) {
    rt.entryRefused.add(documentKey(refused));
    for (const old of rt.entryRefused) {
      if (rt.entryRefused.size <= 256) break;
      rt.entryRefused.delete(old);
    }
  }
  await quietly(rt, () => saveSession(rt));
  if (verdict === "passed") return;
  const stored = await blockEntry(rt, press, verdict).catch(() => false);
  reportEntry(
    rt,
    press.tabId,
    press,
    "blocked",
    verdict,
    stored ? {} : { detail: "storage-unavailable" },
  );
}

/** Whether the check of a page after the tab's entry press is running. */
export const entryChecked = (rt: Runtime, tabId: number) =>
  rt.entryChecks.keys().some((key) => key.startsWith(`${tabId} `));

/**
 * Checks an entry press whose next page did not announce in time (ADR 0031). A tab now on
 * another site's web page blocks it as `left-site`; one still on the pressed URL, or with
 * no page announced once more the step wait after a same-site move, as `no-sign-in`.
 * While a page's check runs, that check settles the press, or arms this again.
 */
export async function lateEntry(rt: Runtime, press: EntryPress, extended: boolean): Promise<void> {
  rt.entryTimers.delete(press.tabId);
  const latest = rt.entryPresses.get(press.tabId);
  if (latest?.pressedAt !== press.pressedAt || latest.checked || entryChecked(rt, press.tabId))
    return;
  let url: string | undefined;
  try {
    url = (await browser.tabs.get(press.tabId)).url;
  } catch {
    // The tab closed; its press goes with it.
    return;
  }
  // A tab with no URL yet, or one that does not parse, shows nothing to judge.
  const parsed = url ? (URL.parse(url) ?? undefined) : undefined;
  const web = parsed !== undefined && /^https?:$/u.test(parsed.protocol);
  if (web && siteOf(parsed!) !== siteOf(press.origin)) return settleEntry(rt, press, "left-site");
  // A page of the site that has not announced yet, as one still loading, and a tab
  // without a URL to read get their own wait.
  if (!extended && (parsed === undefined || (web && url !== press.url))) {
    rt.entryTimers.set(
      press.tabId,
      setTimeout(() => void lateEntry(rt, press, true).catch(() => undefined), LOGIN_STEP_WAIT_MS),
    );
    return;
  }
  return settleEntry(rt, press, "no-sign-in");
}

export function armEntryTimer(rt: Runtime, press: EntryPress): void {
  clearTimeout(rt.entryTimers.get(press.tabId));
  const due = isoTimeMs(press.pressedAt) + ENTRY_NEXT_PAGE_MS - Date.now();
  rt.entryTimers.set(
    press.tabId,
    setTimeout(() => void lateEntry(rt, press, false).catch(() => undefined), Math.max(0, due)),
  );
}

/**
 * When `live` is the page after the tab's unchecked entry press (a new top document, or
 * the pressed document at another URL), checks it (ADR 0031): it must be on the entry
 * page's site (else `left-site`) and, within the step wait, show a sign-in input, an
 * input that asks for an account identifier alone (ADR 0016) or a ready first step of a
 * cached recipe (else `no-sign-in`), and no sign-up form (else
 * `sign-up`). A page that blocks the press is refused (`entryRefused`). A page announced
 * later than the press's wait plus the step wait settles the press as `no-sign-in` but
 * is not refused itself, on any site. A page that could not be asked leaves the press to a later
 * page of the tab or to its timer, armed again, so every press is settled.
 */
export async function checkAfterPress(rt: Runtime, live: LiveDocument): Promise<void> {
  const { tabId, documentId, frameId, origin: pageOrigin } = live.document;
  const press = rt.entryPresses.get(tabId);
  if (frameId !== 0 || live.topUrl !== undefined || !press || press.checked) return;
  if (documentId === press.documentId && live.url === press.url) return;
  const key = documentKey(live.document);
  const running = rt.entryChecks.get(key);
  if (running) return running;
  const check = (async (): Promise<void> => {
    // A page after the window settles the press but is never refused, on any site.
    if (Date.now() - isoTimeMs(press.pressedAt) > ENTRY_NEXT_PAGE_MS + LOGIN_STEP_WAIT_MS)
      return settleEntry(rt, press, "no-sign-in");
    if (siteOf(pageOrigin) !== siteOf(press.origin))
      return settleEntry(rt, press, "left-site", live.document);
    const starts = await startsFor(rt, pageOrigin);
    let answer: unknown;
    try {
      answer = await send(rt, live, {
        type: "login.entry.check",
        starts,
        timeoutMs: LOGIN_STEP_WAIT_MS,
      });
    } catch {
      return;
    }
    const parsed = v.safeParse(entryCheckResultSchema, answer);
    if (!parsed.success) return;
    if (parsed.output.signUp) return settleEntry(rt, press, "sign-up", live.document);
    return parsed.output.signIn || parsed.output.start
      ? settleEntry(rt, press, "passed")
      : settleEntry(rt, press, "no-sign-in", live.document);
  })();
  rt.entryChecks.set(key, check);
  try {
    await check;
  } finally {
    if (rt.entryChecks.get(key) === check) rt.entryChecks.delete(key);
    // A check that settled nothing, or that ran while the timer came due, leaves the
    // press to the timer again.
    const latest = rt.entryPresses.get(tabId);
    if (
      latest?.pressedAt === press.pressedAt &&
      !latest.checked &&
      !rt.entryTimers.has(tabId) &&
      !entryChecked(rt, tabId)
    )
      armEntryTimer(rt, latest);
  }
}

/**
 * The hosts among those the page's URL and links name that are on its site, by
 * registrable domain; the content script counts every other host as another site's.
 */
export async function hostsOnSite(rt: Runtime, live: LiveDocument): Promise<string[] | undefined> {
  const parsed = v.safeParse(
    entryHostsResultSchema,
    await send(rt, live, { type: "login.entry.hosts" }).catch(() => undefined),
  );
  if (!parsed.success) return undefined;
  const onSite = sameSiteAs(live.url);
  return parsed.output.hosts.filter((host) => {
    const url = URL.parse(`https://${host}`);
    return url !== null && onSite(url);
  });
}

/**
 * The vault items whose URI matches the page, which needs an unlocked vault, with the
 * settings they were matched under; no field is read. `undefined` without a vault, or
 * when the settings could not be read.
 */
export async function vaultMatches(
  rt: Runtime,
  live: LiveDocument,
): Promise<VaultMatch | undefined> {
  if (!rt.uris) return undefined;
  const snapshot = await rt.settings.handle({ version: 1, type: "settings.get" });
  if (!snapshot.ok) return undefined;
  const scope = await findLiveSiteCandidates({
    settings: snapshot.snapshot.settings,
    catalog: snapshot.catalog,
    url: live.url,
    match: rt.uris,
  });
  return {
    items: scope.ok ? catalogItems(snapshot.catalog, scope.candidates) : [],
    settings: snapshot.snapshot.settings,
    catalog: snapshot.catalog,
  };
}

/**
 * Why the page may not be sent as a site's sign-in entry beyond ADR 0016's conditions
 * (ADR 0031), cheapest first: its URL no longer names another path of its site; it is the
 * next page after a manual sign-in; the tab holds an attempt record for its site; or no
 * vault item matches. Otherwise the matching items, whose usernames are hidden from the
 * page sent.
 */
export async function entryOfferRefusal(
  rt: Runtime,
  live: LiveDocument,
): Promise<{ refusal: string } | { matched: VaultMatch }> {
  const site = siteOf(live.document.origin);
  if (site === undefined) return { refusal: "no-return-target" };
  // An account switch's tab goes to the site's login page on purpose (ADR 0063).
  const switching = await switchingTab(rt, live);
  if (!switching && !namesReturnPath(new URL(live.url), sameSiteAs(live.url)))
    return { refusal: "no-return-target" };
  // The page right after a sign-in (ADR 0028); the document skips its own next path.
  if (rt.afterSignIn.get(live.document.tabId) === live.document.documentId)
    return { refusal: "after-sign-in" };
  if (!switching && siteRecorded(rt, live.document.tabId, site)) return { refusal: "site-record" };
  const matched = await vaultMatches(rt, live).catch(() => undefined);
  return matched?.items.length ? { matched } : { refusal: "no-vault-match" };
}

/** Whether the document's tab has an account switch's pick for its site (ADR 0063). */
export async function switchingTab(rt: Runtime, live: LiveDocument): Promise<boolean> {
  const pick = await rt.accountPicks
    .switchFor(live.document.tabId, siteOf(live.document.origin), live.incognito === true)
    .catch(() => undefined);
  return pick !== undefined;
}

/**
 * Whether the site of `pageOrigin` asks every time (ADR 0063): an account was picked there
 * in this browser session without making it the default, and its saved defaults are still
 * those of then. A settings read that fails counts as not asking.
 */
export async function asksEveryTime(
  rt: Runtime,
  pageOrigin: string,
  incognito: boolean,
  snapshot?: Extract<SettingsResponse, { ok: true }>,
  siteDefaults?: LocalSettings["siteDefaults"],
): Promise<boolean> {
  const site = siteOf(pageOrigin);
  if (site === undefined) return false;
  let defaults = siteDefaults;
  if (!defaults) {
    const read =
      snapshot ??
      (await rt.settings.handle({ version: 1, type: "settings.get" }).catch(() => undefined));
    if (!read?.ok) return false;
    defaults = read.snapshot.settings.siteDefaults;
  }
  return rt.accountPicks
    .asksEveryTime(site, incognito, siteDefaultsMark(defaults, site, siteOf))
    .catch(() => false);
}

/**
 * Sends the page as a site's sign-in entry (ADR 0031): its buttons and links, with the
 * usernames of the items that matched it hidden as on every page sent, and without slots
 * (owner 2026-10-23 11:48 UTC). A returned entry recipe is in the recipe cache by then;
 * the document announces again and its entry is pressed.
 */
export async function generateEntryFor(
  rt: Runtime,
  live: LiveDocument,
  matched: VaultMatch,
  /** For an entry recipe whose link no longer shows (ADR 0041): as for `generateFor`. */
  repair?: { recipeId: string; revision: number; done(outcome: EntryGenerationOutcome): void },
): Promise<void> {
  if (!rt.generation) return;
  const key = frameKey(live.document);
  let sent = false;
  try {
    const onSite = await hostsOnSite(rt, live);
    if (rt.documents.get(key) !== live) return;
    if (!onSite) {
      skipGeneration(rt, live, "extract-failed", "entry");
      return;
    }
    const extracted = v.safeParse(
      extractResultSchema,
      await send(rt, live, { type: "login.extract", page: "entry", onSite }),
    );
    if (rt.documents.get(key) !== live) return;
    if (!extracted.success || !extracted.output.ok) {
      skipGeneration(
        rt,
        live,
        extracted.success && !extracted.output.ok ? extracted.output.reason : "extract-failed",
        "entry",
      );
      return;
    }
    const accepted = acceptedObservation(extracted.output, {
      origin: live.document.origin,
      path: live.path,
    });
    // `not-entry` for a description with fields or accounts, which is no entry page.
    if ("detail" in accepted || !isEntryObservation(accepted.observation)) {
      const detail = "detail" in accepted ? accepted.detail : "not-entry";
      skipGeneration(rt, live, "incomplete-observation", "entry", detail);
      return;
    }
    // Only a link is ever pressed, so a page without one is not worth a model call.
    const linked = (shown: LoginObservation) =>
      shown.candidates.some((candidate) => candidate.role === "link");
    if (!linked(accepted.observation)) {
      skipGeneration(rt, live, "no-entry-link", "entry");
      return;
    }
    // The matching items' usernames never reach the service, as on every page sent: a
    // signed-out page may still greet a remembered account (owner 2026-10-23 11:48 UTC).
    const usernames = await readUsernames(rt, live.document.origin, usernameReads(rt, matched));
    const hidden = hideUsernames(rt, accepted.observation, usernames, live);
    if (rt.documents.get(key) !== live) return;
    if ("reason" in hidden) {
      skipGeneration(rt, live, hidden.reason, "entry");
      return;
    }
    const { observation } = hidden;
    // A link whose locator holds a username is left out of the page.
    if (!linked(observation)) {
      skipGeneration(rt, live, "no-entry-link", "entry");
      return;
    }
    if (await pausedMeanwhile(rt, live, "entry")) return;
    const spin = spinning(rt, live.document.tabId);
    const asked = Date.now();
    const result = await rt.generation
      .generateEntry(
        {
          version: 1,
          observation,
          ...(repair ? { repair: { recipeId: repair.recipeId, revision: repair.revision } } : {}),
        },
        spin.sent(() =>
          report(rt, live.document, {
            type: "generation",
            tabId: live.document.tabId,
            origin: live.document.origin,
            outcome: "sent",
            page: "entry",
          }),
        ),
      )
      .finally(spin.stop)
      .catch((): EntryGenerationOutcome => ({ outcome: "failed", reason: "error" }));
    if (result.outcome !== "skipped") spendBefore(rt, live, Date.now() - asked, result.timing);
    sent = true;
    report(rt, live.document, {
      type: "generation",
      tabId: live.document.tabId,
      origin: live.document.origin,
      ...outcomeFields(result),
      page: "entry",
    });
    repair?.done(result);
    if (result.outcome !== "recipe" || rt.documents.get(key) !== live) return;
    await browser.tabs.sendMessage(
      live.document.tabId,
      { version: 1, type: "login.reconnect" },
      { documentId: live.document.documentId, frameId: live.document.frameId },
    );
  } catch (error) {
    if (!sent && rt.documents.get(key) === live)
      if (error instanceof DocumentGone)
        skipGeneration(rt, live, "unreachable", "entry", error.reason);
      else skipGeneration(rt, live, "exception", "entry");
  }
}

/**
 * Logs why the document's sign-in entry was not pressed; a reason the document already
 * logged is marked as a repeat, which the log keeps at debug (ADR 0019).
 */
export function refuseEntry(
  rt: Runtime,
  live: LiveDocument,
  recipe: LoginEntryRecipe,
  reason: string,
): void {
  const repeat = live.entryRefusals?.includes(reason) === true;
  if (!repeat) live.entryRefusals = [...(live.entryRefusals ?? []), reason];
  reportEntry(rt, live.document.tabId, recipe, "refused", reason, repeat ? { repeat } : {});
}

/**
 * Why the entry may not be pressed now, from what the worker knows (ADR 0031), cheapest
 * first; checked again after the page was inspected.
 */
export async function entryPressRefusal(
  rt: Runtime,
  live: LiveDocument,
  recipe: LoginEntryRecipe,
  url: string,
): Promise<string | undefined> {
  const { tabId, frameId, origin: pageOrigin } = live.document;
  if (frameId !== 0 || live.topUrl !== undefined) return "frame";
  const blocks = await readEntryBlocks(rt);
  if (!blocks) return "storage-unavailable";
  if (
    [...blocks, ...rt.unsavedBlocks].some(
      (entry) => entry.recipeId === recipe.id && entry.revision === recipe.revision,
    )
  )
    return "blocked";
  if (observedPath(new URL(url).pathname) !== recipe.entry.path) return "page-changed";
  const cached = (await rt.recipes.entries(pageOrigin).catch(() => [])).find(
    (entry) => entry.id === recipe.id,
  );
  if (
    !cached ||
    cached.revision !== recipe.revision ||
    JSON.stringify(cached.entry) !== JSON.stringify(recipe.entry)
  )
    return "recipe-changed";
  // An account switch's tab goes to the site's login page on purpose (ADR 0063).
  const switching = await switchingTab(rt, live);
  // A manual logout that lands on the bare top page is never undone.
  if (!switching && !namesReturnPath(new URL(url), sameSiteAs(url))) return "no-return-target";
  const site = siteOf(pageOrigin);
  if (site === undefined) return "no-site";
  if (!switching && siteRecorded(rt, tabId, site)) return "site-record";
  if (siteHeldElsewhere(rt, tabId, site)) return "site-held";
  // Pateat presses nothing by itself on a paused site (ADR 0062).
  if ((await pauseOf(rt, { ...live, url })) !== undefined) return "paused";
  const last = rt.entryPresses.get(tabId);
  if (last && Date.now() - isoTimeMs(last.pressedAt) < ENTRY_PRESS_MS) return "press-limit";
  const snapshot = await rt.settings
    .handle({ version: 1, type: "settings.get" })
    .catch(() => undefined);
  if (!snapshot?.ok) return "settings-unavailable";
  const matched = await vaultMatches(rt, { ...live, url }).catch(() => undefined);
  if (!matched?.items.length) return "no-vault-match";
  return undefined;
}

/**
 * Presses the page's sign-in entry (ADR 0031) after every check before the press: the
 * worker's, then the link's on the page (one shown `<a href>` link with rendered text,
 * opening in the same tab without downloading, whose `href` is `https:` on the site,
 * leads to another page than this one, has no query key or value leading to another
 * site and is on a site that is not excluded), then the worker's again. The press is
 * stored before the click; it starts no login and holds nothing. Only a press the page
 * answers it clicked is taken as one and has its next page checked.
 */
export async function pressEntry(
  rt: Runtime,
  live: LiveDocument,
  recipe: LoginEntryRecipe,
): Promise<void> {
  const { tabId, documentId } = live.document;
  const running = rt.pressing.get(tabId);
  // The same document announcing again leaves its press to the check already running.
  if (running === documentId) return;
  if (running !== undefined) return refuseEntry(rt, live, recipe, "in-progress");
  rt.pressing.set(tabId, documentId);
  const key = frameKey(live.document);
  // The same document announcing again keeps the press going.
  const shown = () => rt.documents.get(key)?.document.documentId === live.document.documentId;
  try {
    const pageUrl = async () => {
      const tab = await browser.tabs.get(tabId);
      return tab.url && new URL(tab.url).origin === live.document.origin ? tab.url : undefined;
    };
    let before: string | undefined;
    try {
      before = await pageUrl();
    } catch {
      if (shown()) refuseEntry(rt, live, recipe, "tab-unavailable");
      return;
    }
    if (!shown()) return;
    // The tab moved to another origin since the document announced.
    if (!before) return refuseEntry(rt, live, recipe, "page-changed");
    const early = await entryPressRefusal(rt, live, recipe, before);
    if (early) return refuseEntry(rt, live, recipe, early);
    const inspected = v.safeParse(
      entryInspectResultSchema,
      await send(rt, live, {
        type: "login.entry.inspect",
        target: recipe.entry.target,
        timeoutMs: LOGIN_STEP_WAIT_MS,
      }).catch(() => undefined),
    );
    if (!shown()) return;
    if (!inspected.success) return refuseEntry(rt, live, recipe, "no-answer");
    const { state, refusal, href, url } = inspected.output;
    if (state === "missing")
      void repairEntry(rt, live, recipe, inspected.output).catch(() => undefined);
    if (state !== "unique") return refuseEntry(rt, live, recipe, `target-${state}`);
    if (refusal) return refuseEntry(rt, live, recipe, refusal);
    if (!href) return refuseEntry(rt, live, recipe, "not-link");
    const destination = URL.parse(href);
    if (!destination) return refuseEntry(rt, live, recipe, "link-off-site");
    const linkCheck = linkRefusal(destination, sameSiteAs(url), new URL(url));
    if (linkCheck) return refuseEntry(rt, live, recipe, linkCheck);
    // The page's own URL, as the content script reads it, must still name the path too.
    if (new URL(url).origin !== live.document.origin)
      return refuseEntry(rt, live, recipe, "page-changed");
    const late = await entryPressRefusal(rt, live, recipe, url);
    if (late) return refuseEntry(rt, live, recipe, late);
    const snapshot = await rt.settings
      .handle({ version: 1, type: "settings.get" })
      .catch(() => undefined);
    if (!snapshot?.ok) return refuseEntry(rt, live, recipe, "settings-unavailable");
    if (isSiteExcluded(snapshot.snapshot.settings, destination.href))
      return refuseEntry(rt, live, recipe, "destination-excluded");
    if (!isSiteAllowed(snapshot.snapshot.settings, destination.href))
      return refuseEntry(rt, live, recipe, "destination-not-allowed");
    if (!shown()) return;
    const press: EntryPress = {
      tabId,
      origin: live.document.origin,
      recipeId: recipe.id,
      revision: recipe.revision,
      pressedAt: isoTime(Date.now()),
      documentId: live.document.documentId,
      url,
      timing: { ...live.timing },
    };
    // Stored first, so a restarted worker still counts the press and checks its next page.
    const previous = rt.entryPresses.get(tabId);
    rt.entryPresses.set(tabId, press);
    try {
      await saveSession(rt);
    } catch {
      if (previous) rt.entryPresses.set(tabId, previous);
      else rt.entryPresses.delete(tabId);
      return refuseEntry(rt, live, recipe, "storage-unavailable");
    }
    const pressed = v.safeParse(
      entryPressResultSchema,
      await send(rt, live, {
        type: "login.entry.press",
        target: recipe.entry.target,
        href,
        url,
      }).catch(() => undefined),
    );
    if (pressed.success && !pressed.output.ok) {
      // Nothing was clicked, so the press does not count.
      if (rt.entryPresses.get(tabId) === press) {
        if (previous) rt.entryPresses.set(tabId, previous);
        else rt.entryPresses.delete(tabId);
        await quietly(rt, () => saveSession(rt));
      }
      return refuseEntry(rt, live, recipe, pressed.output.reason ?? "target-changed");
    }
    if (!pressed.success) {
      // No answer says the link was clicked, so the press is not taken as one: its next
      // page is not checked. It still counts against the tab's limit, so a page that
      // never answers is not pressed again and again.
      if (rt.entryPresses.get(tabId) === press) {
        rt.entryPresses.set(tabId, { ...press, checked: true });
        await quietly(rt, () => saveSession(rt));
      }
      return refuseEntry(rt, live, recipe, "unconfirmed");
    }
    reportEntry(rt, tabId, recipe, "pressed");
    armEntryTimer(rt, press);
  } finally {
    if (rt.pressing.get(tabId) === documentId) rt.pressing.delete(tabId);
  }
}
