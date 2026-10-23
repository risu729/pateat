import {
  MAX_LOGOUT_TARGETS,
  type LoginLogoutRecipe,
  type LoginObservation,
  type LogoutGenerationRequest,
  type LogoutPurpose,
  type LogoutTarget,
} from "@pateat/contracts";
import * as v from "valibot";
import { storage } from "wxt/utils/storage";

// Account switching from the toolbar popup (ADR 0063), and the sites a browser session asks
// on after a pick that did not make its account the default (ADR 0063, Q5). The runtime
// decides when a switch may start; this module keeps the picks and runs the logout, one
// click at a time.

/**
 * A switch's pick, per tab: the account the tab's next login page of the site logs in with,
 * for {@link SWITCH_PICK_MS} after the switch started. Session storage survives a worker
 * restart, and the browser drops it when it closes.
 */
export const SWITCH_PICKS_KEY = "session:pateat.login-switch-picks.v1";
/**
 * The sites, per incognito or not, where an account was picked in the popup or by a switch
 * without making it the default: until the browser closes, or a default is saved or picked
 * for the site, no automatic login starts there; each one asks, filling nothing, and the
 * person's own passkey requests open the chooser with no default.
 */
export const ASK_EVERY_TIME_KEY = "session:pateat.login-ask-every-time.v1";
/** How long a switch's pick waits for the site's login page. */
export const SWITCH_PICK_MS = 2 * 60_000;
/** Clicks a logout makes at most: the menu, the logout and its confirmation. */
export const MAX_LOGOUT_ROUNDS = MAX_LOGOUT_TARGETS;
/** Asking sites kept at most; the oldest go first. */
const MAX_ASKING_SITES = 200;

const id = v.pipe(v.string(), v.minLength(1), v.maxLength(120));
const tabIdSchema = v.pipe(v.number(), v.integer(), v.minValue(0));
const siteSchema = v.pipe(v.string(), v.minLength(1), v.maxLength(253));

export const switchPickSchema = v.strictObject({
  tabId: tabIdSchema,
  site: siteSchema,
  incognito: v.boolean(),
  connectionId: id,
  itemId: id,
  /** Save the account as the site default once its login is confirmed `authenticated`. */
  makeDefault: v.boolean(),
  /** Until when, in epoch milliseconds, the next login page takes the pick. */
  until: v.pipe(v.number(), v.integer(), v.minValue(0)),
});
export type SwitchPick = v.InferOutput<typeof switchPickSchema>;

export const askingSiteSchema = v.strictObject({
  site: siteSchema,
  incognito: v.boolean(),
  /**
   * The site's saved defaults when the pick signed in ({@link siteDefaultsMark}): a default
   * saved, changed or removed since, as in the popup, ends the asking.
   */
  defaults: v.pipe(v.string(), v.maxLength(8000)),
});
export type AskingSite = v.InferOutput<typeof askingSiteSchema>;

/**
 * The saved defaults of every origin of `site`, as an asking site compares them: a default
 * saved, changed or removed since the pick ends the asking.
 */
export function siteDefaultsMark(
  siteDefaults: readonly { origin: string; itemId: string; provider: string; userId: string }[],
  site: string,
  siteOf: (origin: string) => string | undefined,
): string {
  return JSON.stringify(
    siteDefaults
      .filter((entry) => siteOf(entry.origin) === site)
      .map((entry) => [entry.origin, entry.provider, entry.userId, entry.itemId])
      .sort((left, right) => (left[0]! < right[0]! ? -1 : left[0]! > right[0]! ? 1 : 0)),
  );
}

/**
 * The switch picks and asking sites, read from session storage once and written through. A
 * storage failure only loses them: a login then uses the saved default, as without them.
 */
