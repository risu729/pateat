import * as v from "valibot";
import { storedLoginRecipeSchema } from "./login";
import { localSettingsSchema } from "./settings";
import { MAX_ACTIVE_RECIPES, MAX_SETTINGS_DOCUMENT_BYTES, settingsDocumentBytes } from "./sync";

// A file that carries what a pairing shares, for a device without the service (ADR 0040):
// the synced part of the settings, with the bindings, and the recipes logins use. It
// never holds vault keys or values, the service's sign-in or this device's AI key.

export const TRANSFER_FORMAT = "pateat-transfer";

export const transferFileSchema = v.strictObject({
  format: v.literal(TRANSFER_FORMAT),
  version: v.literal(1),
  exportedAt: v.pipe(v.string(), v.isoTimestamp()),
  /** The settings document a service would hold: no vault connections. */
  settings: v.pipe(
    localSettingsSchema,
    v.check((settings) => settings.connections.length === 0, "Vault connections in the file"),
    v.check(
      (settings) => settingsDocumentBytes(settings) <= MAX_SETTINGS_DOCUMENT_BYTES,
      "Settings too large",
    ),
  ),
  recipes: v.pipe(
    v.array(storedLoginRecipeSchema),
    v.maxLength(MAX_ACTIVE_RECIPES),
    v.check(
      (recipes) => new Set(recipes.map((recipe) => recipe.id)).size === recipes.length,
      "Duplicate recipe IDs",
    ),
  ),
});
export type TransferFile = v.InferOutput<typeof transferFileSchema>;

/** Only the settings page exports and imports. */
export const transferRequestSchema = v.variant("type", [
  v.strictObject({ version: v.literal(1), type: v.literal("settings.export") }),
  v.strictObject({
    version: v.literal(1),
    type: v.literal("settings.import"),
    /** The file as read; the background parses it. */
    file: v.unknown(),
    /**
     * False asks what the import would change, which the page shows for the owner to
     * confirm; true imports. A file may come from someone else, and its entries can let
     * vault items be used on more sites.
     */
    apply: v.boolean(),
  }),
]);
export type TransferRequest = v.InferOutput<typeof transferRequestSchema>;

/**
 * Why an export or import did not finish: `invalid-file` for a file that is not one or
 * whose settings cannot join this device's, `too-large` for recipes that do not fit with
 * those kept here or settings larger than a service holds, and `storage-unavailable` when the settings or recipes cannot be read
 * or written.
 */
export const TRANSFER_ERRORS = ["invalid-file", "too-large", "storage-unavailable"] as const;

const count = v.pipe(v.number(), v.integer(), v.minValue(0));

export const transferResponseSchema = v.union([
  v.strictObject({
    version: v.literal(1),
    ok: v.literal(true),
    type: v.literal("settings.export"),
    file: transferFileSchema,
  }),
  v.strictObject({
    version: v.literal(1),
    ok: v.literal(true),
    type: v.literal("settings.import-preview"),
    /**
     * The sites whose account choices, default accounts or personal-detail links the
     * import adds or replaces: there, the file decides which vault item Pateat uses.
     */
    sites: v.pipe(v.array(v.string()), v.maxLength(3000)),
    /** The vault accounts and items whose limits or custom-field reviews it changes. */
    policies: count,
    /** The sites whose exclusion, master password or passkey rule it changes. */
    others: count,
    /** The recipes it would keep here. */
    recipes: count,
  }),
  v.strictObject({
    version: v.literal(1),
    ok: v.literal(true),
    type: v.literal("settings.import"),
    /** How many of the file's recipes are now kept here, newer than any held before. */
    recipes: count,
  }),
  v.strictObject({
    version: v.literal(1),
    ok: v.literal(false),
    error: v.picklist(TRANSFER_ERRORS),
  }),
]);
export type TransferResponse = v.InferOutput<typeof transferResponseSchema>;
