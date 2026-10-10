import { describe, expect, it } from "vitest";
import * as sdk from "@bitwarden/sdk-internal/node/bitwarden_wasm_internal.js";
import { createLocalFieldSnapshot } from "./fields";
import { createLocalCryptoSession } from "./local-crypto";
import {
  customFieldId,
  fieldConnectionId,
  fieldItemId,
  fieldSnapshotId,
  fieldUserId,
  localCardView,
  localIdentityView,
  localLoginView,
  nextFieldSnapshotId,
} from "./__fixtures__/fields";
import {
  customFieldCiphertexts,
  legacyCipher,
  v1Email,
  v1Kdf,
  v1Password,
  v1PrivateKey,
  v1WrappedUserKey,
} from "./__fixtures__/crypto";
import { rfcTotpSecrets } from "./__fixtures__/totp";

function snapshot(item: unknown = localLoginView(), snapshotId = fieldSnapshotId) {
  const created = createLocalFieldSnapshot({
    connectionId: fieldConnectionId,
    userId: fieldUserId,
    snapshotId,
    item,
  });
  expect(created.ok).toBe(true);
  if (!created.ok) throw new Error("Synthetic field snapshot rejected");
  return created.data;
}
function fieldRef(fieldId: string, itemId = fieldItemId, snapshotId = fieldSnapshotId) {
  return { connectionId: fieldConnectionId, userId: fieldUserId, itemId, snapshotId, fieldId };
}
const allow = (...allowedFieldIds: string[]) => ({ allowedFieldIds });
const text = (value: string) => ({ ok: true, data: { kind: "text", value } });

