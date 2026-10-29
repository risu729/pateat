import type { LoginAttemptMetadata } from "@pateat/contracts";
import { RELOGIN_LIMIT, RELOGIN_WINDOW_MS } from "./constants";
import type { Relogins } from "./session-schemas";
import { reloginKey, siteOf } from "./steps";

/** Completion times still inside the window; a clock rollback drops future times. */
export function reloginTimes(
  relogins: ReadonlyMap<string, Relogins>,
  site: string,
  incognito: boolean,
  now: number,
): number[] {
  return (relogins.get(reloginKey(site, incognito))?.at ?? []).filter(
    (at) => now - at >= 0 && now - at < RELOGIN_WINDOW_MS,
  );
}

export function reloginLimited(
  relogins: ReadonlyMap<string, Relogins>,
  siteOrigin: string,
  incognito: boolean,
  now: number,
): boolean {
  const site = siteOf(siteOrigin);
  return site !== undefined && reloginTimes(relogins, site, incognito, now).length >= RELOGIN_LIMIT;
}

/** Count a new automatic completion, including an undecided authenticated result. */
export function countsAsRelogin(
  previous: LoginAttemptMetadata,
  next: LoginAttemptMetadata,
  pickedAttemptId: string | undefined,
): boolean {
  return (
    next.state === "authenticated" &&
    previous.state !== "authenticated" &&
    pickedAttemptId !== next.id
  );
}

/** Return the updated insertion-ordered map without changing the input or its records. */
export function countSignIn(
  relogins: ReadonlyMap<string, Relogins>,
  siteOrigin: string,
  incognito: boolean,
  now: number,
): Map<string, Relogins> {
  const counted = new Map(relogins);
  const site = siteOf(siteOrigin);
  if (site === undefined) return counted;
  const key = reloginKey(site, incognito);
  const at = [...reloginTimes(relogins, site, incognito, now), now].slice(-RELOGIN_LIMIT);
  counted.delete(key);
  counted.set(key, { site, incognito, at });
  for (const oldest of counted.keys()) {
    if (counted.size <= 256) break;
    counted.delete(oldest);
  }
  return counted;
}
