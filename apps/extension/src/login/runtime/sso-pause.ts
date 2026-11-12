import { pauseSite } from "../pause";

const MAX_INTENTS = 256;
/** Local SSO authority guard while a pause is pending, including a failed persistence. */
export function createSsoPauseIntents() {
  const held = new Map<string, { pending: Set<symbol>; failed: boolean; incognito: boolean }>();
  const key = (site: string, incognito: boolean) => `${incognito ? "private" : "normal"} ${site}`;
  let pending = 0;
  let exhausted = false;
  return {
    blocked(url: string, incognito: boolean | undefined): boolean {
      if (exhausted) return true;
      const site = pauseSite(url);
      return (
        site !== undefined &&
        (incognito === undefined ? [false, true] : [incognito]).some((kind) =>
          held.has(key(site, kind)),
        )
      );
    },
    begin(url: string, incognito: boolean) {
      const site = pauseSite(url);
      if (site === undefined) return { success: () => undefined, failure: () => undefined };
      const scope = key(site, incognito);
      let record = held.get(scope);
      if (pending >= MAX_INTENTS || (!record && held.size >= MAX_INTENTS)) {
        // Capacity failure withdraws all SSO authority for this worker lifetime.
        exhausted = true;
        return { success: () => undefined, failure: () => undefined };
      }
      record ??= { pending: new Set(), failed: false, incognito };
      held.set(scope, record);
      const token = Symbol();
      record.pending.add(token);
      pending += 1;
      let completed = false;
      const finish = (failed: boolean) => {
        if (completed) return;
        completed = true;
        record.pending.delete(token);
        pending -= 1;
        record.failed = failed;
        if (!record.failed && !record.pending.size) held.delete(scope);
      };
      return { success: () => finish(false), failure: () => finish(true) };
    },
    resumed(url: string, incognito: boolean) {
      const site = pauseSite(url);
      const scope = site === undefined ? undefined : key(site, incognito);
      const record = scope === undefined ? undefined : held.get(scope);
      if (!record) return;
      record.failed = false;
      if (!record.pending.size) held.delete(scope!);
    },
    clearPrivate() {
      for (const [scope, record] of held)
        if (record.incognito && !record.pending.size) held.delete(scope);
    },
  };
}
