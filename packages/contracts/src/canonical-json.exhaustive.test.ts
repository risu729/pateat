import { describe, expect, it } from "vitest";
import { canonicalJson } from "./canonical-json";

// The three previous implementations are compatibility oracles, kept only in tests.
function oldUnits(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(oldUnits).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .filter(([, member]) => member !== undefined)
      .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, member]) => `${JSON.stringify(key)}:${oldUnits(member)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

function oldPolicy(value: unknown): string {
  const canonical = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(canonical);
    if (item && typeof item === "object")
      return Object.fromEntries(
        Object.entries(item)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([key, entry]) => [key, canonical(entry)]),
      );
    return item;
  };
  return JSON.stringify(canonical(value));
}

function oldLogin(value: unknown): string {
  return JSON.stringify(value, (_key, entry: unknown) =>
    entry && typeof entry === "object" && !Array.isArray(entry)
      ? Object.fromEntries(
          Object.entries(entry).sort(([left], [right]) =>
            left < right ? -1 : left > right ? 1 : 0,
          ),
        )
      : entry,
  );
}

const atoms: unknown[] = [null, false, true, 0, -0, 1.25, "", '"\\\n\t', "雪😀", "\ud800"];
const namedKeys = ["steps", "target", "value", "name", "linkedId", "optional"];
const integerKeys = ["9", "10", "01", "4294967294", "4294967295"];
const keys = [...namedKeys, ...integerKeys, "é", "😀", 'quote"', "__proto__"];

/**
 * A bounded deterministic walk: at each of three depths, every pair of keys and
 * every atom chooses two children from the preceding depth. Both insertion orders,
 * arrays and undefined object members are included without an exponential tree set.
 */
function generated(alphabet: readonly string[]): unknown[] {
  const all = [...atoms];
  let children = atoms;
  for (let depth = 1; depth <= 3; depth++) {
    const next: unknown[] = [];
    for (const [i, leftKey] of alphabet.entries()) {
      for (const [j, rightKey] of alphabet.entries()) {
        for (const [k, atom] of atoms.entries()) {
          const left = children[(i * alphabet.length + j + k) % children.length];
          const right = children[(j * atoms.length + k * 7 + i) % children.length];
          const entries: [string, unknown][] = [
            [leftKey, left],
            [rightKey, right],
            ["absent", undefined],
          ];
          next.push([left, atom, right], Object.fromEntries(entries));
          next.push(Object.fromEntries([...entries].reverse()));
        }
      }
    }
    all.push(...next);
    children = next;
  }
  return all;
}

function differences(values: readonly unknown[], oracle: (value: unknown) => string) {
  return values
    .filter((value) => canonicalJson(value) !== oracle(value))
    .slice(0, 5)
    .map((value) => ({ value, actual: canonicalJson(value), expected: oracle(value) }));
}

describe("canonical JSON compatibility across the callers' data", () => {
  it("preserves recipe content digest bytes through depth three, including integer-like keys", () => {
    const values = generated(keys);
    expect(values.length).toBeGreaterThan(20_000);
    expect(differences(values, oldUnits)).toEqual([]);
  });

  it("preserves login equality serialization for parsed recipes with named object members", () => {
    // login.ts uses strict object schemas, never records or custom toJSON methods.
    expect(differences(generated(namedKeys), oldLogin)).toEqual([]);
  });

  it("preserves ciphertext evidence bytes for every admitted material shape", () => {
    // local-crypto.ts fieldSchema strips unknown keys; sealed data is an opaque string.
    const fields = [undefined, null, "", "2.synthetic|ciphertext", "雪"];
    const values: unknown[] = [];
    for (const name of fields) {
      for (const value of fields) {
        for (const type of [0, 1, 2, 3]) {
          for (const linkedId of [undefined, null, 100, 300]) {
            const field = { name, value, type, linkedId };
            const reversed = Object.fromEntries(Object.entries(field).reverse());
            for (const key of [null, "2.synthetic|key"]) {
              for (const organizationId of [null, "synthetic-organization"]) {
                values.push(
                  { fields: [field, reversed], key, organizationId },
                  { organizationId, key, fields: [] },
                  { data: '{"format_version":1,"10":"opaque","9":"opaque"}', key, organizationId },
                );
              }
            }
          }
        }
      }
    }
    expect(values.length).toBe(4_800);
    expect(differences(values, oldPolicy)).toEqual([]);
  });

  it("uses code-unit order and JSON escaping without reordering arrays", () => {
    expect(canonicalJson({ "9": 2, "10": 1, a: 3 })).toBe('{"10":1,"9":2,"a":3}');
    expect(canonicalJson([1, undefined])).toBe("[1,null]");
    expect(canonicalJson(Array(2))).toBe("[null,null]");
    expect(canonicalJson({ absent: undefined, zero: -0 })).toBe('{"zero":0}');
    expect(canonicalJson(undefined)).toBeUndefined();
    expect(JSON.parse(canonicalJson(['"\\\n\t', "雪😀", "\ud800"])!)).toEqual([
      '"\\\n\t',
      "雪😀",
      "\ud800",
    ]);
  });
});
