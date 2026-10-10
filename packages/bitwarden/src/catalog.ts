import * as v from "valibot";

const id = v.pipe(v.string(), v.minLength(1), v.maxLength(200));
const label = v.pipe(v.string(), v.minLength(1), v.maxLength(200));
const uuid = v.pipe(v.string(), v.uuid());
/** Fixed metadata projection. Credential values, seed/URI strings and native handles are absent. */
export const localVaultMetadataSchema = v.strictObject({
  connectionId: id,
  userId: uuid,
  snapshotId: uuid,
  groups: v.pipe(
    v.array(v.strictObject({ id: uuid, label, kind: v.picklist(["folder", "collection"]) })),
    v.maxLength(10000),
  ),
  items: v.pipe(
    v.array(
      v.strictObject({
        id: uuid,
        label,
        type: v.picklist([1, 2, 3, 4]),
        groupIds: v.pipe(v.array(uuid), v.maxLength(1000)),
        fields: v.pipe(
          v.array(
            v.strictObject({
              id,
              label,
              name: v.nullable(label),
              kind: v.picklist(["text", "hidden", "boolean", "linked", "otp", "unsupported"]),
              linkedFieldId: v.optional(id),
            }),
          ),
          v.maxLength(2000),
        ),
      }),
    ),
    v.maxLength(10000),
  ),
});
export type LocalVaultMetadata = v.InferOutput<typeof localVaultMetadataSchema>;
/**
 * A field name is never truncated, because bindings match it exactly. A name longer than
 * a label is withheld (`null`), so it cannot be referenced.
 */
export const vaultFieldName = (value: string | null) =>
  value && value.length <= 200 ? value : null;
/** Label truncation affects display only, never identity or permission binding. */
export const vaultDisplayLabel = (value: string | null | undefined, fallback: string) =>
  (value || fallback).slice(0, 200);