export function createAccountPicks(now: () => number = Date.now) {
  const switches = new Map<number, SwitchPick>();
  let asking: AskingSite[] = [];
  const loaded = (async () => {
    try {
      const items = await storage.getItems([SWITCH_PICKS_KEY, ASK_EVERY_TIME_KEY]);
      const stored = Object.fromEntries(items.map(({ key, value }) => [key, value]));
      const picks = v.safeParse(
        v.pipe(v.array(switchPickSchema), v.maxLength(256)),
        stored[SWITCH_PICKS_KEY] ?? [],
      );
      if (picks.success) for (const pick of picks.output) switches.set(pick.tabId, pick);
      const kept = v.safeParse(
        v.pipe(v.array(askingSiteSchema), v.maxLength(MAX_ASKING_SITES)),
        stored[ASK_EVERY_TIME_KEY] ?? [],
      );
      if (kept.success) asking = kept.output;
    } catch {
      // Unreadable session storage holds no pick.
    }
  })();
  let writes: Promise<unknown> = Promise.resolve();
  const save = () => {
    const value = [
      { key: SWITCH_PICKS_KEY as typeof SWITCH_PICKS_KEY, value: [...switches.values()] },
      { key: ASK_EVERY_TIME_KEY as typeof ASK_EVERY_TIME_KEY, value: [...asking] },
    ];
    writes = writes.then(() => storage.setItems(value)).catch(() => undefined);
    return writes;
  };
  const sameScope = (site: string, incognito: boolean) => (entry: AskingSite) =>
    entry.site === site && entry.incognito === incognito;
  return {
    /** Starts a switch's pick for the tab, replacing any it had. */
    async startSwitch(pick: Omit<SwitchPick, "until">): Promise<SwitchPick> {
      await loaded;
      const started = { ...pick, until: now() + SWITCH_PICK_MS };
      switches.set(pick.tabId, started);
      await save();
      return started;
    },
    /** The tab's switch pick while it lasts, for a page of `site` in the same window kind. */
    async switchFor(
      tabId: number,
      site: string | undefined,
      incognito: boolean,
    ): Promise<SwitchPick | undefined> {
      await loaded;
      const pick = switches.get(tabId);
      if (!pick) return undefined;
      const left = pick.until - now();
      if (left <= 0 || left > SWITCH_PICK_MS) {
        switches.delete(tabId);
        void save();
        return undefined;
      }
      return pick.site === site && pick.incognito === incognito ? pick : undefined;
    },
    /** Ends the tab's switch pick: a login took it, the tab closed, or the switch failed. */
    async endSwitch(tabId: number): Promise<void> {
      await loaded;
      if (switches.delete(tabId)) await save();
    },
    /** Moves a switch's pick to the tab that replaced its tab, as a prerender does. */
    async moveSwitch(from: number, to: number): Promise<void> {
      await loaded;
      const pick = switches.get(from);
      if (!pick) return;
      switches.delete(from);
      switches.set(to, { ...pick, tabId: to });
      await save();
    },
    /**
     * Whether the site asks every time, in incognito windows or in the others, while its
     * saved defaults are still those it was marked with (`defaults`); one older is dropped.
     */
    async asksEveryTime(
      site: string | undefined,
      incognito: boolean,
      defaults: string,
    ): Promise<boolean> {
      await loaded;
      if (site === undefined) return false;
      const entry = asking.find(sameScope(site, incognito));
      if (!entry) return false;
      if (entry.defaults === defaults) return true;
      asking = asking.filter((other) => other !== entry);
      void save();
      return false;
    },
    /** Makes the site ask every time for the rest of the browser session. */
    async askEveryTime(entry: AskingSite): Promise<void> {
      await loaded;
      asking = [
        ...asking.filter((other) => !sameScope(entry.site, entry.incognito)(other)),
        entry,
      ].slice(-MAX_ASKING_SITES);
      await save();
    },
    /** Ends the site's asking, as when a pick made its account the default. */
    async stopAsking(site: string, incognito: boolean): Promise<void> {
      await loaded;
      const kept = asking.filter((entry) => !sameScope(site, incognito)(entry));
      if (kept.length === asking.length) return;
      asking = kept;
      await save();
    },
  };
}
export type AccountPicks = ReturnType<typeof createAccountPicks>;

/** What came of a logout model request (ADR 0063). */
export type LogoutOutcome =
  | { outcome: "recipe"; recipe: LoginLogoutRecipe }
  | { outcome: "signed-out" }
  | { outcome: "abstained"; reason: string }
  | { outcome: "failed" | "unavailable" | "skipped"; reason: string };

/** The paired service's side of a switch: the stored logout recipes and the logout role. */
export interface LogoutService {
  recipes(origin: string): Promise<LoginLogoutRecipe[]>;
  generate(request: LogoutGenerationRequest): Promise<LogoutOutcome>;
}

/** The page a logout runs on, as the driver knows it: its origin and observed path. */
export type LogoutPage = { readonly document: { readonly origin: string }; readonly path: string };

/** What a logout click on the page came to. */
export type LogoutPress = "clicked" | "missing" | "ambiguous" | "page-changed";

/** How the page reacted within 5 seconds of a click Pateat found itself (`LOGOUT_REACTION_MS`). */
export type LogoutReaction = "navigated" | "dialog" | "changed" | "none";

/** Where a logout click came from: the stored recipe, the model, or the control's words. */
export type LogoutSource = "recipe" | "model" | "local";

