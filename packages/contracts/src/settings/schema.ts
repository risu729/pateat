import * as v from "valibot";
import {
  settingsChangeCauseSchema,
  settingsSnapshotSchema,
  settingsRequestSchema,
  vaultCatalogSchema,
  settingsErrorSchema,
  settingsResponseSchema,
} from "./schema-messages";
import { localSettingsSchema } from "./schema-value";
export {
  parseSiteUrl,
  normalizeHostname,
  recipeSlotIdSchema,
  vaultServerSchema,
  loginDetailSchema,
  birthDateFormatSchema,
  cardExpiryFormatSchema,
  detailFormatSchema,
  detailFormatFits,
  datePartSchema,
  detailPartFormatSchema,
  detailPartFormatFits,
  vaultFieldReferenceSchema,
  savedLoginBindingSchema,
  detailSourceFieldSchema,
  questionText,
  QUESTION_MIN_LENGTH,
  QUESTION_MAX_LENGTH,
  shownQuestionSchema,
  storedQuestionSchema,
  detailLinkSchema,
  VAULT_TIMEOUT_MINUTES,
  MAX_CUSTOM_MINUTES,
  VAULT_TIMEOUT_EVENTS,
  vaultTimeoutSchema,
  MAX_DEVICE_LIMIT_USD,
  modelSpendLimitsSchema,
  siteDefaultSchema,
  siteRuleSchema,
  connectionSettingsSchema,
  excludedFieldSchema,
  accountPolicySchema,
  itemPolicySchema,
  customFieldReviewSchema,
  parseInstant,
  instantBefore,
  type ConnectionSettings,
  type SiteDefault,
  type SiteRule,
  type AccountPolicy,
  type ItemPolicy,
  type ExcludedField,
  type CustomFieldReview,
  type VaultServer,
  type VaultFieldReference,
  type SavedLoginBinding,
  type LoginDetail,
  type BirthDateFormat,
  type CardExpiryFormat,
  type DetailFormat,
  type DatePart,
  type DetailPartFormat,
  type DetailLink,
} from "./schema-primitives";
export * from "./schema-value";
export * from "./schema-messages";

export type LocalSettings = v.InferOutput<typeof localSettingsSchema>;
/** One provider account: the key of its account policy (ADR 0023). */
export type VaultAccount = { provider: string; server: string; userId: string };
export type SettingsSnapshot = v.InferOutput<typeof settingsSnapshotSchema>;
export type SettingsRequest = v.InferOutput<typeof settingsRequestSchema>;
export type SettingsResponse = v.InferOutput<typeof settingsResponseSchema>;
export type SettingsError = v.InferOutput<typeof settingsErrorSchema>;
export type SettingsChangeCause = v.InferOutput<typeof settingsChangeCauseSchema>;
export type SettingsConflictCause = NonNullable<SettingsError["causes"]>[number];
export type VaultCatalog = v.InferOutput<typeof vaultCatalogSchema>;
export type VaultConnectionMetadata = VaultCatalog["connections"][number];
export type VaultItemMetadata = VaultConnectionMetadata["items"][number];

export function parseSettingsResponse(value: unknown): SettingsResponse {
  return v.parse(settingsResponseSchema, value);
}
export function parseLocalSettings(value: unknown): LocalSettings {
  return v.parse(localSettingsSchema, value);
}

export const popupPageSectionShown = (settings: Pick<LocalSettings, "popupPageSection">) =>
  settings.popupPageSection !== false;

