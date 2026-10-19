// Runs Regex URI patterns for the crypto Worker that starts it (ADR 0056). It receives a
// page URL and decrypted patterns, answers each pattern's result as soon as it has it, and
// is terminated when a pattern runs too long. It never logs or fetches.
for (const method of ["log", "info", "warn", "error", "debug", "trace"] as const)
  console[method] = () => {};
globalThis.fetch = () => Promise.reject(new Error("Network disabled in Regex Worker"));

self.onmessage = (event: MessageEvent<{ id: number; url: string; patterns: string[] }>) => {
  const { id, url, patterns } = event.data;
  patterns.forEach((pattern, index) => {
    let matched = false;
    try {
      // As in the pinned clients; a pattern that does not compile matches nothing.
      matched = new RegExp(pattern, "i").test(url);
    } catch {
      matched = false;
    }
    self.postMessage({ id, index, matched });
  });
};
self.postMessage("ready");
