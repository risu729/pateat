import { afterEach, describe, expect, it, vi } from "vitest";
import * as sdk from "@bitwarden/sdk-internal/node/bitwarden_wasm_internal.js";
import * as v from "valibot";
import { createLocalCryptoSession, type LocalCryptoSession } from "./local-crypto";
import { localVaultMetadataSchema } from "./catalog";
import { preparedVault, type VaultFixtureKind } from "./__fixtures__/unlock";
import {
  legacyName,
  organizationCipherFields,
  TEST_ORGANIZATION_ID,
  v1Password,
} from "./__fixtures__/crypto";

const groupId = "6abcdef0-0000-4000-8000-000000000001";
const secondGroupId = "60000000-0000-4000-8000-000000000002";
const snapshotId = "70000000-0000-4000-8000-000000000001";
const sessions: LocalCryptoSession[] = [];
const network = vi.fn(() => {
  throw new Error("Unexpected synthetic catalog network request");
});
async function session(kind: VaultFixtureKind = "v1") {
  vi.stubGlobal("fetch", network);
  const p = preparedVault(kind);
  const opened = await createLocalCryptoSession(
    {
      connectionId: p.binding.profile.connectionId,
      userId: p.binding.userId,
      email: p.binding.email,
      kdf: p.kdf,
      accountCryptographicState: p.accountCryptographicState,
      organizationKeys: p.organizationKeys,
      minimumSecurityVersion: p.minimumSecurityVersion,
      unlock: {
        kind: "password",
        password: v1Password,
        masterPasswordUnlock: p.masterPasswordUnlock,
      },
    },
    sdk,
  );
  if (!opened.ok) throw new Error("Synthetic catalog session failed");
  sessions.push(opened.data);
  return opened.data;
}
function folder(id = groupId, name = legacyName) {
  return { id, name, revisionDate: "2024-01-30T17:55:36.150Z" };
}
function collection() {
  return {
    id: groupId,
    organizationId: TEST_ORGANIZATION_ID,
    name: organizationCipherFields.name,
    externalId: null,
    hidePasswords: false,
    readOnly: false,
    manage: true,
    defaultUserCollectionEmail: null,
    type: 0,
  };
}
function corrupt(value: string) {
  const parts = value.split("|");
  const mac = parts[2]!;
  parts[2] = `${mac[0] === "A" ? "B" : "A"}${mac.slice(1)}`;
  return parts.join("|");
}
afterEach(() => {
  for (const active of sessions.splice(0)) active.dispose();
  expect(network).not.toHaveBeenCalled();
  network.mockClear();
  vi.unstubAllGlobals();
});

describe("actual SDK metadata group verification", () => {
  it("decrypts folder names while preserving duplicate labels as distinct IDs", async () => {
    const active = await session();
    expect(
      await active.decryptCatalogGroups({
        folders: [folder(), folder(secondGroupId)],
        collections: [],
      }),
    ).toEqual({
      ok: true,
      data: [
        { id: groupId, label: "My test login", kind: "folder" },
        { id: secondGroupId, label: "My test login", kind: "folder" },
      ],
    });
  });
  it("uses the verified organization key for a collection label", async () => {
    const active = await session("organization");
    expect(await active.decryptCatalogGroups({ folders: [], collections: [collection()] })).toEqual(
      {
        ok: true,
        data: [{ id: groupId, label: "Synthetic organization login", kind: "collection" }],
      },
    );
  });
  it("rejects corrupt authenticated folder names even if the SDK folder helper would swallow the error", async () => {
    const active = await session();
    expect(
      await active.decryptCatalogGroups({
        folders: [folder(groupId, corrupt(legacyName))],
        collections: [],
      }),
    ).toEqual({ ok: false, error: { code: "crypto-failed" } });
  });
  it("rejects duplicate case-normalized group identities", async () => {
    const active = await session();
    expect(
      await active.decryptCatalogGroups({
        folders: [folder(), folder(groupId.toUpperCase())],
        collections: [],
      }),
    ).toEqual({ ok: false, error: { code: "invalid-crypto-input" } });
  });
  it("requires an initialized organization key before projecting that collection", async () => {
    const active = await session();
    expect(
      (await active.decryptCatalogGroups({ folders: [], collections: [collection()] })).ok,
    ).toBe(false);
  });
  it("fails closed for a non-cloneable group request without throwing a raw error", async () => {
    const active = await session();
    await expect(
      active.decryptCatalogGroups({ folders: [], collections: [], extra: () => {} }),
    ).resolves.toEqual({ ok: false, error: { code: "invalid-crypto-input" } });
  });
  it("cannot project names after session disposal", async () => {
    const active = await session();
    active.dispose();
    expect(await active.decryptCatalogGroups({ folders: [folder()], collections: [] })).toEqual({
      ok: false,
      error: { code: "crypto-locked" },
    });
  });
});

describe("value-free catalog admission", () => {
  function metadata() {
    const prepared = preparedVault();
    return {
      connectionId: prepared.binding.profile.connectionId,
      userId: prepared.binding.userId,
      snapshotId,
      groups: [{ id: groupId, label: "Folder", kind: "folder" }],
      items: [
        {
          id: String(prepared.ciphers[0]!.id),
          label: "Login",
          type: 1,
          groupIds: [groupId],
          fields: [{ id: "login.password", label: "Password", kind: "hidden" }],
        },
      ],
    };
  }
  it("admits names, field labels/types, snapshot references and group IDs", () => {
    const value = metadata();
    expect(v.safeParse(localVaultMetadataSchema, value).success).toBe(true);
  });
  it.each(["value", "password", "totp", "uri", "userKey", "accessToken"])(
    "rejects raw %s at the field boundary",
    (key) => {
      const value = metadata();
      Object.assign(value.items[0]!.fields[0]!, { [key]: "synthetic-secret" });
      expect(v.safeParse(localVaultMetadataSchema, value).success).toBe(false);
    },
  );
  it("rejects a native handle alongside otherwise valid catalog metadata", () => {
    expect(
      v.safeParse(localVaultMetadataSchema, {
        ...metadata(),
        session: { sessionId: crypto.randomUUID() },
      }).success,
    ).toBe(false);
  });
});
