import type { SemanticSlot } from "../observation";

/** Synthetic semantic slots. Descriptions name meanings only; no values or bindings. */
export const slots = {
  username: { id: "username", kind: "identifier", description: "account username or login ID" },
  email: { id: "email", kind: "identifier", description: "account email address" },
  password: { id: "password", kind: "secret", description: "account password" },
  branch: { id: "branch-number", kind: "identifier", description: "bank branch number" },
  account: { id: "account-number", kind: "identifier", description: "bank account number" },
  code: { id: "one-time-code", kind: "one-time-code", description: "one-time authentication code" },
} as const satisfies Record<string, SemanticSlot>;