describe("local field references and permission boundaries", () => {
  it("keeps duplicate custom names distinct and preserves leading zeros", () => {
    const active = snapshot();
    const fields = active.list().filter((field) => field.label === "duplicate");
    expect(fields).toHaveLength(2);
    expect(fields.map((field) => field.ref.fieldId)).toEqual([customFieldId(0), customFieldId(1)]);
    expect(fields.map((field) => field.kind)).toEqual(["text", "hidden"]);
    expect(active.resolve(fields[0]!.ref, allow(customFieldId(0)))).toEqual(text("007"));
    expect(active.resolve(fields[1]!.ref, allow(customFieldId(1)))).toEqual(text("00001234"));
    expect(active.resolve(fieldRef("login.username"), allow("login.username"))).toEqual(
      text("00001234"),
    );
  });

  it("exposes only field reference, label and kind in listed metadata", () => {
    const active = snapshot();
    for (const field of active.list()) {
      expect(Object.keys(field).sort()).toEqual(["kind", "label", "ref"]);
      expect(Object.keys(field.ref).sort()).toEqual([
        "connectionId",
        "fieldId",
        "itemId",
        "snapshotId",
        "userId",
      ]);
    }
    const metadata = JSON.stringify(active.list());
    for (const secret of [
      "Synthetic-password",
      "00001234",
      "ignored stored alias value",
      "Local note",
    ])
      expect(metadata).not.toContain(secret);
    expect(Object.isFrozen(active.list())).toBe(true);
    expect(
      active.list().every((entry) => Object.isFrozen(entry) && Object.isFrozen(entry.ref)),
    ).toBe(true);
  });

  it("does not release a value after an allowlist revocation", () => {
    const active = snapshot();
    const ref = fieldRef("login.password");
    expect(active.resolve(ref, allow("login.password"))).toEqual(text("Synthetic-password"));
    expect(active.resolve(ref, allow())).toEqual({ ok: false, error: { code: "field-denied" } });
  });

  it.each(["connectionId", "userId", "itemId", "snapshotId"])("rejects stale %s binding", (key) => {
    const ref = {
      ...fieldRef("login.password"),
      [key]: key === "connectionId" ? "other-connection" : nextFieldSnapshotId,
    };
    expect(snapshot().resolve(ref, allow("login.password"))).toEqual({
      ok: false,
      error: { code: "stale-field-reference" },
    });
  });

  it("rejects old ordinal references after a new snapshot reorders custom fields", () => {
    const oldRef = fieldRef(customFieldId(0));
    const item = localLoginView();
    item.fields.reverse();
    const current = snapshot(item, nextFieldSnapshotId);
    expect(current.resolve(oldRef, allow(oldRef.fieldId))).toEqual({
      ok: false,
      error: { code: "stale-field-reference" },
    });
    expect(
      current.resolve(
        fieldRef(customFieldId(0, nextFieldSnapshotId), fieldItemId, nextFieldSnapshotId),
        allow(customFieldId(0, nextFieldSnapshotId), "login.password"),
      ),
    ).toEqual(text("Synthetic-password"));
  });

  it("does not remap an old custom exclusion to an unrelated new ordinal", () => {
    const current = snapshot(localLoginView(), nextFieldSnapshotId);
    expect(
      current.resolve(
        fieldRef(customFieldId(1, nextFieldSnapshotId), fieldItemId, nextFieldSnapshotId),
        allow(customFieldId(1)),
      ),
    ).toEqual({ ok: false, error: { code: "field-denied" } });
  });

  it("copies caller-owned values and metadata instead of trusting later mutations", () => {
    const item = localLoginView();
    const active = snapshot(item);
    item.login.password = "replaced after capture";
    item.fields[0]!.value = "replaced after capture";
    item.fields[0]!.name = "replaced after capture";
    expect(active.resolve(fieldRef("login.password"), allow("login.password"))).toEqual(
      text("Synthetic-password"),
    );
    expect(active.resolve(fieldRef(customFieldId(0)), allow(customFieldId(0)))).toEqual(
      text("007"),
    );
    expect(active.list().find((field) => field.ref.fieldId === customFieldId(0))?.label).toBe(
      "duplicate",
    );
  });

  it("locks values and metadata permanently when disposed", () => {
    const active = snapshot();
    active.dispose();
    active.dispose();
    expect(active.list()).toEqual([]);
    expect(active.resolve(fieldRef("login.password"), allow("login.password"))).toEqual({
      ok: false,
      error: { code: "crypto-locked" },
    });
  });

  it("treats an empty value as present while absent fields are missing", () => {
    const item = localLoginView();
    item.login.username = "";
    item.notes = null as unknown as string;
    const active = snapshot(item);
    expect(active.resolve(fieldRef("login.username"), allow("login.username"))).toEqual(text(""));
    expect(active.resolve(fieldRef("notes"), allow("notes"))).toEqual({
      ok: false,
      error: { code: "field-missing" },
    });
  });

  // Bitwarden's hidden-password permission still allows autofill. Pateat's
  // explicit source exclusion must win regardless of this visibility flag.
  it.each([false, null, undefined])(
    "visibility flag %s does not replace explicit fill permissions",
    (viewPassword) => {
      const active = snapshot({ ...localLoginView(), viewPassword });
      expect(active.resolve(fieldRef("login.password"), allow("login.password"))).toEqual(
        text("Synthetic-password"),
      );
      expect(
        active.resolve(fieldRef(customFieldId(3)), allow(customFieldId(3), "login.password")),
      ).toEqual(text("Synthetic-password"));
      expect(active.resolve(fieldRef("login.password"), allow())).toEqual({
        ok: false,
        error: { code: "field-denied" },
      });
      expect(active.resolve(fieldRef(customFieldId(3)), allow(customFieldId(3)))).toEqual({
        ok: false,
        error: { code: "field-denied" },
      });
    },
  );
});

