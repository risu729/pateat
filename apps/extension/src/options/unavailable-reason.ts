/** Why a site default's account cannot be used, as an English catalog key. */
export function unavailableReason(reason: string): string {
  const descriptions: Record<string, string> = {
    "invalid-url": "The destination is invalid.",
    "default-not-set": "No default account is set.",
    "item-origin-mismatch": "This account does not match the exact origin.",
    "connection-missing": "The vault connection is unavailable.",
    "account-ambiguous":
      "This vault account is connected more than once, or its user ID has settings for another server.",
    "vault-unavailable": "The vault is locked or unavailable.",
    "connection-disabled": "The vault connection is turned off.",
    "item-missing": "This account is no longer in its vault.",
    "item-excluded": "This account is excluded.",
    "item-not-selected": "This account is outside the selected groups and items.",
    "review-required": "This account's custom fields need review, or its vault needs a sync.",
    "fields-excluded": "All fields in this account are excluded.",
  };
  return Object.hasOwn(descriptions, reason)
    ? (descriptions[reason] ?? "This account is unavailable.")
    : "This account is unavailable.";
}
