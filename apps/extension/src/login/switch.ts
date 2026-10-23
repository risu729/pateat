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

// Account switching from the toolbar popup (ADR 0063), and the account picks a browser
// session keeps per site (ADR 0063, Q5). The runtime decides when a switch may start; this
// module keeps the picks and runs the logout, one click at a time.

/**
 * A switch's pick, per tab: the account the tab's next login page of the site logs in with,
 * for {@link SWITCH_PICK_MS} after the switch started. Session storage survives a worker
 * restart, and the browser drops it when it closes.
 */
export const SWITCH_PICKS_KEY = "session:pateat.login-switch-picks.v1";
/**
 * The account picked for a site in this browser session, in the popup or by a switch,
 * without making it the default, per site and incognito or not: automatic logins and passkey
 * requests use it before the saved default until the browser closes.
 */
export const SESSION_PICKS_KEY = "session:pateat.login-session-picks.v1";
/** How long a switch's pick waits for the site's login page. */
export const SWITCH_PICK_MS = 2 * 60_000;
/** Clicks a logout makes at most: the menu, the logout and its confirmation. */
export const MAX_LOGOUT_ROUNDS = MAX_LOGOUT_TARGETS;
/** Session picks kept at most; the oldest go first. */
const MAX_SESSION_PICKS = 200;

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

export const sessionPickSchema = v.strictObject({
  site: siteSchema,
  incognito: v.boolean(),
  connectionId: id,
  itemId: id,
  /**
   * The site's saved defaults when the pick was kept ({@link siteDefaultsMark}): a default
   * saved since, as in the popup, ends the pick.
   */
  defaults: v.pipe(v.string(), v.maxLength(8000)),
});
export type SessionPick = v.InferOutput<typeof sessionPickSchema>;

/**
 * The saved defaults of every origin of `site`, as a session pick compares them: a default
 * saved, changed or removed since the pick was kept ends it.
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

/** An account of the vault. */
export type PickedItem = { connectionId: string; itemId: string };

/**
 * The switch and session picks, read from session storage once and written through. A
 * storage failure only loses a pick: a login then uses the saved default, as without one.
 */