describe("custom field value semantics", () => {
  it.each([
    ["true", true],
    ["false", false],
    [null, false],
    [undefined, false],
  ])("returns a typed checkbox for stored %s", (value, checked) => {
    const active = snapshot({ ...localLoginView(), fields: [{ name: "Check", type: 2, value }] });
    expect(active.resolve(fieldRef(customFieldId(0)), allow(customFieldId(0)))).toEqual({
      ok: true,
      data: { kind: "boolean", checked },
    });
  });
  it.each(["TRUE", "False", "0", "1", "", "yes"])(
    "does not coerce unsupported Boolean %s",
    (value) => {
      const active = snapshot({ ...localLoginView(), fields: [{ name: "Check", type: 2, value }] });
      expect(active.resolve(fieldRef(customFieldId(0)), allow(customFieldId(0)))).toEqual({
        ok: false,
        error: { code: "unsupported-field" },
      });
    },
  );

  it.each([
    { allowedFieldIds: [customFieldId(3)] },
    { allowedFieldIds: ["login.password"] },
    { allowedFieldIds: [] },
  ])("requires both linked alias and source permissions %#", ({ allowedFieldIds }) => {
    expect(snapshot().resolve(fieldRef(customFieldId(3)), { allowedFieldIds })).toEqual({
      ok: false,
      error: { code: "field-denied" },
    });
  });

  it("resolves a linked field from its actual source instead of stored alias value", () => {
    expect(
      snapshot().resolve(fieldRef(customFieldId(3)), allow(customFieldId(3), "login.password")),
    ).toEqual(text("Synthetic-password"));
  });

  it("does not fall back to a linked alias value when its source is missing", () => {
    const active = snapshot({
      ...localLoginView(),
      login: { username: "synthetic", password: null, totp: null },
    });
    expect(
      active.resolve(fieldRef(customFieldId(3)), allow(customFieldId(3), "login.password")),
    ).toEqual({
      ok: false,
      error: { code: "field-missing" },
    });
  });

  // Exact LinkedIdType values in the pinned SDK cipher/linked_id.rs.
  it.each([
    [300, "card.cardholderName", "Synthetic Owner"],
    [301, "card.expMonth", "01"],
    [302, "card.expYear", "2030"],
    [303, "card.code", "007"],
    [304, "card.brand", "Visa"],
    [305, "card.number", "00001234"],
  ])("resolves card linked ID %d without numeric normalization", (linkedId, source, value) => {
    const item = {
      ...localCardView(),
      fields: [{ name: "Link", type: 3, linkedId, value: "misleading alias" }],
    };
    expect(
      snapshot(item).resolve(fieldRef(customFieldId(0)), allow(customFieldId(0), source)),
    ).toEqual(text(value));
  });

  it("resolves calculated identity full name with every source permission", () => {
    const item = { ...localIdentityView(), fields: [{ name: "Name", type: 3, linkedId: 418 }] };
    const ids = [
      "identity.fullName",
      "identity.title",
      "identity.firstName",
      "identity.middleName",
      "identity.lastName",
    ];
    const active = snapshot(item);
    expect(active.resolve(fieldRef(customFieldId(0)), allow(customFieldId(0), ...ids))).toEqual(
      text("Dr Ada M Example"),
    );
    for (const excluded of ids) {
      expect(
        active.resolve(
          fieldRef(customFieldId(0)),
          allow(customFieldId(0), ...ids.filter((id) => id !== excluded)),
        ),
      ).toEqual({
        ok: false,
        error: { code: "field-denied" },
      });
    }
  });

  it.each([100, 300, 999])(
    "rejects incompatible/unknown linked ID %d on a secure note",
    (linkedId) => {
      const active = snapshot({
        ...localLoginView(),
        type: 2,
        login: null,
        secureNote: { type: 0 },
        fields: [{ name: "Link", type: 3, linkedId, value: "cannot be a fallback" }],
      });
      expect(
        active.resolve(
          fieldRef(customFieldId(0)),
          allow(customFieldId(0), "login.username", "card.cardholderName"),
        ),
      ).toEqual({
        ok: false,
        error: { code: "unsupported-field" },
      });
    },
  );

  it("supports secure-note text and hidden custom fields", () => {
    const active = snapshot({ ...localLoginView(), type: 2, login: null, secureNote: { type: 0 } });
    expect(active.resolve(fieldRef("notes"), allow("notes"))).toEqual(text("Local note"));
    expect(active.resolve(fieldRef(customFieldId(1)), allow(customFieldId(1)))).toEqual(
      text("00001234"),
    );
  });
});

