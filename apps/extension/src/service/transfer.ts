import {
  localSettingsSchema,
  MAX_ACTIVE_RECIPES,
  MAX_SETTINGS_DOCUMENT_BYTES,
  settingsDocumentBytes,
  TRANSFER_FORMAT,
  transferFileSchema,
  transferRequestSchema,
  type LocalSettings,
  type SettingsChangeCause,
  type SettingsSnapshot,
  type StoredLoginRecipe,
  type TransferFile,
  type TransferResponse,
} from "@pateat/contracts";
import * as v from "valibot";
import { DeviceRecipesTooLarge } from "./device-recipes";
import { exportedSettings, importedSettings, syncedSettings } from "./settings-sync";

// Export and import (ADR 0040): a file carries what a pairing shares, so a device without
// the service can pass its settings, bindings and recipes to another one. Nothing in it
// is a vault key or value, the service's sign-in or this device's AI key.

const failure = (error: "invalid-file" | "too-large" | "storage-unavailable") =>
  ({ version: 1, ok: false, error }) as const;

/** Thrown inside the settings write when the merge no longer fits. */
class MergeRefused extends Error {
  readonly error: "invalid-file" | "too-large";
  constructor(error: "invalid-file" | "too-large") {
    super("Imported settings do not fit");
    this.error = error;
  }
}

/** The local settings with the file's merged in, or why they cannot be. */
function merge(
  settings: LocalSettings,
  file: TransferFile,
): LocalSettings | "invalid-file" | "too-large" {
  const merged = v.safeParse(localSettingsSchema, importedSettings(settings, file.settings));
  if (!merged.success) return "invalid-file";
  // The service holds no larger document, so a paired device could no longer sync it.
  return settingsDocumentBytes(exportedSettings(merged.output)) > MAX_SETTINGS_DOCUMENT_BYTES
    ? "too-large"
    : merged.output;
}

/**
 * What the merge adds, replaces or drops in the synced part, for the owner to confirm. An
 * item's policy and its custom-field review merge as one entry (ADR 0023), so the file's
 * may drop the other half of one held here: that counts as a change of the item's limit.
 */
function changes(before: LocalSettings, after: LocalSettings) {
  const was = syncedSettings(before);
  const now = syncedSettings(after);
  /** The entries only one side holds, unchanged ones left out. */
  const changed = <T>(previous: readonly T[], next: readonly T[]) => {
    const text = (entries: readonly T[]) => new Set(entries.map((entry) => JSON.stringify(entry)));
    const [held, kept] = [text(previous), text(next)];
    return [
      ...next.filter((entry) => !held.has(JSON.stringify(entry))),
      ...previous.filter((entry) => !kept.has(JSON.stringify(entry))),
    ];
  };
  const account = (entry: { provider: string; server: string; userId: string }) =>
    JSON.stringify([entry.provider, entry.server, entry.userId]);
  const item = (entry: { provider: string; server: string; userId: string; itemId: string }) =>
    JSON.stringify([entry.provider, entry.server, entry.userId, entry.itemId]);
  const sites = new Set(
    [
      ...changed(was.bindings, now.bindings),
      ...changed(was.siteDefaults, now.siteDefaults),
      ...changed(was.detailLinks, now.detailLinks),
    ].map((entry) => entry.origin),
  );
  const limits = new Set([
    ...changed(was.accountPolicies, now.accountPolicies).map(account),
    ...changed(was.itemPolicies, now.itemPolicies).map(item),
    ...changed(was.customFieldReviews, now.customFieldReviews).map(item),
  ]);
  const siteKey = (entry: { hostname: string }) => entry.hostname;
  const rules = (name: "excludedSites" | "passkeyBrowserSites" | "repromptSites") =>
    new Set(changed(was[name], now[name]).map(siteKey)).size;
  return {
    sites: [...sites].toSorted(),
    policies: limits.size,
    others:
      rules("excludedSites") +
      rules("passkeyBrowserSites") +
      rules("repromptSites") +
      (was.popupPageSection === now.popupPageSection ? 0 : 1),
  };
}

