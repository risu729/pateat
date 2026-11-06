// Shared by the production config and the Vitest runtime without importing Worker code.
export const compatibilityDate = "2026-10-06";
// `temporal` exposes the global Temporal before it is on by default (compatibility date
// 2026-12-01). Drop it once the date passes that.
export const compatibilityFlags = ["nodejs_compat", "temporal"];
