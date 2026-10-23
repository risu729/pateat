import { describe, expect, it } from "vitest";
import { admitSessionKey, memorySessionKeyStore, sessionKeyStorageKey } from "./session-key";
import { legacyItemKey } from "../../../../packages/bitwarden/src/__fixtures__/crypto";
import { revision } from "./__fixtures__/vault";

describe("session key admission", () => {
  it("admits a key for a record revision", () => {
    expect(admitSessionKey({ revision, userKey: legacyItemKey })).toEqual({
      revision,
      userKey: legacyItemKey,
    });
  });
  it.each([
    undefined,
    null,
    "key",
    {},
    { revision },
    { userKey: legacyItemKey },
    { revision: "not-a-uuid", userKey: legacyItemKey },
    { revision, userKey: "" },
    { revision, userKey: "not base64!" },
    { revision, userKey: "A".repeat(1_048_577) },
    { revision, userKey: legacyItemKey, extra: true },
  ])("is no key for %j: the vault stays locked", (value) => {
    expect(admitSessionKey(value)).toBeUndefined();
  });
  it("names one session storage key per connection", () => {
    expect(sessionKeyStorageKey("a")).toBe("session:pateat.vault-key.v1.a");
    expect(sessionKeyStorageKey("a")).not.toBe(sessionKeyStorageKey("b"));
  });
});

describe("memory session key store", () => {
  it("keeps a copy until cleared", async () => {
    const store = memorySessionKeyStore();
    expect(await store.read()).toBeUndefined();
    const value = { revision, userKey: legacyItemKey };
    await store.write(value);
    value.userKey = "changed";
    const read = await store.read();
    expect(read).toEqual({ revision, userKey: legacyItemKey });
    read!.revision = "changed";
    expect(await store.read()).toEqual({ revision, userKey: legacyItemKey });
    await store.clear();
    expect(await store.read()).toBeUndefined();
  });
});
