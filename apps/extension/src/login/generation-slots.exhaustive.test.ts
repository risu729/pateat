import type { SemanticSlot, VaultItemMetadata } from "@pateat/contracts";
import { describe, expect, it } from "vitest";
import { customFieldOffers } from "./generation-slots";

// Every item of two custom fields, each of every kind, name, TOTP key flag and link, with
// every set of fields allowed for automatic fill, checked against what ADR 0027 lets a
// generation request offer. Synthetic catalog metadata only: no field values exist here.

type Field = VaultItemMetadata["fields"][number];
const snapshot = "11111111-1111-4111-8111-111111111111";
const ids = [0, 1].map((index) => `custom.${snapshot}.${index}`);
const flags = [false, true];

/**
 * Every custom field at `index`: each kind and name (the same, another, blank, none, or
 * one too long for a slot), a Linked one reading each field, and a Text or Hidden one with
 * and without the TOTP key flag, which the catalog sets on no other kind.
 */
const longName = "N".repeat(121);
const variants = (index: number): Field[] =>
  (["text", "hidden", "boolean", "otp", "linked"] as const).flatMap((kind) =>
    ["A", "B", " ", null, longName].flatMap((name) =>
      (kind === "text" || kind === "hidden" ? flags : [false]).flatMap((totpSeed) =>
        (kind === "linked"
          ? ["login.username", "login.password", ...ids, undefined]
          : [undefined]
        ).map((linkedFieldId) => ({
          id: ids[index]!,
          label: `Custom field ${index + 1}`,
          name,
          kind,
          ...(linkedFieldId ? { linkedFieldId } : {}),
          ...(totpSeed ? { totpSeed: true as const } : {}),
        })),
      ),
    ),
  );
const username: Field = { id: "login.username", label: "Username", name: null, kind: "text" };
const password = (empty: boolean): Field => ({
  id: "login.password",
  label: "Password",
  name: null,
  kind: "hidden",
  ...(empty ? { empty: true as const } : {}),
});
const fieldIds = [username.id, "login.password", ...ids];
const allowedSets = Array.from({ length: 1 << fieldIds.length }, (_entry, mask) =>
  fieldIds.filter((_, bit) => (mask & (1 << bit)) !== 0),
);

const strictness: Record<SemanticSlot["kind"], number> = {
  identifier: 0,
  "one-time-code": 1,
  hidden: 2,
  secret: 3,
};

/** What ADR 0027 lets a field offer: its kind, and whether its value may be shaped. */
function allowedOffer(
  fields: readonly Field[],
  field: Field,
  allowed: readonly string[],
): { kind: SemanticSlot["kind"]; shaped: boolean } | undefined {
  // A slot carries a field name of at most 120 characters.
  if (
    !allowed.includes(field.id) ||
    !field.name?.trim() ||
    field.name.length > 120 ||
    field.totpSeed
  )
    return undefined;
  if (field.kind === "text") return { kind: "identifier", shaped: true };
  if (field.kind === "hidden") return { kind: "hidden", shaped: false };
  if (field.kind !== "linked" || !field.linkedFieldId || !allowed.includes(field.linkedFieldId))
    return undefined;
  const source = fields.find((entry) => entry.id === field.linkedFieldId);
  if (!source || source.totpSeed) return undefined;
  if (source.id === "login.password")
    return source.empty ? undefined : { kind: "secret", shaped: false };
  return source.kind === "text" ? { kind: "identifier", shaped: true } : undefined;
}

const items = variants(0).flatMap((first) =>
  variants(1).flatMap((second) => flags.map((empty) => [username, password(empty), first, second])),
);

/** Each item with every allowed set, and the offers it gives. */
function* cases() {
  for (const fields of items)
    for (const allowed of allowedSets)
      yield {
        fields,
        allowed,
        offers: customFieldOffers([
          {
            connectionId: "connection-1",
            item: { id: "item-1", fields },
            allowedFieldIds: allowed,
          },
        ]),
      };
}

/** The cases that break `rule`, at most five, without the offers' slot descriptions. */
function broken(
  rule: (o: {
    fields: Field[];
    allowed: string[];
    offers: ReturnType<typeof customFieldOffers>;
  }) => boolean,
) {
  const found = [];
  for (const o of cases()) {
    if (rule(o)) continue;
    found.push({ fields: o.fields.slice(2), allowed: o.allowed, offers: o.offers });
    if (found.length === 5) break;
  }
  return found;
}

describe("custom-field offers, over every item of two custom fields (ADR 0027)", () => {
  it("walks every case", () => {
    expect(items.length * allowedSets.length).toBeGreaterThan(50_000);
  });

  it("offers exactly the fields ADR 0027 allows, each with its kind and shape", () => {
    expect(
      broken(({ fields, allowed, offers }) =>
        fields.every((field) => {
          const expected = allowedOffer(fields, field, allowed);
          const offer = offers.find((entry) =>
            entry.members.some((member) => member.fieldId === field.id),
          );
          const member = offer?.members.find((entry) => entry.fieldId === field.id);
          return expected === undefined
            ? offer === undefined
            : offer?.slot.kind === expected.kind &&
                (member?.source !== undefined) === expected.shaped;
        }),
      ),
    ).toEqual([]);
  });

  it("shapes an offer only when every member may be shaped", () => {
    expect(
      broken(({ offers }) =>
        offers.every(
          (offer) =>
            offer.shapeable === offer.members.every((member) => member.source !== undefined),
        ),
      ),
    ).toEqual([]);
  });

  it("numbers the offers custom-1, custom-2, … and names each by its fields' vault name", () => {
    expect(
      broken(({ fields, offers }) =>
        offers.every(
          (offer, index) =>
            offer.slot.id === `custom-${index + 1}` &&
            offer.members.every(
              (member) =>
                fields.find((field) => field.id === member.fieldId)?.name === offer.slot.fieldName,
            ),
        ),
      ),
    ).toEqual([]);
  });
});

describe("custom-field offers, over every pair of items with a field of one name (ADR 0027)", () => {
  const single = variants(0).filter((field) => field.name === "A");
  const pairs = single.flatMap((first) =>
    single.map((second) => ({
      first,
      second,
      offers: customFieldOffers(
        [first, second].map((field, index) => {
          const fields = [username, password(false), field];
          return {
            connectionId: "connection-1",
            item: { id: `item-${index + 1}`, fields },
            allowedFieldIds: fields.map((entry) => entry.id),
          };
        }),
      ),
    })),
  );

  it("offers the name once, as the strictest kind of its fields, shaped only if both may be", () => {
    const wrong = pairs.filter(({ first, second, offers }) => {
      const expected = [first, second]
        .map((field) => allowedOffer([username, password(false), field], field, fieldIds))
        .filter((entry) => entry !== undefined);
      if (!expected.length) return offers.length !== 0;
      const kind = expected
        .map((entry) => entry.kind)
        .reduce((left, right) => (strictness[right] > strictness[left] ? right : left));
      return (
        offers.length !== 1 ||
        offers[0]!.members.length !== expected.length ||
        offers[0]!.slot.kind !== kind ||
        offers[0]!.shapeable !== expected.every((entry) => entry.shaped)
      );
    });
    expect(
      wrong.slice(0, 5).map(({ first, second, offers }) => ({ first, second, offers })),
    ).toEqual([]);
  });
});
