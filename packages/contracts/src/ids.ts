import { v7 } from "uuid";

/**
 * A new UUIDv7 for an ID Pateat creates: D1 rows, login attempts, revisions and message
 * correlation IDs. UUIDv7 sorts by creation time, so IDs list and index in insertion order.
 * Secrets such as device tokens use random bytes, and IDs that must converge across
 * devices (generated recipe IDs) are derived from their content instead.
 */
export function newId(): string {
  return v7();
}
