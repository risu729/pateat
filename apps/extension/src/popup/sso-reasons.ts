import type { TFunction } from "i18next";

/** What the person can do about each reason an SSO method or choice stops for. */
export function ssoReasonText(t: TFunction, reason: string): string {
  return (
    ssoReason(t, reason) ??
    t("This sign-in method is unavailable or changed. Check the vault and reopen the choice.")
  );
}

/** The text of a reason only an SSO method or choice stops for, or undefined for others. */
export function ssoReason(t: TFunction, reason: string | undefined): string | undefined {
  switch (reason) {
    case "duplicate-idp":
      return t(
        "Two methods name the same provider account. Choose distinct accounts before continuing.",
      );
    case "mapping-required":
      return t("Choose and save a provider account and sign-in origin for this method.");
    case "mapping-unresolved":
      return t(
        "The saved provider account is no longer in an open vault. Choose another one, or unlock or sync the vault.",
      );
    case "mapping-limit":
      return t("Your settings hold as many provider mappings as they can. Remove one first.");
    case "mapping-not-saved":
      return t(
        "This provider account is used because it is the only one found; no mapping is saved to remove. Choose another method, or set this site's sign-in pages to Fill only.",
      );
    case "mapping-save-failed":
      return t("Pateat could not save the provider mapping to your settings. Try again.");
    case "candidate-limit":
      return t(
        "Too many provider accounts match this method. Remove unused items, or allow fewer items in settings, and sync the vault.",
      );
    case "entry-required":
      return t("Choose the provider entry displayed on this page.");
    case "entry-changed":
      return t("The provider entry on this page changed. Choose it again.");
    case "invalid-value":
    case "mixed-forms":
    case "duplicate-method":
    case "field-name":
      return t(
        "The SSO fields have invalid syntax, duplicate methods or mixed formats. Correct the vault item and sync it.",
      );
    case "field-type":
      return t("An SSO field must be a Text or Hidden field. Correct the vault item and sync it.");
    case "too-many-methods":
      return t("The vault item has more than 32 SSO fields. Remove some and sync it.");
    case "url-needs-empty-password":
      return t(
        "An SSO field that holds an address is only for an item without a password. Write it as [Provider] username instead, or remove the password, and sync it.",
      );
    case "username-missing":
      return t("A vault item this method needs has no username. Add one and sync the vault.");
    case "field-unreadable":
      return t(
        "Pateat could not read every custom field of a vault item this method needs. Sync the vault and try again.",
      );
    case "item-unavailable":
      return t("A vault item this method needs is unavailable. Sync the vault and try again.");
    case "uri-unavailable":
      return t(
        "The provider account's URI match rules cannot be read. Use a Domain, Host, Starts with or Exact rule for its sign-in address, and sync the vault.",
      );
    case "review-required":
      return t("Review the vault item's custom fields in settings first.");
    case "signs-in-with-sso":
      return t(
        "The saved provider account signs in through another provider itself, so it cannot be one. Choose another account.",
      );
    case "unsafe-hop":
    case "source-item":
      return t("An identity provider must use a different account and origin from this site.");
    default:
      return undefined;
  }
}
