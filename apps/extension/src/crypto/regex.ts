import * as v from "valibot";

/** How long one page URL's Regex URIs may run in all once their Worker is ready (ADR 0056). */
export const regexBudgetMs = 5_000;
/** How long a new Regex Worker may take to answer that it is ready; not part of the budget. */
const startBudgetMs = 5_000;
/** Pattern and page pairs that ran out of time, kept so they never run again. */
const maxSlowPairs = 1_000;

const answerSchema = v.strictObject({
  id: v.pipe(v.number(), v.integer()),
  index: v.pipe(v.number(), v.integer(), v.minValue(0)),
  matched: v.boolean(),
});

export interface RegexRunner {
  /**
   * Each pattern's result against `url`, as the pinned clients' `new RegExp(pattern, "i")`
   * decides it. A pattern missing from the map was not evaluated: it ran out of time now or
   * before for this URL, or the Worker failed.
   */
  run(patterns: readonly string[], url: string): Promise<Map<string, boolean>>;
}

function startRegexWorker(): Worker {
  return new Worker(new URL("./regex-worker.ts", import.meta.url), { type: "module" });
}

/**
 * Runs patterns in a nested Worker that the crypto Worker terminates with itself, so a
 * backtracking pattern can never block the vault session. A Worker that runs out of time
 * is terminated and the next call starts a new one. Calls must not overlap; the crypto
 * Worker runs one command at a time.
 */
export function createRegexRunner(
  start: () => Worker = startRegexWorker,
  budgetMs = regexBudgetMs,
): RegexRunner {
  type Started = {
    worker: Worker;
    ready: Promise<boolean>;
    receive?: ((data: unknown) => void) | undefined;
  };
  let current: Started | undefined;
  let nextId = 0;
  const slow = new Set<string>();

  function discard(started: Started) {
    started.receive = undefined;
    started.worker.terminate();
    if (current === started) current = undefined;
  }
  function launch(): Started {
    const worker = start();
    const { promise, resolve } = Promise.withResolvers<boolean>();
    const started: Started = { worker, ready: promise };
    const timer = setTimeout(() => resolve(false), startBudgetMs);
    worker.onmessage = (event: MessageEvent<unknown>) => {
      if (event.data === "ready") {
        clearTimeout(timer);
        resolve(true);
      } else started.receive?.(event.data);
    };
    worker.onerror = (event) => {
      event.preventDefault();
      clearTimeout(timer);
      resolve(false);
      const receive = started.receive;
      discard(started);
      // Ends a run in progress with the results it has.
      receive?.(undefined);
    };
    return started;
  }
  async function pairKey(url: string) {
    // Page URLs can be 2 MiB long; remember a digest of each instead.
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(url));
    return new Uint8Array(digest).toHex();
  }

  return {
    async run(patterns, url) {
      const results = new Map<string, boolean>();
      const page = await pairKey(url);
      const pending = [...new Set(patterns)].filter((pattern) => !slow.has(`${page}\n${pattern}`));
      if (pending.length === 0) return results;
      let started: Started;
      try {
        started = current ??= launch();
      } catch {
        // A Worker that cannot start leaves every pattern unevaluated.
        return results;
      }
      if (!(await started.ready)) {
        discard(started);
        return results;
      }
      const id = ++nextId;
      const { promise, resolve } = Promise.withResolvers<void>();
      // When the last answer arrived, or the patterns were sent.
      let progressAt = Date.now();
      const timer = setTimeout(() => {
        // Answers arrive in order, so the first pattern without one is still running. It is
        // remembered only when it ran for at least half the budget on its own, so a fast
        // pattern that happened to run last after several slower ones is tried again.
        const running = pending[results.size];
        if (running !== undefined && Date.now() - progressAt >= budgetMs / 2) {
          if (slow.size >= maxSlowPairs) slow.clear();
          slow.add(`${page}\n${running}`);
        }
        discard(started);
        resolve();
      }, budgetMs);
      started.receive = (data) => {
        const answer = v.safeParse(answerSchema, data);
        const pattern = answer.success ? pending[answer.output.index] : undefined;
        if (
          !answer.success ||
          answer.output.id !== id ||
          answer.output.index !== results.size ||
          pattern === undefined
        ) {
          clearTimeout(timer);
          discard(started);
          resolve();
          return;
        }
        results.set(pattern, answer.output.matched);
        progressAt = Date.now();
        if (results.size === pending.length) {
          clearTimeout(timer);
          started.receive = undefined;
          resolve();
        }
      };
      started.worker.postMessage({ id, url, patterns: pending });
      await promise;
      return results;
    },
  };
}