/** The tab a switch signs out in, as the runtime drives it. */
export interface LogoutDriver<Page extends LogoutPage> {
  /** The tab's top page of the site now, or nothing once the tab left the site or closed. */
  page(): Page | undefined;
  /** The page's description for the logout role, or why there is none. */
  describe(page: Page): Promise<{ observation: LoginObservation } | { unsent: string }>;
  /** Presses a recipe's click on the page; a page that went meanwhile counts as clicked. */
  click(page: Page, target: LogoutTarget["target"]): Promise<LogoutPress>;
  /**
   * The page's one control that says it logs out by its words, with its locator, or why
   * there is none: no control says so, several do, or it has no locator (ADR 0063).
   */
  findLocal(page: Page): Promise<LogoutTarget["target"] | "none" | "ambiguous" | "unlocated">;
  /**
   * Presses that control and watches the page up to `LOGOUT_REACTION_MS` for a
   * reaction; a page that went meanwhile counts as clicked and navigated.
   */
  pressLocal(
    page: Page,
    target: LogoutTarget["target"],
  ): Promise<{ press: LogoutPress; reacted?: LogoutReaction }>;
  /**
   * Waits for the page after a click to settle, as a new document or a quiet one, and says
   * whether it shows a sign-in input or a recipe's first step; nothing once the tab left the
   * site or closed.
   */
  settle(before: Page): Promise<{ page: Page; signIn: boolean } | undefined>;
}

/**
 * Why a switch stopped before the account was signed out: no control signs out or opens
 * a menu holding one (`no-logout-control`), the site still shows the account after every
 * click (`still-signed-in`), the page could not be described (`page-unreadable`), a stored
 * click's control is gone or not alone (`target-missing`), the page went elsewhere than the
 * recipe knows (`page-changed`), the tab left the site before signing out (`left-site`) or
 * the service could not answer (`service-unavailable`).
 */
export type LogoutFailure =
  | "no-logout-control"
  | "still-signed-in"
  | "page-unreadable"
  | "target-missing"
  | "page-changed"
  | "left-site"
  | "service-unavailable";

export type LogoutRun = {
  clicks: number;
  /** The logout recipe the clicks came from, when there was one. */
  recipe?: { id: string; revision: number };
  /** Whether a click of this run was learned from the model rather than stored. */
  learned?: true;
} & ({ outcome: "signed-out" } | { outcome: "failed"; reason: LogoutFailure; detail?: string });

/**
 * Signs the tab out of its site for an account switch (ADR 0063), at most
 * {@link MAX_LOGOUT_ROUNDS} clicks. Each click comes from the stored logout recipe of the
 * page's origin and path; past its end, from the page's one control that says it logs out
 * by its words (owner 2026-10-23), so the model is asked only when that is unclear; else
 * from the logout role, which may append it to the recipe. A stored click whose control is
 * gone is asked for again once, in its place. After each click the page settles: a sign-in
 * input or a recipe's first step ends the logout, as does the tab leaving the site after a
 * logout or confirmation, or a stored recipe that ran to its end on one. A control found by
 * its words that led to a page without one signed out too; one the page did not react to,
 * or after which the page still shows the account (as a confirmation dialog), sends the
 * page to the model, which keeps the local click in the recipe when it reacted. A logout
 * learned in this run is checked with one more question, which may answer `signed-out` or a
 * confirmation to click.
 */