export function createAccountPicks(now: () => number = Date.now) {
  const switches = new Map<number, SwitchPick>();
  let sessions: SessionPick[] = [];
  const loaded = (async () => {
    try {
      const items = await storage.getItems([SWITCH_PICKS_KEY, SESSION_PICKS_KEY]);
      const stored = Object.fromEntries(items.map(({ key, value }) => [key, value]));
      const picks = v.safeParse(
        v.pipe(v.array(switchPickSchema), v.maxLength(256)),
        stored[SWITCH_PICKS_KEY] ?? [],
      );
      if (picks.success) for (const pick of picks.output) switches.set(pick.tabId, pick);
      const kept = v.safeParse(
        v.pipe(v.array(sessionPickSchema), v.maxLength(MAX_SESSION_PICKS)),
        stored[SESSION_PICKS_KEY] ?? [],
      );
      if (kept.success) sessions = kept.output;
    } catch {
      // Unreadable session storage holds no pick.
    }
  })();
  let writes: Promise<unknown> = Promise.resolve();
  const save = () => {
    const value = [
      { key: SWITCH_PICKS_KEY as typeof SWITCH_PICKS_KEY, value: [...switches.values()] },
      { key: SESSION_PICKS_KEY as typeof SESSION_PICKS_KEY, value: [...sessions] },
    ];
    writes = writes.then(() => storage.setItems(value)).catch(() => undefined);
    return writes;
  };
  const sameScope = (site: string, incognito: boolean) => (pick: SessionPick) =>
    pick.site === site && pick.incognito === incognito;
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
    /**
     * The site's session pick, in incognito windows or in the others, while the site's
     * saved defaults are still those it was kept with (`defaults`); one older is dropped.
     */
    async sessionFor(
      site: string | undefined,
      incognito: boolean,
      defaults: string,
    ): Promise<PickedItem | undefined> {
      await loaded;
      if (site === undefined) return undefined;
      const pick = sessions.find(sameScope(site, incognito));
      if (!pick) return undefined;
      if (pick.defaults !== defaults) {
        sessions = sessions.filter((entry) => entry !== pick);
        void save();
        return undefined;
      }
      return { connectionId: pick.connectionId, itemId: pick.itemId };
    },
    /** Keeps an account picked without making it the default for the rest of the session. */
    async keepSession(pick: SessionPick): Promise<void> {
      await loaded;
      sessions = [
        ...sessions.filter((entry) => !sameScope(pick.site, pick.incognito)(entry)),
        pick,
      ].slice(-MAX_SESSION_PICKS);
      await save();
    },
    /** Drops the site's session pick, as when a pick was made the default. */
    async dropSession(site: string, incognito: boolean): Promise<void> {
      await loaded;
      const kept = sessions.filter((entry) => !sameScope(site, incognito)(entry));
      if (kept.length === sessions.length) return;
      sessions = kept;
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

/** The tab a switch signs out in, as the runtime drives it. */
export interface LogoutDriver<Page extends LogoutPage> {
  /** The tab's top page of the site now, or nothing once the tab left the site or closed. */
  page(): Page | undefined;
  /** The page's description for the logout role, or why there is none. */
  describe(page: Page): Promise<{ observation: LoginObservation } | { unsent: string }>;
  /** Presses a recipe's click on the page; a page that went meanwhile counts as clicked. */
  click(page: Page, target: LogoutTarget["target"]): Promise<LogoutPress>;
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
 * page's origin and path, or, past its end, from the logout role, which may append it to the
 * recipe. After each click the page settles: a sign-in input or a recipe's first step ends
 * the logout, as does the tab leaving the site after a logout or confirmation, or a stored
 * recipe that ran to its end on one. A logout learned in this run is checked with one more
 * question, which may answer `signed-out` or a confirmation to click.
 */
export async function runLogout<Page extends LogoutPage>(
  driver: LogoutDriver<Page>,
  service: LogoutService,
  clicked?: (purpose: LogoutPurpose, learned: boolean) => void,
): Promise<LogoutRun> {
  let page = driver.page();
  let recipe: LoginLogoutRecipe | undefined;
  let learned = false;
  let clicks = 0;
  let last: LogoutPurpose | undefined;
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
  for (;;) {
    let next = recipe?.logout.targets[clicks];
    // A recipe that ran to its end on a confirmation, or on a logout it knew before this
    // run, signed out: nothing follows them.
    if (!next && (last === "confirm" || (last === "logout" && !learned))) return done();
    if (!next) {
      const described = await driver.describe(page);
      if ("unsent" in described) {
        // A page after a logout with nothing to describe, as a bare "signed out" page.
        if (last === "logout") return done();
        return clicks === 0 && described.unsent === "no-candidates"
          ? failed("no-logout-control", described.unsent)
          : failed("page-unreadable", described.unsent);
      }
      const answer = await service
        .generate({
          version: 1,
          observation: described.observation,
          ...(recipe && clicks > 0
            ? { base: { recipeId: recipe.id, revision: recipe.revision } }
            : {}),
        })
        .catch((): LogoutOutcome => ({ outcome: "failed", reason: "error" }));
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
      next = fresh.logout.targets[clicks];
      // The answer adds no click: every one the recipe holds ran already.
      if (!next || fresh.origin !== page.document.origin)
        return failed(clicks === 0 ? "no-logout-control" : "still-signed-in");
      recipe = fresh;
      learned = true;
    }
    // A stored click belongs to the page the recipe saw before it.
    if (next.path !== page.path) return failed("page-changed");
    const pressed = await driver.click(page, next.target);
    if (pressed !== "clicked")
      return failed(pressed === "page-changed" ? "page-changed" : "target-missing", pressed);
    clicks += 1;
    last = next.purpose;
    clicked?.(next.purpose, learned);
    const after = await driver.settle(page);
    // The tab left the site: a logout may sign out through another one, a menu never does.
    if (!after) return last === "menu" ? failed("left-site") : done();
    if (after.signIn) return done();
    page = after.page;
    if (clicks >= MAX_LOGOUT_ROUNDS && last === "menu") return failed("still-signed-in");
  }
}
