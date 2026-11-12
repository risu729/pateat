import { expect, it } from "vitest";
import { admitPreparedBitwardenAccount } from "../../src/account";
import {
  accountProfile,
  rawLoginCipher,
  rawOrganizationAccount,
  rawV1Account,
  rawV2Account,
} from "../../src/__fixtures__/account";
import {
  fidoCredential,
  fidoPrivateKey,
  TEST_ORGANIZATION_ID,
  TEST_ORGANIZATION_KEY,
} from "../../src/__fixtures__/crypto";
import type { ItemMappingContext } from "./context";

export function registerItemMappingCases({
  setAt,
  mapRaw,
  expectLeftOut,
  received,
  rawWithCollection,
}: ItemMappingContext) {
  it.each([5, 6, 7, 8, 99])(
    "reports unsupported type%d without forwarding encrypted secrets or blocking login",
    (type) => {
      const raw = rawV1Account();
      raw.sync.ciphers.push({
        ...rawLoginCipher(),
        id: "10000000-0000-4000-8000-000000000003",
        type,
        name: "synthetic-unavailable-secret",
        data: "synthetic-unavailable-blob",
      });
      const result = mapRaw(raw);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.ciphers).toHaveLength(1);
      expect(result.data.unavailableItems).toEqual([
        { itemId: "10000000-0000-4000-8000-000000000003", reason: "unsupported-cipher-type" },
      ]);
      expect(JSON.stringify(result.data)).not.toContain("synthetic-unavailable-secret");
      expect(JSON.stringify(result.data)).not.toContain("synthetic-unavailable-blob");
      expect(result.data.coverage).toBe("received-envelope");
    },
  );

  it("rejects an unavailable item with invalid identifying metadata", () => {
    const raw = rawV1Account();
    raw.sync.ciphers.push({ ...rawLoginCipher(), id: "not-an-id", type: 99 });
    expect(mapRaw(raw).ok).toBe(false);
  });

  it("rejects duplicate organization identifiers rather than selecting a key", () => {
    const raw = rawOrganizationAccount();
    setAt(
      raw,
      ["sync", "profile", "organizations"],
      [
        { id: TEST_ORGANIZATION_ID, key: TEST_ORGANIZATION_KEY, enabled: true, status: 2 },
        { id: TEST_ORGANIZATION_ID, key: TEST_ORGANIZATION_KEY, enabled: true, status: 2 },
      ],
    );
    expect(mapRaw(raw)).toMatchObject({ ok: false, error: { code: "invalid-response" } });
  });

  it.each([
    [1, 1],
    [1, 5],
    [5, 1],
    [5, 99],
  ])("rejects duplicate supported/unavailable IDs with types %i and %i", (first, second) => {
    const raw = rawV1Account();
    raw.sync.ciphers[0]!.type = first;
    raw.sync.ciphers.push({ ...rawLoginCipher(), type: second });
    expect(mapRaw(raw).ok).toBe(false);
  });

  it.each(["profile", "ciphers", "folders", "collections", "policies", "sends"])(
    "rejects a truncated envelope missing %s",
    (key) => {
      const raw = rawV1Account();
      setAt(raw, ["sync", key], undefined);
      expect(mapRaw(raw).ok).toBe(false);
    },
  );

  it("keeps an empty envelope explicitly non-authoritative", () => {
    const raw = rawV1Account();
    raw.sync.ciphers = [];
    const result = mapRaw(raw);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.ciphers).toEqual([]);
      expect(result.data.coverage).toBe("received-envelope");
      expect(result.data).not.toHaveProperty("complete");
    }
  });

  it("ignores item keys Pateat does not read, as Vaultwarden returns them", async () => {
    // Vaultwarden returns the JSON a client stored and sends no Data. The official CLI's
    // `bw import` stores `response: null` in a passkey.
    const raw = rawV1Account();
    const cipher = raw.sync.ciphers[0]! as Record<string, unknown>;
    delete cipher["data"];
    cipher["login"] = {
      ...(cipher["login"] as Record<string, unknown>),
      futureField: "not-guessed",
      fido2Credentials: [{ ...fidoCredential, response: null }],
    };
    const { prepared, session } = await received(raw);
    expect(JSON.stringify(prepared.ciphers)).not.toMatch(/futureField|"response"/u);
    const request = { connectionId: accountProfile.connectionId, cipher: prepared.ciphers[0] };
    expect((await session.decryptCipher(request)).ok).toBe(true);
    expect(await session.decryptFido2PrivateKey(request)).toEqual({
      ok: true,
      data: fidoPrivateKey,
    });
  });

  it("ignores unknown typed keys beside the official server's stored Data", async () => {
    const raw = rawV1Account();
    const cipher = raw.sync.ciphers[0]! as Record<string, unknown>;
    cipher["login"] = { ...(cipher["login"] as Record<string, unknown>), futureField: "a" };
    const data = JSON.parse(cipher["data"] as string) as Record<string, unknown>;
    cipher["data"] = JSON.stringify({ ...data, futureField: "b" });
    const { prepared, session } = await received(raw);
    expect(JSON.stringify(prepared.ciphers)).not.toContain("futureField");
    const result = await session.decryptCipher({
      connectionId: accountProfile.connectionId,
      cipher: prepared.ciphers[0],
    });
    expect(result.ok && result.data.login?.password).toBe("test_password");
  });

  it.each(["Envelope", "WrappedCek", "FormatVersion", "ENVELOPE", "WRAPPED_CEK", "Format_Version"])(
    "does not read flat Data with the sealed-blob key %s as legacy fields",
    (key) => {
      const raw = rawV1Account();
      const cipher = raw.sync.ciphers[0]!;
      cipher.data = JSON.stringify({ ...JSON.parse(cipher.data), [key]: "synthetic" });
      expectLeftOut(raw, "unsupported-item");
    },
  );

  it.each([
    ["login", []],
    ["login", ["synthetic"]],
    ["fields", [[]]],
  ])("leaves out an item with an array where %s holds an object", (name, value) => {
    const raw = rawV1Account();
    const cipher = raw.sync.ciphers[0]! as Record<string, unknown>;
    delete cipher["data"];
    cipher[name] = value;
    expectLeftOut(raw, "malformed-item");
  });

  it("ignores legacy flat Data keys outside the item's type", async () => {
    const raw = rawV1Account();
    const cipher = raw.sync.ciphers[0]!;
    cipher.data = JSON.stringify({ ...JSON.parse(cipher.data), futureField: "not-guessed" });
    const { prepared } = await received(raw);
    expect(JSON.stringify(prepared.ciphers)).not.toContain("futureField");
  });

  it("leaves out an item whose legacy flat Data conflicts with its typed login fields", () => {
    const raw = rawV1Account();
    raw.sync.ciphers[0]!.data = JSON.stringify({
      name: raw.sync.ciphers[0]!.name,
      username: "2.conflicting-username",
      password: raw.sync.ciphers[0]!.login.password,
    });
    expectLeftOut(raw, "malformed-item");
  });

  it("does not reinterpret an unknown claimed sealed format as legacy fields", () => {
    const raw = rawV1Account();
    raw.sync.ciphers[0]!.data = JSON.stringify({
      format_version: 99,
      wrapped_cek: "synthetic",
      envelope: "synthetic",
    });
    expectLeftOut(raw, "malformed-item");
  });

  it("leaves out a partial cipher even when it carries plausible login fields", () => {
    const raw = rawV1Account();
    setAt(raw, ["sync", "ciphers", 0, "partialData"], { name: raw.sync.ciphers[0]!.name });
    expectLeftOut(raw, "unsupported-item");
  });

  it("leaves out an organization item with no received organization key", () => {
    const raw = rawOrganizationAccount();
    raw.sync.profile.organizations = [];
    expectLeftOut(raw, "unknown-organization");
  });

  it("leaves out only the item that does not admit, and readmits the record", async () => {
    const raw = rawV1Account();
    const good = structuredClone(raw.sync.ciphers[0]!);
    const broken = raw.sync.ciphers[0]! as Record<string, unknown>;
    broken["id"] = "3bc9ac1e-f5aa-45f2-94bf-b181009709b8";
    broken["data"] = "{not json";
    raw.sync.ciphers.push(good);
    const result = expectLeftOut(raw, "malformed-item");
    if (!result.ok) return;
    expect(result.data.ciphers).toHaveLength(1);
    const admitted = admitPreparedBitwardenAccount(structuredClone(result.data), accountProfile);
    expect(admitted.ok && admitted.data.unavailableItems).toEqual([
      { itemId: "3bc9ac1e-f5aa-45f2-94bf-b181009709b8", reason: "malformed-item" },
    ]);
    const { prepared, session } = await received(raw);
    expect(
      (
        await session.decryptCipher({
          connectionId: accountProfile.connectionId,
          cipher: prepared.ciphers[0],
        })
      ).ok,
    ).toBe(true);
  });

  it("leaves out an organization's collections and items when its key is not received", () => {
    const raw = rawWithCollection({});
    setAt(raw, ["sync", "profile", "organizations", 0, "key"], null);
    const result = expectLeftOut(raw, "unknown-organization");
    expect(result.ok && result.data.encryptedMetadata.collections).toEqual([]);
    // Such a collection is still checked, and one outside every membership still fails.
    const malformed = rawWithCollection({ readOnly: "yes" });
    setAt(malformed, ["sync", "profile", "organizations", 0, "key"], null);
    expect(mapRaw(malformed)).toMatchObject({ ok: false, error: { code: "invalid-response" } });
    const outside = rawWithCollection({});
    outside.sync.profile.organizations = [];
    expect(mapRaw(outside)).toMatchObject({ ok: false, error: { code: "invalid-response" } });
  });

  it.each([
    ["a missing", undefined],
    ["an invalid", "not-a-uuid"],
  ])("still fails the sync for an item with %s ID", (_name, id) => {
    const raw = rawV1Account();
    setAt(raw, ["sync", "ciphers", 0, "id"], id);
    expect(mapRaw(raw)).toMatchObject({ ok: false, error: { code: "invalid-response" } });
  });

  it("does not mutate caller-owned DTOs during mapping", () => {
    const raw = rawV2Account();
    const before = structuredClone(raw);
    expect(mapRaw(raw).ok).toBe(true);
    expect(raw).toEqual(before);
  });

  it.each(["login", "fields", "data"])(
    "leaves out an item with an own __proto__ member in %s without prototype pollution",
    (target) => {
      const raw = rawV1Account();
      const cipher = raw.sync.ciphers[0]!;
      if (target === "login") {
        setAt(cipher, ["data"], undefined);
        setAt(
          cipher,
          ["login"],
          JSON.parse(
            JSON.stringify(cipher.login).replace(
              /\}$/u,
              ',"__proto__":{"polluted":"synthetic-secret"}}',
            ),
          ),
        );
      } else if (target === "fields") {
        setAt(cipher, ["data"], undefined);
        setAt(
          cipher,
          ["fields"],
          JSON.parse(
            '[{"name":null,"value":null,"type":0,"__proto__":{"polluted":"synthetic-secret"}}]',
          ),
        );
      } else {
        cipher.data = cipher.data.replace(/\}$/u, ',"__proto__":{"polluted":"synthetic-secret"}}');
      }
      const result = expectLeftOut(raw, "malformed-item");
      expect(JSON.stringify(result)).not.toContain("synthetic-secret");
      expect("polluted" in {}).toBe(false);
    },
  );
}
