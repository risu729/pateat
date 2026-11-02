import { describe, expect, it } from "vitest";
import { createDefaultSettings, parseLocalSettings } from "./settings";

// The profile settings synced since 2026-11-02 (ADR 0024): absent at their defaults.
describe("synced profile preferences", () => {
  it("keeps the vault timeout, language, theme and spend limits absent at their defaults", () => {
    const settings = createDefaultSettings();
    for (const key of ["vaultTimeout", "language", "theme", "modelSpendLimits"])
      expect(settings).not.toHaveProperty(key);
    const changed = {
      ...settings,
      vaultTimeout: { timeout: 30, action: "log-out" },
      language: "ja",
      theme: "dark",
      modelSpendLimits: { dailyUsd: 0, monthlyUsd: 12.5 },
    };
    expect(parseLocalSettings(changed)).toMatchObject({
      vaultTimeout: changed.vaultTimeout,
      language: "ja",
      theme: "dark",
      modelSpendLimits: changed.modelSpendLimits,
    });
    for (const vaultTimeout of [
      { timeout: 0, action: "lock" },
      { timeout: 525_601, action: "lock" },
      { timeout: "immediately", action: "lock" },
      { timeout: "never" },
    ])
      expect(() => parseLocalSettings({ ...settings, vaultTimeout })).toThrow();
    for (const language of ["system", "fr", null])
      expect(() => parseLocalSettings({ ...settings, language })).toThrow();
    for (const theme of ["system", "sepia", null])
      expect(() => parseLocalSettings({ ...settings, theme })).toThrow();
    for (const modelSpendLimits of [
      { dailyUsd: -1, monthlyUsd: 1 },
      { dailyUsd: 1, monthlyUsd: 100_001 },
      { dailyUsd: 1 },
      { dailyUsd: Number.POSITIVE_INFINITY, monthlyUsd: 1 },
    ])
      expect(() => parseLocalSettings({ ...settings, modelSpendLimits })).toThrow();
  });
});
