import * as v from "valibot";

import { failure, type BitwardenResult } from "./errors";
import { generateLocalTotp, type LocalOtpValue } from "./totp";

export interface LocalFieldReference {
  readonly connectionId: string;
  readonly userId: string;
  readonly itemId: string;
  readonly snapshotId: string;
  readonly fieldId: string;
}

export interface LocalFieldMetadata {
  readonly ref: Readonly<LocalFieldReference>;
  readonly label: string;
  readonly kind: "text" | "hidden" | "boolean" | "linked" | "otp" | "unsupported";
}

export type LocalFieldValue =
  | { readonly kind: "text"; readonly value: string }
  | { readonly kind: "boolean"; readonly checked: boolean }
  | LocalOtpValue;

export interface LocalFieldGrant {
  readonly allowedFieldIds: readonly string[];
  readonly nowMs?: () => number;
}

export interface LocalFieldSnapshot {
  list(): readonly LocalFieldMetadata[];
  resolve(ref: unknown, grant: LocalFieldGrant): BitwardenResult<LocalFieldValue>;
  dispose(): void;
}

const identifier = v.pipe(v.string(), v.minLength(1), v.maxLength(128));
const uuid = v.pipe(
  v.string(),
  v.uuid(),
  v.transform((value) => value.toLowerCase()),
);
const text = v.pipe(v.string(), v.maxLength(1_048_576));
const optionalText = v.nullish(text);
const cardFields = ["cardholderName", "expMonth", "expYear", "code", "brand", "number"] as const;
const identityFields = [
  "title",
  "firstName",
  "middleName",
  "lastName",
  "address1",
  "address2",
  "address3",
  "city",
  "state",
  "postalCode",
  "country",
  "company",
  "email",
  "phone",
  "ssn",
  "username",
  "passportNumber",
  "licenseNumber",
] as const;
const recordSchema = (names: readonly string[]) =>
  v.object(Object.fromEntries(names.map((name) => [name, optionalText])));
const itemSchema = v.object({
  id: uuid,
  type: v.pipe(v.number(), v.integer(), v.minValue(1)),
  notes: optionalText,
  login: v.nullish(
    v.object({ username: optionalText, password: optionalText, totp: optionalText }),
  ),
  card: v.nullish(recordSchema(cardFields)),
  identity: v.nullish(recordSchema(identityFields)),
  fields: v.nullish(
    v.pipe(
      v.array(
        v.object({
          name: optionalText,
          value: optionalText,
          type: v.pipe(v.number(), v.integer(), v.minValue(0)),
          linkedId: v.nullish(v.pipe(v.number(), v.integer(), v.minValue(0))),
        }),
      ),
      v.maxLength(1000),
    ),
  ),
});
const scopeSchema = v.strictObject({
  connectionId: identifier,
  userId: uuid,
  snapshotId: uuid,
  item: v.unknown(),
});
const refSchema = v.strictObject({
  connectionId: identifier,
  userId: uuid,
  itemId: uuid,
  snapshotId: uuid,
  fieldId: v.pipe(v.string(), v.minLength(1), v.maxLength(120), v.regex(/^[a-zA-Z0-9_.:-]+$/u)),
});
const linkedSources: Readonly<Record<number, string>> = Object.freeze({
  100: "login.username",
  101: "login.password",
  300: "card.cardholderName",
  301: "card.expMonth",
  302: "card.expYear",
  303: "card.code",
  304: "card.brand",
  305: "card.number",
  400: "identity.title",
  401: "identity.middleName",
  402: "identity.address1",
  403: "identity.address2",
  404: "identity.address3",
  405: "identity.city",
  406: "identity.state",
  407: "identity.postalCode",
  408: "identity.country",
  409: "identity.company",
  410: "identity.email",
  411: "identity.phone",
  412: "identity.ssn",
  413: "identity.username",
  414: "identity.passportNumber",
  415: "identity.licenseNumber",
  416: "identity.firstName",
  417: "identity.lastName",
  418: "identity.fullName",
});
const fullNameDependencies = [
  "identity.title",
  "identity.firstName",
  "identity.middleName",
  "identity.lastName",
];
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

