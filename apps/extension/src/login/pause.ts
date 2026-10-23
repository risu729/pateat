// The pause of automatic login (ADR 0062): the person stops, for an hour, what Pateat starts
// by itself on a registrable site, in all of its tabs. Normal and incognito windows share
// `storage.session` in spanning mode but not cookies, so each keeps its own pause.
import * as v from "valibot";
import { domainKey } from "@pateat/bitwarden";
import { isoTime, isoTimeMs, isoTimeSchema } from "../time";

/** Paused sites, until the browser closes; never sent to the service or other devices. */
export const LOGIN_PAUSES_KEY = "session:pateat.login-pauses.v1";
/** How long a pause lasts (ADR 0062). */
export const PAUSE_MS = 60 * 60_000;
/** Pauses kept at most; the one that ends first goes first. */
const MAX_PAUSES = 256;

const pauseSchema = v.strictObject({
  /** The registrable domain, as Bitwarden's Domain match compares it. */
  site: v.pipe(v.string(), v.minLength(1), v.maxLength(253)),
  incognito: v.boolean(),
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

export type LoginPauses = ReturnType<typeof createLoginPauses>;

/**
 * The paused sites, read once from session storage so a pause survives a worker restart.
 * A pause ends by itself once its time has passed: every check compares the time, so no
 * alarm is needed. Writes land in order; a failed write leaves the memory as it was.
 */
export function createLoginPauses(
  store: { getValue(): Promise<unknown>; setValue(value: unknown): Promise<void> },
  now: () => number = Date.now,
) {
  const pauses = new Map<string, Pause>();
  const key = (site: string, incognito: boolean) => `${incognito ? "incognito" : "normal"} ${site}`;
  const loaded = (async () => {
    const parsed = v.safeParse(storedSchema, await store.getValue().catch(() => undefined));
    if (parsed.success)
      for (const entry of parsed.output) pauses.set(key(entry.site, entry.incognito), entry);
  })();
  let writes: Promise<unknown> = Promise.resolve();
  /** Stores the pauses that still run, changed by `edit`; memory changes once stored. */
  async function save(edit: (draft: Map<string, Pause>) => void): Promise<void> {
    await loaded;
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
  /** When the site's pause ends, in epoch milliseconds, while it runs. */
  function untilFor(site: string | undefined, incognito: boolean): number | undefined {
    if (site === undefined) return undefined;
    const entry = pauses.get(key(site, incognito));
    if (!entry) return undefined;
    const until = isoTimeMs(entry.until);
    return until > now() ? until : undefined;
  }
  return {
    loaded,
    /**
     * When the pause covering a page ends, while it runs: the latest end among the sites of
     * `urls`, such as a frame's own URL and its tab's (a frame is paused when either is).
     */
    async until(urls: readonly (string | URL | undefined)[], incognito: boolean) {
      await loaded;
      const ends = urls.flatMap((url) => {
        const until = url === undefined ? undefined : untilFor(pauseSite(url), incognito);
        return until === undefined ? [] : [until];
      });
      return ends.length ? Math.max(...ends) : undefined;
    },
    /** Pauses the site of `url` for `PAUSE_MS` from now; its end, or undefined for no site. */
    async pause(url: string | URL, incognito: boolean): Promise<number | undefined> {
      const site = pauseSite(url);
      if (site === undefined) return undefined;
      const until = now() + PAUSE_MS;
      await commit((draft) =>
        draft.set(key(site, incognito), { site, incognito, until: isoTime(until) }),
      );
      return until;
    },
    /** Ends the pause of the site of `url`; true when one was running. */
    async resume(url: string | URL, incognito: boolean): Promise<boolean> {
      const site = pauseSite(url);
      await loaded;
      if (site === undefined || untilFor(site, incognito) === undefined) return false;
      await commit((draft) => draft.delete(key(site, incognito)));
      return true;
    },
  };
}
