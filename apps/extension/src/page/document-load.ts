// The document's `load`, waited for as a signal (ADR 0082): the answer comes as soon as
// the document has loaded, and a bound only ends a wait for a load that never comes.

/**
 * Resolves `true` once `document` has finished loading (`readyState` is `complete`), at
 * once when it already has, or `false` at `until` (a time in ms since the epoch) or once
 * `stop` is aborted, whichever comes first.
 */
export function documentLoaded(
  document: Document,
  until: number,
  stop?: AbortSignal,
): Promise<boolean> {
  if (document.readyState === "complete") return Promise.resolve(true);
  if (stop?.aborted || Date.now() >= until) return Promise.resolve(false);
  return new Promise((resolve) => {
    const listening = new AbortController();
    const end = (loaded: boolean) => {
      listening.abort();
      clearTimeout(bound);
      resolve(loaded);
    };
    const bound = setTimeout(() => end(document.readyState === "complete"), until - Date.now());
    // `readystatechange` reaches `complete` just before the window's `load`.
    document.addEventListener(
      "readystatechange",
      () => {
        if (document.readyState === "complete") end(true);
      },
      { signal: listening.signal },
    );
    stop?.addEventListener("abort", () => end(false), { signal: listening.signal });
  });
}

/**
 * The HTTP status of this document's own load, when the browser reports one (ADR 0041); a
 * status the page cannot see, as for a cached or cross-origin redirected load, reads as 0
 * and is left out.
 */
export function navigationStatus(): number | undefined {
  try {
    const [entry] = performance.getEntriesByType("navigation") as (PerformanceEntry & {
      responseStatus?: number;
    })[];
    const status = entry?.responseStatus;
    return typeof status === "number" && status >= 100 && status <= 599 ? status : undefined;
  } catch {
    return undefined;
  }
}
