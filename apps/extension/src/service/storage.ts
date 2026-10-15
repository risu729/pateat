import type { VaultSyncRecord } from "../connections/auto-sync";
import type { ServiceStorage } from "./runtime";
import type { GeneratedSlotStorage, GenerationAttemptStorage } from "./generation";
import type { RepairStorage } from "../login/repair";
import type { RecipeCacheStorage, RecipeScheduleStorage } from "./recipes";
import type { SettingsBaseStorage, SettingsHoldStorage } from "./settings-sync";
import { trustedRecord } from "../storage";

/** The service record holds the device credential: trusted contexts only. */
export function createBrowserServiceStorage(): ServiceStorage {
  return trustedRecord("pateat.sync-service.v1");
}

/** Synced recipes are login policy; content scripts never read them directly. */
export function createBrowserRecipeCacheStorage(): RecipeCacheStorage {
  return trustedRecord("pateat.sync-recipes.v1");
}

/** When the next background recipe sync is due, kept across service worker restarts. */
export function createBrowserRecipeScheduleStorage(): RecipeScheduleStorage {
  return trustedRecord("pateat.sync-recipes-schedule.v1");
}

/** The settings this device and the service last agreed on, for the next merge. */
export function createBrowserSettingsBaseStorage(): SettingsBaseStorage {
  return trustedRecord("pateat.sync-settings.v1");
}

/** When synced settings first waited for a login, so the limit holds across restarts. */
export function createBrowserSettingsHoldStorage(): SettingsHoldStorage {
  return trustedRecord("pateat.sync-settings-hold.v1");
}

/** When each vault connection was last checked and which revision date it applied. */
export function createBrowserVaultSyncStorage() {
  return trustedRecord<VaultSyncRecord>("pateat.vault-sync-schedule.v1");
}

/** Which pages were sent for recipe generation within the retry window (ADR 0016). */
export function createBrowserGenerationAttemptStorage(): GenerationAttemptStorage {
  return trustedRecord("pateat.generation-attempts.v1");
}

/** Which vault field each custom slot of a recipe generated here names (ADR 0027). */
export function createBrowserGeneratedSlotStorage(): GeneratedSlotStorage {
  return trustedRecord("pateat.generated-slots.v1");
}

/** Which generated recipes' start pages missed their first step (proposed ADR 0041). */
export function createBrowserRecipeRepairStorage(): RepairStorage {
  return trustedRecord("pateat.recipe-repairs.v1");
}
