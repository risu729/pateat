import {
  localSettingsSchema,
  TRANSFER_FORMAT,
  transferFileSchema,
  transferRequestSchema,
  type SettingsChangeCause,
  type SettingsSnapshot,
  type StoredLoginRecipe,
  type TransferResponse,
} from "@pateat/contracts";
import * as v from "valibot";
import { DeviceRecipesTooLarge } from "./device-recipes";
import { exportedSettings, importedSettings } from "./settings-sync";

// Export and import (ADR 0040): a file carries what a pairing shares, so a device without
// the service can pass its settings, bindings and recipes to another one. Nothing in it
// is a vault key or value, the service's sign-in or this device's AI key.

const failure = (error: "invalid-file" | "too-large" | "storage-unavailable") =>
  ({ version: 1, ok: false, error }) as const;

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
  /**
   * This device's own recipes (ADR 0040), which keep a recipe only at a newer revision and
   * reject with `DeviceRecipesTooLarge` when the result would not fit. A paired device
   * uploads them at its next full sync.
   */
  device: { keep(recipes: readonly StoredLoginRecipe[]): Promise<number> };
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

  async function importFile(value: unknown): Promise<TransferResponse> {
    const file = v.safeParse(transferFileSchema, value);
    if (!file.success) return failure("invalid-file");
    const merge = (snapshot: SettingsSnapshot) =>
      v.safeParse(localSettingsSchema, importedSettings(snapshot.settings, file.output.settings));
    // Checked before the recipes are kept, so a file whose settings cannot join these
    // changes nothing.
    try {
      if (!merge(await settings.read()).success) return failure("invalid-file");
    } catch {
      return failure("storage-unavailable");
    }
    let recipes: number;
    try {
      recipes = await device.keep(file.output.recipes);
    } catch (error) {
      return failure(error instanceof DeviceRecipesTooLarge ? "too-large" : "storage-unavailable");
    }
    try {
      await settings.update(undefined, "settings-import", (snapshot) => {
        const merged = merge(snapshot);
        if (!merged.success) throw new v.ValiError(merged.issues);
        return { ...snapshot, settings: merged.output };
      });
    } catch (error) {
      // The settings changed meanwhile, or the whole snapshot no longer fits.
      return failure(error instanceof v.ValiError ? "invalid-file" : "storage-unavailable");
    }
    options.imported?.();
    return { version: 1, ok: true, type: "settings.import", recipes };
  }

  return {
    /** `settings.export` and `settings.import`, from the settings page only. */
    async handle(value: unknown): Promise<TransferResponse | undefined> {
      const request = v.safeParse(transferRequestSchema, value);
      if (!request.success) return undefined;
      return request.output.type === "settings.export"
        ? exportFile()
        : importFile(request.output.file);
    },
  };
}
