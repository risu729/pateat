import * as v from "valibot";
import {
  isSiteExcluded,
  isEntryObservation,
  type LoginDocument,
  type LoginEntryRecipe,
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
import { linkRefusal, namesReturnPath } from "../entry";
import { isoTime, isoTimeMs } from "../../time";
import {
  DocumentGone,
  documentKey,
  ENTRY_NEXT_PAGE_MS,
  ENTRY_PRESS_MS,
  type EntryBlock,
  type EntryBlockReason,
  entryBlockSchema,
  type EntryPress,
  frameKey,
  holdsSite,
  type LiveDocument,
  MAX_ENTRY_BLOCKS,
  sameSiteAs,
  siteOf,
} from "./model";
import { acceptedObservation, type EntryGenerationOutcome, outcomeFields } from "./recipes";
import type { RuntimeContext } from "./context";
import type { RuntimeState } from "./state";

/**
 * Sign-in entry pages (ADR 0031): pressing a page's sign-in entry, checking the page it
 * leads to, and blocking a recipe whose press led nowhere.
 */
export function createEntryPages(shared: RuntimeState) {
  const runtime = shared as RuntimeContext;
  const {
    attempts,
    persisted,
    logouts,
    unsavedBlocks,
    report,
    entryTimers,
    entryPresses,
    entryRefused,
    quietly,
    entryChecks,
    send,
    uris,
    settings,
    generation,
    documents,
    spinning,
    recipes,
    pressing,
  } = shared;
  /** Whether the tab holds an attempt record for an origin of `site`, ended or not. */
  function siteRecorded(tabId: number, site: string): boolean {
    const run = attempts.get(tabId);
    return (
      (run !== undefined && siteOf(run.metadata.account.origin) === site) ||
      [...persisted.values()].some(
        (entry) => entry.document.tabId === tabId && siteOf(entry.account.origin) === site,
      )
    );
  }
  /** Whether any tab keeps a logout state for an origin of `site` (ADR 0021 D). */
  const siteLoggedOut = (site: string) =>
    runtime.scopes(logouts).some((entry) => siteOf(entry.origin) === site);
  /** Whether another tab's login of an origin of `site` holds it (ADR 0022). */
  function siteHeldElsewhere(tabId: number, site: string): boolean {
    const now = Date.now();
    return [...persisted.values()].some(
      (entry) =>
        entry.document.tabId !== tabId &&
        siteOf(entry.account.origin) === site &&
        holdsSite(entry, now),
    );
  }
  /** The blocks stored on this device; a read that fails is not kept, so it is read again. */
  let entryBlocks: Promise<EntryBlock[] | undefined> | undefined;
  function readEntryBlocks(): Promise<EntryBlock[] | undefined> {
    const read: Promise<EntryBlock[] | undefined> = runtime.entryBlockRecords.read().then(
      (stored) => {
        const parsed = v.safeParse(v.array(entryBlockSchema), stored ?? []);
        return parsed.success ? parsed.output : [];
      },
      () => {
        if (entryBlocks === read) entryBlocks = undefined;
        return undefined;
      },
    );
    entryBlocks ??= read;
    return entryBlocks;
  }
  /**
   * Blocks an entry recipe revision on this device, and whether the block was stored. A
   * read of the stored blocks that failed writes nothing, so other recipes' blocks are
   * never lost; that block, like one whose write failed, holds in this worker only.
   */
  async function blockEntry(press: EntryPress, reason: EntryBlockReason): Promise<boolean> {
    const block: EntryBlock = {
      recipeId: press.recipeId,
      revision: press.revision,
      reason,
      blockedAt: isoTime(Date.now()),
    };
    const stored = await readEntryBlocks();
    if (!stored) {
      unsavedBlocks.push(block);
      return false;
    }
    const next = [
      // A block of an older revision of the same recipe no longer applies.
      ...stored.filter((entry) => entry.recipeId !== press.recipeId),
      block,
    ].slice(-MAX_ENTRY_BLOCKS);
    entryBlocks = Promise.resolve(next);
    try {
      await runtime.entryBlockRecords.write(next);
      return true;
    } catch {
      unsavedBlocks.push(block);
      return false;
    }
  }
  /** Logs one sign-in entry decision (ADR 0031). */
  function reportEntry(
    tabId: number,
    recipe: { origin: string; id?: string; recipeId?: string; revision: number },
    outcome: "pressed" | "refused" | "blocked",
    reason?: string,
    extra: { detail?: string; repeat?: true } = {},
  ): void {
    report(
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
  async function settleEntry(
    press: EntryPress,
    verdict: EntryBlockReason | "passed",
    refused?: LoginDocument,
  ): Promise<void> {
    clearTimeout(entryTimers.get(press.tabId));
    entryTimers.delete(press.tabId);
    const latest = entryPresses.get(press.tabId);
    if (latest?.pressedAt !== press.pressedAt || latest.checked) return;
    entryPresses.set(press.tabId, { ...latest, checked: true });
    // Recorded before anything is awaited, so no announcement of the page slips past it.
    if (verdict !== "passed" && refused) {
      entryRefused.add(documentKey(refused));
      for (const old of entryRefused) {
        if (entryRefused.size <= 256) break;
        entryRefused.delete(old);
      }
    }
    await quietly(runtime.saveSession);
    if (verdict === "passed") return;
    const stored = await blockEntry(press, verdict).catch(() => false);
    reportEntry(
      press.tabId,
      press,
      "blocked",
      verdict,
      stored ? {} : { detail: "storage-unavailable" },
    );
  }
  /** Whether the check of a page after the tab's entry press is running. */
  const entryChecked = (tabId: number) =>
    [...entryChecks.keys()].some((key) => key.startsWith(`${tabId} `));
  /**
   * Checks an entry press whose next page did not announce in time (ADR 0031). A tab now on
   * another site's web page blocks it as `left-site`; one still on the pressed URL, or with
   * no page announced once more the step wait after a same-site move, as `no-sign-in`.
   * While a page's check runs, that check settles the press, or arms this again.
   */
  async function lateEntry(press: EntryPress, extended: boolean): Promise<void> {
    entryTimers.delete(press.tabId);
    const latest = entryPresses.get(press.tabId);
    if (latest?.pressedAt !== press.pressedAt || latest.checked || entryChecked(press.tabId))
      return;
    let url: string | undefined;
    try {
      url = (await browser.tabs.get(press.tabId)).url;
    } catch {
      // The tab closed; its press goes with it.
      return;
    }
    // A tab with no URL yet, or one that does not parse, shows nothing to judge.
    let parsed: URL | undefined;
    try {
      parsed = url ? new URL(url) : undefined;
    } catch {
      parsed = undefined;
    }
    const web = parsed !== undefined && /^https?:$/u.test(parsed.protocol);
    if (web && siteOf(parsed!) !== siteOf(press.origin)) return settleEntry(press, "left-site");
    // A page of the site that has not announced yet, as one still loading, and a tab
    // without a URL to read get their own wait.
    if (!extended && (parsed === undefined || (web && url !== press.url))) {
      entryTimers.set(
        press.tabId,
        setTimeout(() => void lateEntry(press, true).catch(() => undefined), LOGIN_STEP_WAIT_MS),
      );
      return;
    }
    return settleEntry(press, "no-sign-in");
  }
  function armEntryTimer(press: EntryPress): void {
    clearTimeout(entryTimers.get(press.tabId));
    const due = isoTimeMs(press.pressedAt) + ENTRY_NEXT_PAGE_MS - Date.now();
    entryTimers.set(
      press.tabId,
      setTimeout(() => void lateEntry(press, false).catch(() => undefined), Math.max(0, due)),
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
  async function checkAfterPress(live: LiveDocument): Promise<void> {
    const { tabId, documentId, frameId, origin: pageOrigin } = live.document;
    const press = entryPresses.get(tabId);
    if (frameId !== 0 || live.topUrl !== undefined || !press || press.checked) return;
    if (documentId === press.documentId && live.url === press.url) return;
    const key = documentKey(live.document);
    const running = entryChecks.get(key);
    if (running) return running;
    const check = (async (): Promise<void> => {
      // A page after the window settles the press but is never refused, on any site.
      if (Date.now() - isoTimeMs(press.pressedAt) > ENTRY_NEXT_PAGE_MS + LOGIN_STEP_WAIT_MS)
        return settleEntry(press, "no-sign-in");
      if (siteOf(pageOrigin) !== siteOf(press.origin))
        return settleEntry(press, "left-site", live.document);
      const starts = await runtime.startsFor(pageOrigin);
      let answer: unknown;
      try {
        answer = await send(live, {
          type: "login.entry.check",
          starts,
          timeoutMs: LOGIN_STEP_WAIT_MS,
        });
      } catch {
        return;
      }
      const parsed = v.safeParse(entryCheckResultSchema, answer);
      if (!parsed.success) return;
      if (parsed.output.signUp) return settleEntry(press, "sign-up", live.document);
      return parsed.output.signIn || parsed.output.start
        ? settleEntry(press, "passed")
        : settleEntry(press, "no-sign-in", live.document);
    })();
    entryChecks.set(key, check);
    try {
      await check;
    } finally {
      if (entryChecks.get(key) === check) entryChecks.delete(key);
      // A check that settled nothing, or that ran while the timer came due, leaves the
      // press to the timer again.
      const latest = entryPresses.get(tabId);
      if (
        latest?.pressedAt === press.pressedAt &&
        !latest.checked &&
        !entryTimers.has(tabId) &&
        !entryChecked(tabId)
      )
        armEntryTimer(latest);
    }
  }
  /**
   * The hosts among those the page's URL and links name that are on its site, by
   * registrable domain; the content script counts every other host as another site's.
   */
  async function hostsOnSite(live: LiveDocument): Promise<string[] | undefined> {
    const parsed = v.safeParse(
      entryHostsResultSchema,
      await send(live, { type: "login.entry.hosts" }).catch(() => undefined),
    );
    if (!parsed.success) return undefined;
    const onSite = sameSiteAs(live.url);
    return parsed.output.hosts.filter((host) => {
      try {
        return onSite(new URL(`https://${host}`));
      } catch {
        return false;
      }
    });
  }
  /**
   * Whether a vault item's URI matches the page, which needs an unlocked vault; no field is
   * read. `undefined` when the settings could not be read.
   */
  async function vaultMatches(live: LiveDocument): Promise<boolean | undefined> {
    if (!uris) return false;
    const snapshot = await settings.handle({ version: 1, type: "settings.get" });
    if (!snapshot.ok) return undefined;
    const scope = await findLiveSiteCandidates({
      settings: snapshot.snapshot.settings,
      catalog: snapshot.catalog,
      url: live.url,
      match: uris,
    });
    return scope.ok && scope.candidates.length > 0;
  }
  /**
   * Why the page may not be sent as a site's sign-in entry beyond ADR 0016's conditions
   * (ADR 0031), cheapest first: its URL no longer names another path of its site; it is the
   * next page after a manual sign-in; the tab holds an attempt record for its site; any tab
   * keeps a logout of the site; or no vault item matches.
   */
  async function entryOfferRefusal(live: LiveDocument): Promise<string | undefined> {
    const site = siteOf(live.document.origin);
    if (site === undefined || !namesReturnPath(new URL(live.url), sameSiteAs(live.url)))
      return "no-return-target";
    // The page right after a sign-in (ADR 0028); the document skips its own next path.
    if (runtime.afterSignIn.get(live.document.tabId) === live.document.documentId)
      return "after-sign-in";
    if (siteRecorded(live.document.tabId, site)) return "site-record";
    if (siteLoggedOut(site)) return "logged-out";
    const matched = await vaultMatches(live).catch(() => undefined);
    return matched ? undefined : "no-vault-match";
  }
  /**
   * Sends the page as a site's sign-in entry (ADR 0031): its buttons and links, without
   * slots. A returned entry recipe is in the recipe cache by then; the document announces
   * again and its entry is pressed.
   */
  async function generateEntryFor(live: LiveDocument): Promise<void> {
    if (!generation) return;
    const key = frameKey(live.document);
    let sent = false;
    try {
      const onSite = await hostsOnSite(live);
      if (documents.get(key) !== live) return;
      if (!onSite) {
        runtime.skipGeneration(live, "extract-failed", "entry");
        return;
      }
      const extracted = v.safeParse(
        extractResultSchema,
        await send(live, { type: "login.extract", page: "entry", onSite }),
      );
      if (documents.get(key) !== live) return;
      if (!extracted.success || !extracted.output.ok) {
        runtime.skipGeneration(
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
        runtime.skipGeneration(live, "incomplete-observation", "entry", detail);
        return;
      }
      const { observation } = accepted;
      // Only a link is ever pressed, so a page without one is not worth a model call.
      if (!observation.candidates.some((candidate) => candidate.role === "link")) {
        runtime.skipGeneration(live, "no-entry-link", "entry");
        return;
      }
      const spin = spinning(live.document.tabId);
      const result = await generation
        .generateEntry(
          { version: 1, observation },
          spin.sent(() =>
            report(live.document, {
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
      sent = true;
      report(live.document, {
        type: "generation",
        tabId: live.document.tabId,
        origin: live.document.origin,
        ...outcomeFields(result),
        page: "entry",
      });
      if (result.outcome !== "recipe" || documents.get(key) !== live) return;
      await browser.tabs.sendMessage(
        live.document.tabId,
        { version: 1, type: "login.reconnect" },
        { documentId: live.document.documentId, frameId: live.document.frameId },
      );
    } catch (error) {
      if (!sent && documents.get(key) === live)
        if (error instanceof DocumentGone)
          runtime.skipGeneration(live, "unreachable", "entry", error.reason);
        else runtime.skipGeneration(live, "exception", "entry");
    }
  }
  /**
   * Logs why the document's sign-in entry was not pressed; a reason the document already
   * logged is marked as a repeat, which the log keeps at debug (ADR 0019).
   */
  function refuseEntry(live: LiveDocument, recipe: LoginEntryRecipe, reason: string): void {
    const repeat = live.entryRefusals?.includes(reason) === true;
    if (!repeat) live.entryRefusals = [...(live.entryRefusals ?? []), reason];
    reportEntry(live.document.tabId, recipe, "refused", reason, repeat ? { repeat } : {});
  }
  /**
   * Why the entry may not be pressed now, from what the worker knows (ADR 0031), cheapest
   * first; checked again after the page was inspected.
   */
  async function entryPressRefusal(
    live: LiveDocument,
    recipe: LoginEntryRecipe,
    url: string,
  ): Promise<string | undefined> {
    const { tabId, frameId, origin: pageOrigin } = live.document;
    if (frameId !== 0 || live.topUrl !== undefined) return "frame";
    const blocks = await readEntryBlocks();
    if (!blocks) return "storage-unavailable";
    if (
      [...blocks, ...unsavedBlocks].some(
        (entry) => entry.recipeId === recipe.id && entry.revision === recipe.revision,
      )
    )
      return "blocked";
    if (new URL(url).pathname !== recipe.entry.path) return "page-changed";
    const cached = (await recipes.entries(pageOrigin).catch(() => [])).find(
      (entry) => entry.id === recipe.id,
    );
    if (
      !cached ||
      cached.revision !== recipe.revision ||
      JSON.stringify(cached.entry) !== JSON.stringify(recipe.entry)
    )
      return "recipe-changed";
    // A manual logout that lands on the bare top page is never undone.
    if (!namesReturnPath(new URL(url), sameSiteAs(url))) return "no-return-target";
    const site = siteOf(pageOrigin);
    if (site === undefined) return "no-site";
    if (siteRecorded(tabId, site)) return "site-record";
    if (siteHeldElsewhere(tabId, site)) return "site-held";
    if (siteLoggedOut(site)) return "logged-out";
    const last = entryPresses.get(tabId);
    if (last && Date.now() - isoTimeMs(last.pressedAt) < ENTRY_PRESS_MS) return "press-limit";
    const snapshot = await settings
      .handle({ version: 1, type: "settings.get" })
      .catch(() => undefined);
    if (!snapshot?.ok) return "settings-unavailable";
    if (isSiteExcluded(snapshot.snapshot.settings, url)) return "site-excluded";
    if (!(await vaultMatches({ ...live, url }).catch(() => false))) return "no-vault-match";
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
  async function pressEntry(live: LiveDocument, recipe: LoginEntryRecipe): Promise<void> {
    const { tabId, documentId } = live.document;
    const running = pressing.get(tabId);
    // The same document announcing again leaves its press to the check already running.
    if (running === documentId) return;
    if (running !== undefined) return refuseEntry(live, recipe, "in-progress");
    pressing.set(tabId, documentId);
    const key = frameKey(live.document);
    // The same document announcing again keeps the press going.
    const shown = () => documents.get(key)?.document.documentId === live.document.documentId;
    try {
      const pageUrl = async () => {
        const tab = await browser.tabs.get(tabId);
        return tab.url && new URL(tab.url).origin === live.document.origin ? tab.url : undefined;
      };
      let before: string | undefined;
      try {
        before = await pageUrl();
      } catch {
        if (shown()) refuseEntry(live, recipe, "tab-unavailable");
        return;
      }
      if (!shown()) return;
      // The tab moved to another origin since the document announced.
      if (!before) return refuseEntry(live, recipe, "page-changed");
      const early = await entryPressRefusal(live, recipe, before);
      if (early) return refuseEntry(live, recipe, early);
      const inspected = v.safeParse(
        entryInspectResultSchema,
        await send(live, {
          type: "login.entry.inspect",
          target: recipe.entry.target,
          timeoutMs: LOGIN_STEP_WAIT_MS,
        }).catch(() => undefined),
      );
      if (!shown()) return;
      if (!inspected.success) return refuseEntry(live, recipe, "no-answer");
      const { state, refusal, href, url } = inspected.output;
      if (state !== "unique") return refuseEntry(live, recipe, `target-${state}`);
      if (refusal) return refuseEntry(live, recipe, refusal);
      if (!href) return refuseEntry(live, recipe, "not-link");
      let destination: URL;
      try {
        destination = new URL(href);
      } catch {
        return refuseEntry(live, recipe, "link-off-site");
      }
      const linkCheck = linkRefusal(destination, sameSiteAs(url), new URL(url));
      if (linkCheck) return refuseEntry(live, recipe, linkCheck);
      // The page's own URL, as the content script reads it, must still name the path too.
      if (new URL(url).origin !== live.document.origin)
        return refuseEntry(live, recipe, "page-changed");
      const late = await entryPressRefusal(live, recipe, url);
      if (late) return refuseEntry(live, recipe, late);
      const snapshot = await settings
        .handle({ version: 1, type: "settings.get" })
        .catch(() => undefined);
      if (!snapshot?.ok) return refuseEntry(live, recipe, "settings-unavailable");
      if (isSiteExcluded(snapshot.snapshot.settings, destination.href))
        return refuseEntry(live, recipe, "destination-excluded");
      if (!shown()) return;
      const press: EntryPress = {
        tabId,
        origin: live.document.origin,
        recipeId: recipe.id,
        revision: recipe.revision,
        pressedAt: isoTime(Date.now()),
        documentId: live.document.documentId,
        url,
      };
      // Stored first, so a restarted worker still counts the press and checks its next page.
      const previous = entryPresses.get(tabId);
      entryPresses.set(tabId, press);
      try {
        await runtime.saveSession();
      } catch {
        if (previous) entryPresses.set(tabId, previous);
        else entryPresses.delete(tabId);
        return refuseEntry(live, recipe, "storage-unavailable");
      }
      const pressed = v.safeParse(
        entryPressResultSchema,
        await send(live, {
          type: "login.entry.press",
          target: recipe.entry.target,
          href,
          url,
        }).catch(() => undefined),
      );
      if (pressed.success && !pressed.output.ok) {
        // Nothing was clicked, so the press does not count.
        if (entryPresses.get(tabId) === press) {
          if (previous) entryPresses.set(tabId, previous);
          else entryPresses.delete(tabId);
          await quietly(runtime.saveSession);
        }
        return refuseEntry(live, recipe, pressed.output.reason ?? "target-changed");
      }
      if (!pressed.success) {
        // No answer says the link was clicked, so the press is not taken as one: its next
        // page is not checked. It still counts against the tab's limit, so a page that
        // never answers is not pressed again and again.
        if (entryPresses.get(tabId) === press) {
          entryPresses.set(tabId, { ...press, checked: true });
          await quietly(runtime.saveSession);
        }
        return refuseEntry(live, recipe, "unconfirmed");
      }
      reportEntry(tabId, recipe, "pressed");
      armEntryTimer(press);
    } finally {
      if (pressing.get(tabId) === documentId) pressing.delete(tabId);
    }
  }
  return {
    armEntryTimer,
    checkAfterPress,
    pressEntry,
    refuseEntry,
    entryOfferRefusal,
    generateEntryFor,
  };
}
