/**
 * Canonical JSON for plain JSON-shaped data, without cycles or custom toJSON methods.
 * Object keys use code-unit order, including integer-like keys; undefined object
 * members are omitted. Array order is kept, with undefined elements and holes as null.
 * Like JSON.stringify, an undefined root has no representation.
 */
export function canonicalJson(value: unknown): string | undefined {
  if (Array.isArray(value))
    return `[${Array.from(value, (member) => canonicalJson(member) ?? "null").join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .filter(([, member]) => member !== undefined)
      .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, member]) => `${JSON.stringify(key)}:${canonicalJson(member)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