/** Capture a detached, already decrypted item. This factory grants neither origin nor account access. */
export function createLocalFieldSnapshot(input: unknown): BitwardenResult<LocalFieldSnapshot> {
  try {
    const scope = v.safeParse(scopeSchema, input);
    if (!scope.success || !isRecord(scope.output.item)) return failure("invalid-field-input");
    const raw = scope.output.item;
    for (const key of ["login", "card", "identity"]) {
      if (raw[key] != null && !isRecord(raw[key])) return failure("invalid-field-input");
    }
    if (Array.isArray(raw["fields"]) && raw["fields"].some((field) => !isRecord(field))) {
      return failure("invalid-field-input");
    }
    const parsed = v.safeParse(itemSchema, raw);
    if (!parsed.success) return failure("invalid-field-input");
    if (parsed.output.type > 4) return failure("unsupported-field");
    let item: v.InferOutput<typeof itemSchema> | undefined = structuredClone(parsed.output);
    if (
      (item.type === 1 && !item.login) ||
      (item.type === 3 && !item.card) ||
      (item.type === 4 && !item.identity)
    ) {
      return failure("invalid-field-input");
    }
    const scopeValue = {
      connectionId: scope.output.connectionId,
      userId: scope.output.userId,
      itemId: item.id,
      snapshotId: scope.output.snapshotId,
    };
    const metadata: LocalFieldMetadata[] = [];
    const add = (fieldId: string, label: string, kind: LocalFieldMetadata["kind"]) => {
      metadata.push(Object.freeze({ ref: Object.freeze({ ...scopeValue, fieldId }), label, kind }));
    };
    add("notes", "Notes", "text");
    if (item.type === 1) {
      add("login.username", "Username", "text");
      add("login.password", "Password", "hidden");
      add("login.totp-code", "Verification code", "otp");
    }
    if (item.type === 3) for (const key of cardFields) add(`card.${key}`, key, "text");
    if (item.type === 4) {
      for (const key of identityFields) add(`identity.${key}`, key, "text");
      add("identity.fullName", "Full name", "text");
    }
    const custom = new Map<string, number>();
    item.fields?.forEach((field, index) => {
      const id = `custom.${scopeValue.snapshotId}.${index}`;
      custom.set(id, index);
      add(
        id,
        field.name ?? `Custom field ${index + 1}`,
        (["text", "hidden", "boolean", "linked"] as const)[field.type] ?? "unsupported",
      );
    });
    let catalog: readonly LocalFieldMetadata[] = Object.freeze(metadata);
    const builtins = new Set(
      metadata.filter((entry) => !custom.has(entry.ref.fieldId)).map((entry) => entry.ref.fieldId),
    );
    const sourceValue = (fieldId: string): string | null | undefined => {
      if (!item) return undefined;
      if (fieldId === "notes") return item.notes;
      if (fieldId === "identity.fullName") {
        const identity = item.identity;
        if (!identity) return undefined;
        const parts = [
          identity["title"],
          identity["firstName"],
          identity["middleName"],
          identity["lastName"],
        ];
        if (parts.every((part) => part == null)) return undefined;
        return parts
          .filter((part): part is string => typeof part === "string" && part.trim().length > 0)
          .join(" ")
          .trim();
      }
      const [group, property] = fieldId.split(".");
      if (!property) return undefined;
      if (group === "login") return item.login?.[property as "username" | "password" | "totp"];
      if (group === "card") return item.card?.[property];
      if (group === "identity") return item.identity?.[property];
      return undefined;
    };
    return {
      ok: true,
      data: {
        list: () => catalog,
        resolve(ref, grant) {
          if (!item) return failure("crypto-locked");
          try {
            const reference = v.safeParse(refSchema, ref);
            if (!reference.success) return failure("invalid-field-input");
            const target = reference.output;
            if (
              target.connectionId !== scopeValue.connectionId ||
              target.userId !== scopeValue.userId ||
              target.itemId !== scopeValue.itemId ||
              target.snapshotId !== scopeValue.snapshotId
            ) {
              return failure("stale-field-reference");
            }
            if (
              !grant ||
              !Array.isArray(grant.allowedFieldIds) ||
              grant.allowedFieldIds.length > 2000 ||
              grant.allowedFieldIds.some((id) => typeof id !== "string" || id.length > 120) ||
              (grant.nowMs !== undefined && typeof grant.nowMs !== "function")
            )
              return failure("invalid-field-input");
            const allowed = new Set(grant.allowedFieldIds);
            const fieldId = target.fieldId;
            if (!allowed.has(fieldId)) return failure("field-denied");
            if (fieldId.startsWith("custom.") && !custom.has(fieldId))
              return failure("stale-field-reference");
            if (fieldId === "login.totp-code" && builtins.has(fieldId)) {
              if (!item.login?.totp) return failure("field-missing");
              const generated = generateLocalTotp(
                item.login.totp,
                grant.nowMs ? { nowMs: grant.nowMs } : {},
              );
              return item ? generated : failure("crypto-locked");
            }
            let value: string | null | undefined;
            if (custom.has(fieldId)) {
              const field = item.fields?.[custom.get(fieldId)!];
              if (!field) return failure("field-missing");
              if (field.type === 2) {
                if (field.value == null || field.value === "false")
                  return { ok: true, data: { kind: "boolean", checked: false } };
                if (field.value === "true")
                  return { ok: true, data: { kind: "boolean", checked: true } };
                return failure("unsupported-field");
              }
              if (field.type === 3) {
                const source = field.linkedId == null ? undefined : linkedSources[field.linkedId];
                if (!source || !builtins.has(source)) return failure("unsupported-field");
                const dependencies =
                  source === "identity.fullName" ? [source, ...fullNameDependencies] : [source];
                if (dependencies.some((id) => !allowed.has(id))) return failure("field-denied");
                value = sourceValue(source);
              } else if (field.type === 0 || field.type === 1) value = field.value;
              else return failure("unsupported-field");
            } else {
              if (!builtins.has(fieldId)) return failure("unsupported-field");
              if (
                fieldId === "identity.fullName" &&
                fullNameDependencies.some((id) => !allowed.has(id))
              )
                return failure("field-denied");
              value = sourceValue(fieldId);
            }
            return value == null
              ? failure("field-missing")
              : { ok: true, data: { kind: "text", value } };
          } catch {
            return failure("invalid-field-input");
          }
        },
        dispose() {
          item = undefined;
          custom.clear();
          builtins.clear();
          catalog = Object.freeze([]);
        },
      },
    };
  } catch {
    return failure("invalid-field-input");
  }
}