export async function runLogout<Page extends LogoutPage>(
  driver: LogoutDriver<Page>,
  service: LogoutService,
  clicked?: (purpose: LogoutPurpose, learned: boolean, source: LogoutSource) => void,
): Promise<LogoutRun> {
  let page = driver.page();
  let recipe: LoginLogoutRecipe | undefined;
  let learned = false;
  let clicks = 0;
  let last: LogoutPurpose | undefined;
  let lastSource: LogoutSource | undefined;
  // Local clicks the recipe does not hold, as one the page did not react to.
  let skipped = 0;
  // A local click the page reacted to, which the next model answer's recipe starts with.
  let local: { path: string; target: LogoutTarget["target"] } | undefined;
  // The recipe's click gone from the page, asked for again once (`keep` of the request).
  let replaceAt: number | undefined;
  let regenerated = false;
  const facts = () => ({
    clicks,
    ...(recipe ? { recipe: { id: recipe.id, revision: recipe.revision } } : {}),
    ...(learned ? { learned: true as const } : {}),
  });
  const done = (): LogoutRun => ({ outcome: "signed-out", ...facts() });
  const failed = (reason: LogoutFailure, detail?: string): LogoutRun => ({
    outcome: "failed",
    reason,
    ...(detail ? { detail } : {}),
    ...facts(),
  });
  if (!page) return failed("left-site");
  const start = page;
  const { origin } = start.document;
  recipe = (await service.recipes(origin).catch(() => [])).find(
    (stored) => stored.origin === origin && stored.logout.path === start.path,
  );
  // Each round reads the page the previous click left, so the rounds run in order.
  /* eslint-disable no-await-in-loop */
  for (;;) {
    const index = clicks - skipped;
    let next = replaceAt === undefined ? recipe?.logout.targets[index] : undefined;
    let source: LogoutSource = "recipe";
    // A stored recipe that ran to its end on a confirmation or a logout signed out.
    if (
      !next &&
      replaceAt === undefined &&
      (last === "confirm" || (last === "logout" && lastSource === "recipe"))
    )
      return done();
    // Past the recipe, the page's own logout control by its words, once per page.
    if (!next && replaceAt === undefined && lastSource !== "local" && clicks < MAX_LOGOUT_ROUNDS) {
      const found = await driver.findLocal(page).catch(() => "none" as const);
      if (typeof found !== "string") {
        const pressed = await driver.pressLocal(page, found);
        if (pressed.press === "clicked") {
          clicks += 1;
          last = "logout";
          lastSource = "local";
          clicked?.("logout", learned, "local");
          const before = page;
          const after = await driver.settle(page);
          if (!after || after.signIn) return done();
          page = after.page;
          if (pressed.reacted === "none" || pressed.reacted === undefined) skipped += 1;
          else if (
            pressed.reacted === "navigated" &&
            (await driver.findLocal(page).catch(() => "ambiguous" as const)) === "none"
          )
            // A new page that offers no logout any more is signed out.
            return done();
          else local = { path: before.path, target: found };
          continue;
        }
      }
    }
    if (!next) {
      const described = await driver.describe(page);
      if ("unsent" in described) {
        // A page after a logout with nothing to describe, as a bare "signed out" page.
        if (last === "logout") return done();
        return clicks === 0 && described.unsent === "no-candidates"
          ? failed("no-logout-control", described.unsent)
          : failed("page-unreadable", described.unsent);
      }
      // The recipe's clicks before this page, the local one aside.
      const held = index - (local ? 1 : 0);
      const answer = await service
        .generate({
          version: 1,
          observation: described.observation,
          ...(recipe && (held > 0 || replaceAt !== undefined)
            ? {
                base: {
                  recipeId: recipe.id,
                  revision: recipe.revision,
                  ...(replaceAt === undefined ? {} : { keep: replaceAt }),
                },
              }
            : {}),
          ...(local ? { local } : {}),
        })
        .catch((): LogoutOutcome => ({ outcome: "failed", reason: "error" }));
      local = undefined;
      replaceAt = undefined;
      if (answer.outcome === "signed-out") return done();
      // Past the last click the answer only checks the logout.
      if (clicks >= MAX_LOGOUT_ROUNDS) return failed("still-signed-in");
      if (answer.outcome === "abstained")
        return failed(
          last === "logout" || last === "confirm" ? "still-signed-in" : "no-logout-control",
          answer.reason,
        );
      if (answer.outcome !== "recipe") return failed("service-unavailable", answer.reason);
      const fresh = answer.recipe;
      next = fresh.logout.targets[clicks - skipped];
      // The answer adds no click: every one the recipe holds ran already.
      if (!next || fresh.origin !== page.document.origin)
        return failed(clicks === 0 ? "no-logout-control" : "still-signed-in");
      recipe = fresh;
      learned = true;
      source = "model";
    }
    // A stored click belongs to the page the recipe saw before it.
    if (next.path !== page.path) return failed("page-changed");
    const pressed = await driver.click(page, next.target);
    if (pressed === "missing" || pressed === "ambiguous") {
      // A stored click whose control is gone is asked for again once, in its place.
      if (source === "recipe" && !regenerated) {
        regenerated = true;
        replaceAt = index;
        continue;
      }
      return failed("target-missing", pressed);
    }
    if (pressed !== "clicked") return failed("page-changed", pressed);
    clicks += 1;
    last = next.purpose;
    lastSource = source;
    clicked?.(next.purpose, learned, source);
    const after = await driver.settle(page);
    // The tab left the site: a logout may sign out through another one, a menu never does.
    if (!after) return last === "menu" ? failed("left-site") : done();
    if (after.signIn) return done();
    page = after.page;
    if (clicks >= MAX_LOGOUT_ROUNDS && last === "menu") return failed("still-signed-in");
  } /* eslint-enable no-await-in-loop */
}