export function createTransfer(options: {
  settings: {
    read(): Promise<SettingsSnapshot>;
    update(
      expectedRevision: number | undefined,
      cause: SettingsChangeCause,
      mutate: (snapshot: SettingsSnapshot) => SettingsSnapshot,
    ): Promise<SettingsSnapshot>;
  };
  /** The recipes logins use now; none when they cannot be read. */
  recipes(): Promise<readonly StoredLoginRecipe[] | undefined>;
  /** Whether a service is paired; one that cannot be read counts as paired. */
  paired(): Promise<boolean>;
  /**
   * This device's own recipes (ADR 0040), which keep a recipe only at a newer revision and
   * reject with `DeviceRecipesTooLarge` when the result would not fit. A paired device
   * uploads them at its next full sync.
   */
  device: {
    list(): Promise<readonly StoredLoginRecipe[]>;
    keep(recipes: readonly StoredLoginRecipe[], maxCount?: number): Promise<number>;
  };
  /** Called once imported settings are written, so running work follows them. */
  imported?: () => void;
  now?: () => number;
}) {
  const { settings, device } = options;
  const now = options.now ?? Date.now;

  async function exportFile(): Promise<TransferResponse> {
    let snapshot: SettingsSnapshot;
    let recipes: readonly StoredLoginRecipe[] | undefined;
    try {
      [snapshot, recipes] = await Promise.all([settings.read(), options.recipes()]);
    } catch {
      return failure("storage-unavailable");
    }
    if (!recipes) return failure("storage-unavailable");
    const file = v.safeParse(transferFileSchema, {
      format: TRANSFER_FORMAT,
      version: 1,
      exportedAt: new Date(now()).toISOString(),
      settings: exportedSettings(snapshot.settings),
      recipes: [...recipes],
    });
    // Both were read through their own schemas, so only the file's size limits are left.
    if (!file.success) return failure("too-large");
    return { version: 1, ok: true, type: "settings.export", file: file.output };
  }

  /**
   * The file's recipes this device would keep. A paired service's copy of a recipe wins
   * over an uploaded one (ADR 0040), so one whose ID the synced recipes hold is left out.
   */
  async function wanted(file: TransferFile): Promise<StoredLoginRecipe[]> {
    if (!(await options.paired())) return file.recipes;
    const held = await options.recipes();
    // Without them, a recipe the service holds could not be told apart.
    if (!held) throw new Error("The synced recipes cannot be read");
    const synced = new Set(held.map((recipe) => recipe.id));
    return file.recipes.filter((recipe) => !synced.has(recipe.id));
  }

  async function importFile(value: unknown, apply: boolean): Promise<TransferResponse> {
    const file = v.safeParse(transferFileSchema, value);
    if (!file.success) return failure("invalid-file");
    let snapshot: SettingsSnapshot;
    let recipes: StoredLoginRecipe[];
    try {
      [snapshot, recipes] = await Promise.all([settings.read(), wanted(file.output)]);
    } catch {
      return failure("storage-unavailable");
    }
    // Checked before the recipes are kept, so a file whose settings cannot join these
    // changes nothing.
    const merged = merge(snapshot.settings, file.output);
    if (typeof merged === "string") return failure(merged);
    if (!apply) {
      let held: readonly StoredLoginRecipe[];
      try {
        held = await device.list();
      } catch {
        return failure("storage-unavailable");
      }
      const revisions = new Map(held.map((recipe) => [recipe.id, recipe.revision]));
      const kept = recipes.filter((recipe) => recipe.revision > (revisions.get(recipe.id) ?? 0));
      const added = kept.filter((recipe) => !revisions.has(recipe.id)).length;
      // As `keep` refuses it; its size limit is checked only when the import runs.
      if (held.length + added > MAX_ACTIVE_RECIPES) return failure("too-large");
      return {
        version: 1,
        ok: true,
        type: "settings.import-preview",
        ...changes(snapshot.settings, merged),
        recipes: kept.length,
      };
    }
    let kept: number;
    try {
      kept = await device.keep(recipes, MAX_ACTIVE_RECIPES);
    } catch (error) {
      return failure(error instanceof DeviceRecipesTooLarge ? "too-large" : "storage-unavailable");
    }
    try {
      await settings.update(undefined, "settings-import", (current) => {
        const next = merge(current.settings, file.output);
        if (typeof next === "string") throw new MergeRefused(next);
        return { ...current, settings: next };
      });
    } catch (error) {
      // The recipes stay kept; importing the file again finishes the settings.
      if (kept > 0) options.imported?.();
      if (error instanceof MergeRefused) return failure(error.error);
      return failure(error instanceof v.ValiError ? "invalid-file" : "storage-unavailable");
    }
    options.imported?.();
    return { version: 1, ok: true, type: "settings.import", recipes: kept };
  }

  return {
    /** `settings.export` and `settings.import`, from the settings page only. */
    async handle(value: unknown): Promise<TransferResponse | undefined> {
      const request = v.safeParse(transferRequestSchema, value);
      if (!request.success) return undefined;
      return request.output.type === "settings.export"
        ? exportFile()
        : importFile(request.output.file, request.output.apply);
    },
  };
}
