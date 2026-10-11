import { customFieldSlotDescriptions, type SemanticSlot } from "@pateat/contracts";

/**
 * Synthetic semantic slots. Descriptions name meanings only; no values or bindings. The
 * custom-field slots carry opaque IDs and the generic description, as the extension sends
 * them (ADR 0027); `customField` adds their field names.
 */
export const slots = {
  username: { id: "username", kind: "identifier", description: "account username or login ID" },
  email: { id: "email", kind: "identifier", description: "account email address" },
  password: { id: "password", kind: "secret", description: "account password" },
  branch: {
    id: "custom-1",
    kind: "identifier",
    description: customFieldSlotDescriptions.identifier,
  },
  account: {
    id: "custom-2",
    kind: "identifier",
    description: customFieldSlotDescriptions.identifier,
  },
  code: { id: "one-time-code", kind: "one-time-code", description: "one-time authentication code" },
} as const satisfies Record<string, SemanticSlot>;

/** The generic recipe slot ID a careful mapping gives each custom-field slot above. */
export const customSlotNames: Readonly<Record<string, string>> = {
  "custom-1": "branch-number",
  "custom-2": "account-number",
};