describe("field admission and unavailable modes", () => {
  it.each(["connectionId", "userId", "snapshotId"])(
    "rejects malformed captured scope %s",
    (key) => {
      expect(
        createLocalFieldSnapshot({
          connectionId: fieldConnectionId,
          userId: fieldUserId,
          snapshotId: fieldSnapshotId,
          item: localLoginView(),
          [key]: "",
        }),
      ).toEqual({
        ok: false,
        error: { code: "invalid-field-input" },
      });
    },
  );

  it.each([
    null,
    [],
    { ...localLoginView(), id: "not-a-uuid" },
    { ...localLoginView(), login: null },
    { ...localLoginView(), login: [] },
    { ...localLoginView(), type: 0 },
    { ...localLoginView(), type: 1.5 },
    { ...localLoginView(), fields: [null] },
    { ...localLoginView(), fields: [[]] },
    { ...localLoginView(), fields: [{ type: 0, value: 123 }] },
  ])("rejects malformed captured item case %# without reflecting values", (item) => {
    expect(
      createLocalFieldSnapshot({
        connectionId: fieldConnectionId,
        userId: fieldUserId,
        snapshotId: fieldSnapshotId,
        item,
      }),
    ).toEqual({
      ok: false,
      error: { code: "invalid-field-input" },
    });
  });

  it.each([5, 6, 7, 8, 999])("reports unsupported item type %d explicitly", (type) => {
    expect(
      createLocalFieldSnapshot({
        connectionId: fieldConnectionId,
        userId: fieldUserId,
        snapshotId: fieldSnapshotId,
        item: { ...localLoginView(), type },
      }),
    ).toEqual({
      ok: false,
      error: { code: "unsupported-field" },
    });
  });

  it("marks an unknown custom type unavailable without blocking ordinary fields", () => {
    const active = snapshot({
      ...localLoginView(),
      fields: [{ name: "Unknown", type: 99, value: "unsupported-secret" }],
    });
    expect(active.list().find((entry) => entry.ref.fieldId === customFieldId(0))?.kind).toBe(
      "unsupported",
    );
    expect(active.resolve(fieldRef(customFieldId(0)), allow(customFieldId(0)))).toEqual({
      ok: false,
      error: { code: "unsupported-field" },
    });
    expect(active.resolve(fieldRef("login.username"), allow("login.username"))).toEqual(
      text("00001234"),
    );
    expect(JSON.stringify(active.list())).not.toContain("unsupported-secret");
  });

  it("rejects an unknown custom ordinal even with the current snapshot ID", () => {
    expect(snapshot().resolve(fieldRef(customFieldId(999)), allow(customFieldId(999)))).toEqual({
      ok: false,
      error: { code: "stale-field-reference" },
    });
  });

  it.each([
    null,
    {},
    { ...fieldRef("login.password"), itemId: "bad" },
    { ...fieldRef("login.password"), fieldId: "login/password" },
    { ...fieldRef("login.password"), extra: "secret" },
  ])("rejects malformed references case %#", (ref) => {
    expect(snapshot().resolve(ref, allow("login.password"))).toEqual({
      ok: false,
      error: { code: "invalid-field-input" },
    });
  });

  it.each([
    null,
    {},
    { allowedFieldIds: "login.password" },
    { allowedFieldIds: [123] },
    { allowedFieldIds: ["login.password"], nowMs: 123 },
  ])("rejects malformed grant case %#", (grant) => {
    expect(snapshot().resolve(fieldRef("login.password"), grant as never)).toEqual({
      ok: false,
      error: { code: "invalid-field-input" },
    });
  });

  it("never exposes a raw OTP seed through a guessed builtin reference", () => {
    const active = snapshot({
      ...localLoginView(),
      login: { username: "synthetic", password: "synthetic", totp: rfcTotpSecrets.SHA1 },
    });
    expect(active.resolve(fieldRef("login.totp"), allow("login.totp"))).toEqual({
      ok: false,
      error: { code: "unsupported-field" },
    });
  });
});

