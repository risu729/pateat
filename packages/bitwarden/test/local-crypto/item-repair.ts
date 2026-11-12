import { expect, it } from "vitest";
import { fidoCredential, legacyCipher, uriCiphertexts } from "../../src/__fixtures__/crypto";
import type { ItemRepairContext } from "./context";

export function registerItemRepairTests({ connectionId, corrupt, session }: ItemRepairContext) {
  it("leaves out only the fields that do not decrypt and keeps the rest", async () => {
    const active = await session();
    const original = legacyCipher();
    const cipher = {
      ...original,
      notes: corrupt(original.name),
      login: {
        ...original.login,
        password: corrupt(original.login.password),
        uris: [
          { uri: uriCiphertexts.uri, match: null, uriChecksum: uriCiphertexts.checksum },
          { uri: corrupt(uriCiphertexts.uri), match: null, uriChecksum: null },
        ],
      },
      fields: [
        { name: original.name, value: corrupt(original.login.username), type: 0, linkedId: null },
      ],
    };
    expect(await active.decryptCipher({ connectionId, cipher })).toEqual({
      ok: false,
      error: { code: "crypto-failed", check: "sdk-decrypt" },
    });
    const repaired = await active.repairCipher({ connectionId, cipher });
    expect(repaired.ok && repaired.data.unreadable).toEqual([
      "notes",
      "login.password",
      "fields.0.value",
      "login.uris.1",
    ]);
    if (!repaired.ok) return;
    const view = await active.decryptCipher({ connectionId, cipher: repaired.data.cipher });
    expect(view.ok).toBe(true);
    if (!view.ok) return;
    expect(view.data.name).toBe("My test login");
    expect(view.data.login?.username).toBeTruthy();
    expect(view.data.login?.password ?? null).toBeNull();
    expect(view.data.login?.uris).toHaveLength(1);
    expect(view.data.fields?.[0]?.name).toBe("My test login");
    expect(view.data.fields?.[0]?.value ?? null).toBeNull();
  });

  it("leaves out only the attachments, which Pateat does not use, that do not decrypt", async () => {
    const active = await session();
    const original = legacyCipher();
    const attachment = (id: string, fileName: string) => ({
      id,
      url: null,
      fileName,
      key: null,
      size: "10",
      sizeName: "10 Bytes",
    });
    const cipher = {
      ...original,
      attachments: [
        attachment("a1b2c3", corrupt(original.name)),
        attachment("d4e5f6", original.name),
      ],
    };
    const refused = await active.decryptCipher({ connectionId, cipher });
    expect(refused).toMatchObject({ ok: false, error: { code: "crypto-failed" } });
    const repaired = await active.repairCipher({ connectionId, cipher });
    expect(repaired.ok && repaired.data.unreadable).toEqual(["attachments"]);
    expect(repaired.ok && repaired.data.cipher.attachments?.map(({ id }) => id)).toEqual([
      "d4e5f6",
    ]);
  });

  it("keeps an unreadable passkey, which only passkey operations decrypt", async () => {
    const active = await session();
    const original = legacyCipher();
    const cipher = {
      ...original,
      login: {
        ...original.login,
        password: corrupt(original.login.password),
        fido2Credentials: [{ ...fidoCredential, keyValue: corrupt(fidoCredential.keyValue) }],
      },
    };
    const repaired = await active.repairCipher({ connectionId, cipher });
    expect(repaired.ok && repaired.data.unreadable).toEqual(["login.password"]);
    expect(repaired.ok && repaired.data.cipher.login?.fido2Credentials).toHaveLength(1);
  });

  it("leaves out another item type's unreadable value without reporting it", async () => {
    const active = await session();
    const original = legacyCipher();
    const cipher = {
      ...original,
      notes: corrupt(original.name),
      card: {
        cardholderName: corrupt(original.name),
        brand: null,
        number: null,
        expMonth: null,
        expYear: null,
        code: null,
      },
    };
    const repaired = await active.repairCipher({ connectionId, cipher });
    expect(repaired.ok && repaired.data.unreadable).toEqual(["notes"]);
  });

  it("does not repair an item with more than 500 encrypted values", async () => {
    const active = await session();
    const original = legacyCipher();
    const fields = Array.from({ length: 250 }, () => ({
      name: original.name,
      value: original.name,
      type: 0,
      linkedId: null,
    }));
    const cipher = { ...original, notes: corrupt(original.name), fields };
    expect(await active.repairCipher({ connectionId, cipher })).toEqual({
      ok: false,
      error: { code: "crypto-failed", check: "sdk-decrypt" },
    });
    expect(
      (await active.repairCipher({ connectionId, cipher: { ...cipher, fields: fields.slice(10) } }))
        .ok,
    ).toBe(true);
  });

  it("does not repair an item whose name does not decrypt", async () => {
    const active = await session();
    const original = legacyCipher();
    expect(
      await active.repairCipher({
        connectionId,
        cipher: { ...original, name: corrupt(original.name) },
      }),
    ).toEqual({ ok: false, error: { code: "crypto-failed", check: "sdk-decrypt" } });
  });

  it("does not repair an item with nothing to leave out", async () => {
    const active = await session();
    expect(await active.repairCipher({ connectionId, cipher: legacyCipher() })).toEqual({
      ok: false,
      error: { code: "crypto-failed", check: "sdk-decrypt" },
    });
  });

  it("does not repair a sealed blob, which is one ciphertext", async () => {
    const active = await session();
    const original = legacyCipher();
    expect(
      await active.repairCipher({ connectionId, cipher: { ...original, data: "synthetic" } }),
    ).toMatchObject({ ok: false });
  });
}
