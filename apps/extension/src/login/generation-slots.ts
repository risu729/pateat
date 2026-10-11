import {
  customFieldReference,
  customFieldSlotDescriptions,
  semanticSlotSchema,
  type SemanticSlot,
  type VaultFieldReference,
  type VaultItemMetadata,
} from "@pateat/contracts";
import * as v from "valibot";

// Custom-field offers for recipe generation (ADR 0027). Only field names and positions
// are offered; no value is read here, and nothing names an item or an account.

/** Custom-field offers per request; with the built-in slots this stays within 20 slots. */
export const MAX_CUSTOM_OFFERS = 16;

type OfferClass = {
  kind: SemanticSlot["kind"];
  /** Where a shape may come from (ADR 0010); absent for values that never get one. */
  source?: "username" | "text";
  /** Lower classes are kept first when there are too many offers. */
  priority: number;
};

/** One matching item's field that an offer reads. */
export type OfferMember = {
  connectionId: string;
  itemId: string;
  fieldId: string;
  /** Present when the value may be read for its shape. */
  source?: "username" | "text";
};

export type CustomFieldOffer = {
  /** The slot as offered; its ID is opaque (`custom-1`, …) and numbered over the union. */
  slot: SemanticSlot;
  /** The field every member is named by on every device. */
  reference: Exclude<VaultFieldReference, string>;
  members: OfferMember[];
  /** Every member is a visible identifier value, so a shape may be sent when all agree. */
  shapeable: boolean;
};

const strictness: Record<SemanticSlot["kind"], number> = {
  identifier: 0,
  "one-time-code": 1,
  hidden: 2,
  secret: 3,
};
/**
 * What a field offers, or nothing: a Text field, a Hidden field, or a Linked field whose
 * source is allowed too. A Linked field that reads the password counts only when the
 * password holds a value. Bitwarden links only built-in fields today; a Linked field that
 * reads a Text field would be offered like that Text field.
 */
function offerClass(
  item: Pick<VaultItemMetadata, "fields">,
  field: VaultItemMetadata["fields"][number],
  allowed: ReadonlySet<string>,
): OfferClass | undefined {
  if (field.kind === "text") return { kind: "identifier", source: "text", priority: 0 };
  if (field.kind === "hidden") return { kind: "hidden", priority: 2 };
  if (field.kind !== "linked" || !field.linkedFieldId || !allowed.has(field.linkedFieldId))
    return undefined;
  const source = item.fields.find((entry) => entry.id === field.linkedFieldId);
  if (source?.id === "login.username")
    return { kind: "identifier", source: "username", priority: 1 };
  if (source?.id === "login.password")
    return source.empty === true ? undefined : { kind: "secret", priority: 3 };
  if (source?.kind === "text") return { kind: "identifier", source: "text", priority: 1 };
  return undefined;
}

/**
 * One offer per distinct custom-field reference across the matching items, so several
 * items send the union of their field names. A field is offered when the item allows it
 * for automatic fill and its name is non-blank and fits the slot's field-name bounds.
 * A reference whose fields differ in kind takes the strictest kind and is never shaped.
 * Past `cap`, Text fields are kept first, then Linked fields that read the username,
 * Hidden fields, and Linked fields that read the password, each in scope and field order.
 */
export function customFieldOffers(
  items: readonly {
    connectionId: string;
    item: Pick<VaultItemMetadata, "id" | "fields">;
    /** The item's field IDs not excluded from filling. */
    allowedFieldIds: readonly string[];
  }[],
  cap = MAX_CUSTOM_OFFERS,
): CustomFieldOffer[] {
  const found = new Map<
    string,
    {
      reference: Exclude<VaultFieldReference, string>;
      classes: OfferClass[];
      members: OfferMember[];
    }
  >();
  for (const { connectionId, item, allowedFieldIds } of items) {
    const allowed = new Set(allowedFieldIds);
    const named = item.fields.map((field) => ({ id: field.id, name: field.name }));
    for (const field of item.fields) {
      if (!allowed.has(field.id) || !field.name?.trim()) continue;
      const kind = offerClass(item, field, allowed);
      const reference = kind && customFieldReference(named, field.id);
      if (!kind || !reference) continue;
      const key = JSON.stringify([reference.custom, reference.position, reference.count]);
      const offer = found.get(key) ?? { reference, classes: [], members: [] };
      offer.classes.push(kind);
      offer.members.push({
        connectionId,
        itemId: item.id,
        fieldId: field.id,
        ...(kind.source ? { source: kind.source } : {}),
      });
      found.set(key, offer);
    }
  }
  const offers = [...found.values()].flatMap((offer, order) => {
    const kind = offer.classes
      .map((entry) => entry.kind)
      .reduce((left, right) => (strictness[right] > strictness[left] ? right : left));
    const slot = {
      id: "custom",
      kind,
      description: customFieldSlotDescriptions[kind],
      fieldName: offer.reference.custom,
      ...(offer.reference.position === undefined
        ? {}
        : {
            fieldPosition: {
              position: offer.reference.position,
              count: offer.reference.count!,
            },
          }),
    };
    // A name the slot cannot carry, such as one over 120 characters, is not offered.
    if (!v.is(semanticSlotSchema, slot)) return [];
    return [
      {
        order,
        priority: Math.min(...offer.classes.map((entry) => entry.priority)),
        slot,
        reference: offer.reference,
        members: offer.members,
        shapeable: offer.classes.every((entry) => entry.source !== undefined),
      },
    ];
  });
  return offers
    .sort((left, right) => left.priority - right.priority || left.order - right.order)
    .slice(0, cap)
    .sort((left, right) => left.order - right.order)
    .map(({ slot, reference, members, shapeable }, index) => ({
      slot: { ...slot, id: `custom-${index + 1}` },
      reference,
      members,
      shapeable,
    }));
}
