// The pause of automatic login (ADR 0062): the person stops, for a length they choose, what Pateat starts
// by itself on a registrable site, in all of its tabs. Normal and incognito windows share
// `storage.session` in spanning mode but not cookies, so each keeps its own pause.
import * as v from "valibot";
import { domainKey } from "@pateat/bitwarden";
import { isSiteExcluded, isSupportedSite, type LocalSettings } from "@pateat/contracts";
import { isoTime, isoTimeMs, isoTimeSchema } from "../time";
import { PAUSE_LENGTHS, pauseLengthSchema, type PauseLength } from "./choice-wire";

export { PAUSE_LENGTHS, type PauseLength } from "./choice-wire";

/** Paused sites, until the browser closes; never sent to the service or other devices. */
export const LOGIN_PAUSES_KEY = "session:pateat.login-pauses.v1";

/** Pauses kept at most; the one that ends first goes first. */
const MAX_PAUSES = 256;

const pauseSchema = v.strictObject({
  /** The registrable domain, as Bitwarden's Domain match compares it. */
  site: v.pipe(v.string(), v.minLength(1), v.maxLength(253)),
  incognito: v.boolean(),
  /** The length the person chose, for the log; `until` decides when it ends. */
  length: pauseLengthSchema,
  until: isoTimeSchema,
});
type Pause = v.InferOutput<typeof pauseSchema>;
const storedSchema = v.pipe(v.array(pauseSchema), v.maxLength(MAX_PAUSES));

/** The registrable domain of an origin or URL, or undefined for one without a site. */
export function pauseSite(value: string | URL): string | undefined {
  const url = typeof value === "string" ? URL.parse(value) : value;
  if (!url || (url.protocol !== "https:" && url.protocol !== "http:")) return undefined;
  // Keep domain matching failures separate from an invalid URL.
  try {
    return domainKey(url) || undefined;
  } catch {
    return undefined;
  }
}

/** What pauses automatic login of a page (ADR 0062). */
export type PauseState =
  /** A pause of a length the person chose, until then, in epoch milliseconds. */
  | { readonly until: number }
  /** An exclusion rule of the settings covers the site: paused until turned back on. */
  | { readonly rule: true }
  /**
   * The page is in a private window, where automatic login is off until the setting is
   * turned on (ADR 0062).
   */
  | { readonly private: true };

/**
 * Whether an exclusion rule of the settings covers the page, which pauses automatic login
 * there until the rule is removed (ADR 0062). A page Pateat does not run on is not paused.
 */
export function pausedByRule(settings: Pick<LocalSettings, "excludedSites">, url: string): boolean {
  return isSupportedSite(url) && isSiteExcluded(settings, url);
}

/**
 * Whether a page of a private window is paused because automatic login is off in private
 * windows, the default (ADR 0062). A window whose kind is not known is not counted.
 */
export function pausedInPrivate(
  settings: Pick<LocalSettings, "loginInPrivateWindows">,
  incognito: boolean | undefined,
): boolean {
  return incognito === true && settings.loginInPrivateWindows !== true;
}

export type LoginPauses = ReturnType<typeof createLoginPauses>;

/**
 * The paused sites, read once from session storage so a pause survives a worker restart.
 * A pause ends by itself once its time has passed: every check compares the time, so no
 * alarm is needed. Writes land in order; a failed write leaves the memory as it was. A store
 * that could not be read is read again before any check or write, and nothing is written
 * until it was read, so a failed read never drops the pauses it holds. `incognito` is
 * `undefined` when the window kind is not known: either kind's pause then counts.
 */