describe("local OTP field resolution", () => {
  it("withholds an OTP result if the snapshot is disposed while sampling time", () => {
    const active = snapshot({
      ...localLoginView(),
      login: { username: "synthetic", password: "synthetic", totp: rfcTotpSecrets.SHA1 },
    });
    expect(
      active.resolve(fieldRef("login.totp-code"), {
        allowedFieldIds: ["login.totp-code"],
        nowMs: () => {
          active.dispose();
          return 59_000;
        },
      }),
    ).toEqual({
      ok: false,
      error: { code: "crypto-locked" },
    });
    expect(active.list()).toEqual([]);
  });

  it("generates a code from the permitted source without exposing the seed in metadata", () => {
    const active = snapshot({
      ...localLoginView(),
      login: {
        username: "synthetic",
        password: "synthetic",
        totp: `otpauth://totp/Synthetic?secret=${rfcTotpSecrets.SHA1}&digits=8`,
      },
    });
    expect(JSON.stringify(active.list())).not.toContain(rfcTotpSecrets.SHA1);
    expect(
      active.resolve(fieldRef("login.totp-code"), {
        allowedFieldIds: ["login.totp-code"],
        nowMs: () => 59_000,
      }),
    ).toEqual({
      ok: true,
      data: { kind: "otp", value: "94287082", period: 30, validUntilMs: 60_000 },
    });
    let clockCalls = 0;
    expect(
      active.resolve(fieldRef("login.totp-code"), {
        allowedFieldIds: [],
        nowMs: () => {
          clockCalls++;
          return 59_000;
        },
      }),
    ).toEqual({ ok: false, error: { code: "field-denied" } });
    expect(clockCalls).toBe(0);
  });
});

describe("real SDK decrypted custom fields to local resolution", () => {
  it("uses strict actual SDK output for text, hidden, checkbox and linked password", async () => {
    const initialized = await createLocalCryptoSession(
      {
        connectionId: fieldConnectionId,
        userId: fieldUserId,
        email: v1Email,
        kdf: v1Kdf,
        accountCryptographicState: { V1: { private_key: v1PrivateKey } },
        unlock: {
          kind: "password",
          password: v1Password,
          masterPasswordUnlock: {
            kdf: v1Kdf,
            masterKeyWrappedUserKey: v1WrappedUserKey,
            salt: v1Email,
          },
        },
      },
      sdk,
    );
    expect(initialized.ok).toBe(true);
    if (!initialized.ok) return;
    try {
      const cipher = {
        ...legacyCipher(),
        fields: [
          {
            name: customFieldCiphertexts.duplicateName,
            value: customFieldCiphertexts.branch,
            type: 0,
            linkedId: null,
          },
          {
            name: customFieldCiphertexts.duplicateName,
            value: customFieldCiphertexts.account,
            type: 1,
            linkedId: null,
          },
          {
            name: customFieldCiphertexts.duplicateName,
            value: customFieldCiphertexts.boolean,
            type: 2,
            linkedId: null,
          },
          { name: customFieldCiphertexts.linkedName, value: null, type: 3, linkedId: 101 },
        ],
      };
      const decrypted = await initialized.data.decryptCipher({
        connectionId: fieldConnectionId,
        cipher,
      });
      expect(decrypted.ok).toBe(true);
      if (!decrypted.ok) return;
      const active = snapshot(decrypted.data);
      const ref = (ordinal: number) => fieldRef(customFieldId(ordinal), cipher.id);
      expect(active.resolve(ref(0), allow(customFieldId(0)))).toEqual(text("007"));
      expect(active.resolve(ref(1), allow(customFieldId(1)))).toEqual(text("00001234"));
      expect(active.resolve(ref(2), allow(customFieldId(2)))).toEqual({
        ok: true,
        data: { kind: "boolean", checked: true },
      });
      expect(active.resolve(ref(3), allow(customFieldId(3), "login.password"))).toEqual(
        text("test_password"),
      );
      active.dispose();
    } finally {
      initialized.data.dispose();
    }
  });
});