export function createLoginPauses(
  store: { getValue(): Promise<unknown>; setValue(value: unknown): Promise<void> },
  now: () => number = Date.now,
) {
  const pauses = new Map<string, Pause>();
  const key = (site: string, incognito: boolean) => `${incognito ? "incognito" : "normal"} ${site}`;
  /** Reads the store into memory; false when it could not be read. */
  async function read(): Promise<boolean> {
    let stored: unknown;
    try {
      stored = await store.getValue();
    } catch {
      return false;
    }
    // Damaged contents hold no pause; the next write replaces them.
    const parsed = v.safeParse(storedSchema, stored);
    pauses.clear();
    if (parsed.success)
      for (const entry of parsed.output) pauses.set(key(entry.site, entry.incognito), entry);
    return true;
  }
  let reading = read();
  /** Whether the store was read, reading it again after a failed read. */
  async function ready(): Promise<boolean> {
    if (await reading) return true;
    reading = read();
    return reading;
  }
  let writes: Promise<unknown> = Promise.resolve();
  /** Stores the pauses that still run, changed by `edit`; memory changes once stored. */
  async function save(edit: (draft: Map<string, Pause>) => void): Promise<void> {
    if (!(await ready())) throw new Error("The paused sites could not be read");
    const draft = new Map(pauses);
    edit(draft);
    const at = now();
    for (const [entryKey, entry] of draft) if (isoTimeMs(entry.until) <= at) draft.delete(entryKey);
    const kept = [...draft.values()]
      .toSorted((a, b) => isoTimeMs(b.until) - isoTimeMs(a.until))
      .slice(0, MAX_PAUSES);
    await store.setValue(kept);
    pauses.clear();
    for (const entry of kept) pauses.set(key(entry.site, entry.incognito), entry);
  }
  /** Saves after the writes before it, in order. */
  function commit(edit: (draft: Map<string, Pause>) => void): Promise<void> {
    const write = writes.then(() => save(edit));
    writes = write.catch(() => undefined);
    return write;
  }
  const kinds = (incognito: boolean | undefined) =>
    incognito === undefined ? [false, true] : [incognito];
  /** When the site's pause ends, in epoch milliseconds, while it runs. */
  function untilFor(site: string | undefined, incognito: boolean): number | undefined {
    if (site === undefined) return undefined;
    const entry = pauses.get(key(site, incognito));
    if (!entry) return undefined;
    const until = isoTimeMs(entry.until);
    return until > now() ? until : undefined;
  }
  return {
    /**
     * When the pause covering a page ends, while it runs: the latest end among the sites of
     * `urls`, such as a frame's own URL and its tab's (a frame is paused when either is).
     * A store that cannot be read holds no pause.
     */
    async until(urls: readonly (string | URL | undefined)[], incognito: boolean | undefined) {
      await ready();
      const ends = urls.flatMap((url) =>
        kinds(incognito).flatMap((kind) => {
          const until = url === undefined ? undefined : untilFor(pauseSite(url), kind);
          return until === undefined ? [] : [until];
        }),
      );
      return ends.length ? Math.max(...ends) : undefined;
    },
    /**
     * Pauses the site of `url` for the chosen length from now, replacing a running pause of
     * it; its end, or undefined for no site.
     */
    async pause(
      url: string | URL,
      incognito: boolean,
      length: PauseLength,
    ): Promise<number | undefined> {
      const site = pauseSite(url);
      if (site === undefined) return undefined;
      const until = now() + PAUSE_LENGTHS[length];
      await commit((draft) =>
        draft.set(key(site, incognito), { site, incognito, length, until: isoTime(until) }),
      );
      return until;
    },
    /**
     * Ends the pause of the site of `url`, of either window kind when `incognito` is not
     * known; true when one was running.
     */
    async resume(url: string | URL, incognito: boolean | undefined): Promise<boolean> {
      const site = pauseSite(url);
      if (!(await ready())) throw new Error("The paused sites could not be read");
      const running =
        site === undefined
          ? []
          : kinds(incognito).filter((kind) => untilFor(site, kind) !== undefined);
      if (site === undefined || !running.length) return false;
      await commit((draft) => {
        for (const kind of running) draft.delete(key(site, kind));
      });
      return true;
    },
  };
}
