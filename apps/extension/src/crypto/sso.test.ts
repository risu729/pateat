import { describe, expect, it, vi } from "vitest";
import {
  describeSsoMethods,
  findSsoCandidates,
  normalizeSsoUsername,
  ssoUriOrigin,
  type SsoWorkerState,
} from "./sso";
import { customFieldsDigest, importDigestKey, withDigestKey } from "./custom-digest";
import type { SsoMethod } from "./sso-wire";
import { toBase64Url } from "../passkeys/encoding";

const itemId = "a0000000-0000-4000-8000-000000000001";
const otherId = "a0000000-0000-4000-8000-000000000002";
const snapshotId = "b0000000-0000-4000-8000-000000000001";
const fieldId = (index: number) => `custom.${snapshotId}.${index}`;
const field = (name = "SSO", value = "[Example] person@example.test", type = 0) => ({
  name,
  value,
  type,
});
const keyOf = async (fill = 1) =>
  (await importDigestKey(toBase64Url(new Uint8Array(32).fill(fill))))!;
function fixture(fields = [field()], login = { username: "Site user", password: "site password" }) {
  const cipher = { encrypted: "synthetic ciphertext" };
  const decrypted = { type: 1, fields, login };
  const decrypt = vi.fn(async () => ({ ok: true as const, data: decrypted }));
  const state: SsoWorkerState = {
    ref: {
      connectionId: "source",
      userId: otherId,
      sessionId: otherId,
      brokerGeneration: otherId,
      snapshotId,
    },
    session: { decryptCipher: decrypt } as unknown as SsoWorkerState["session"],
    ciphers: new Map([[itemId, cipher]]),
    loginUsernames: new Map([[itemId, login.username]]),
    loginUris: new Map([[itemId, [{ uri: "https://idp.example.test/login", match: 0 }]]]),
    unreadableFields: new Map(),
    uriContext: { defaultMatch: 0 },
  };
  const allowedFieldIds = ["login.username", ...fields.map((_, index) => fieldId(index))];
  const inspect = (allowed = allowedFieldIds, key?: CryptoKey) =>
    keyOf().then((fallback) =>
      describeSsoMethods(
        state,
        { itemId: itemId.toUpperCase(), allowedFieldIds: allowed },
        key ?? fallback,
      ),
    );
  return { state, cipher, decrypted, decrypt, describe: inspect, allowedFieldIds };
}
async function firstMethod(h: ReturnType<typeof fixture>, key?: CryptoKey): Promise<SsoMethod> {
  const answer = await h.describe(undefined, key);
  expect(answer.result.status).toBe("ready");
  if (answer.result.status !== "ready" || !answer.result.methods[0])
    throw new Error("Expected method");
  return answer.result.methods[0];
}
async function candidates(h: ReturnType<typeof fixture>, usernameProof: string, key?: CryptoKey) {
  return findSsoCandidates(
    h.state,
    {
      usernameProof,
      candidates: [{ itemId: itemId.toUpperCase(), allowedFieldIds: ["login.username"] }],
    },
    key ?? (await keyOf()),
  );
}

describe("strict local SSO syntax", () => {
  it("normalizes field names and usernames separately while preserving the readable label", async () => {
    const h = fixture([
      field("　ｓｓｏ　", "  [  Custom Provider  ]  PERSON@Example.Test  ", 1),
      field("ＳＳＯ　００２", "[Other] another"),
    ]);
    const answer = await h.describe();
    expect(answer).toMatchObject({
      itemId,
      snapshotId,
      sourceEvidence: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u),
      result: {
        status: "ready",
        methods: [
          {
            method: { number: 1 },
            automatic: true,
            form: "bracket",
            label: "Custom Provider",
            fieldId: fieldId(0),
          },
          {
            method: { number: 2 },
            automatic: false,
            form: "bracket",
            label: "Other",
            fieldId: fieldId(1),
          },
        ],
      },
    });
    expect(normalizeSsoUsername("  ＡLiCe  ")).toBe("ａlice");
    expect(normalizeSsoUsername("Ａlice")).not.toBe(normalizeSsoUsername("Alice"));
    expect(h.decrypt).toHaveBeenCalledOnce();
    expect(h.state).not.toHaveProperty("methods");
    expect(h.state.loginUsernames.get(itemId)).toBe("Site user");
  });
  it("keeps method numbers independent of field order and excludes disabled fields before parsing", async () => {
    const h = fixture([
      field("SSO 9", "[Nine] nine"),
      field("SSO", "[One] one"),
      field("SSO 2", "malformed"),
      field("SSO2", "not reserved"),
    ]);
    expect((await h.describe([fieldId(0), fieldId(1), fieldId(3)])).result).toMatchObject({
      status: "ready",
      methods: [
        { method: { number: 9 }, automatic: false },
        { method: { number: 1 }, automatic: true },
      ],
    });
    expect((await h.describe([])).result).toEqual({ status: "ready", methods: [] });
  });
  it.each(["SSO 0", "SSO 1", "SSO 1000001", "SSO 9007199254740992"])(
    "refuses reserved invalid method number %s",
    async (name) => {
      expect((await fixture([field(name)]).describe()).result).toEqual({
        status: "refused",
        reason: "field-name",
        field: name,
      });
    },
  );
  it.each([
    ["SSO", "sso"],
    ["SSO 2", "ＳＳＯ　０２"],
  ])("refuses duplicate normalized method names %j", async (one, two) => {
    expect((await fixture([field(one), field(two)]).describe()).result).toEqual({
      status: "refused",
      reason: "duplicate-method",
      field: two,
    });
  });
  it.each([2, 3, 99])("does not interpret custom field type %s as an SSO secret", async (type) => {
    expect(
      (await fixture([field("SSO", "[Example] person", type)]).describe()).result,
    ).toMatchObject({ status: "refused", reason: "field-type" });
  });
  it.each([
    "",
    "   ",
    "[] person",
    "[   ] person",
    "[Provider]",
    "[Provider]person",
    "[Provider]   ",
    "[Provider person",
    "[Pro[vider] person",
    "[Provider] per]son",
    "[Provider] per[son",
    "[Provider]\nusername",
    "[Provider]\tusername",
    "[Provider]\rusername",
    "\n[Provider] username",
    "[Provider] username\t",
    "[Provider] user\nname",
    "[Pro\tvider] user",
    "[Provider] user\u0000name",
    "[Provider] user\u0085name",
    "[Provider] user\u2028name",
    "[Provider] user\ud800",
    `[${"x".repeat(129)}] person`,
    `[Provider] ${"u".repeat(1025)}`,
    "x".repeat(4097),
  ])("refuses malformed bracket value case %# without disclosing it", async (value) => {
    const answer = await fixture([field("SSO", value)]).describe();
    expect(answer.result).toEqual({ status: "refused", reason: "invalid-value", field: "SSO" });
    expect(JSON.stringify(answer)).not.toContain("usernameProof");
  });
  it("accepts the exact label/username/method bounds and rejects one extra method", async () => {
    const fields = Array.from({ length: 32 }, (_, index) =>
      field(index ? `SSO ${index + 1}` : "SSO", `[${"L".repeat(128)}] ${"u".repeat(1024)}`),
    );
    const answer = await fixture(fields).describe();
    expect(answer.result.status === "ready" && answer.result.methods).toHaveLength(32);
    expect((await fixture([...fields, field("SSO 1000000")]).describe()).result).toEqual({
      status: "refused",
      reason: "too-many-methods",
    });
    expect((await fixture([field("SSO 1000000")]).describe()).result).toMatchObject({
      status: "ready",
      methods: [{ method: { number: 1000000 }, automatic: false }],
    });
  });
  it("refuses any partly unreadable custom field even when excluded, and never decrypts an absent cipher", async () => {
    const h = fixture();
    h.state.unreadableFields.set(itemId, new Set([fieldId(99)]));
    expect((await h.describe([])).result).toEqual({
      status: "refused",
      reason: "field-unreadable",
    });
    h.state.ciphers.clear();
    h.decrypt.mockClear();
    expect((await h.describe()).result).toEqual({ status: "refused", reason: "item-unavailable" });
    expect(h.decrypt).not.toHaveBeenCalled();
  });
  it("refuses failed decryption, deleted items and non-login items", async () => {
    for (const data of [{ type: 2 }, { ...fixture().decrypted, deletedDate: "2026-11-12" }]) {
      const h = fixture();
      h.decrypt.mockResolvedValueOnce({ ok: true, data } as never);
      // oxlint-disable-next-line no-await-in-loop -- exercise bounded synthetic cases in a deterministic order
      expect((await h.describe()).result).toEqual({
        status: "refused",
        reason: "item-unavailable",
      });
    }
    const h = fixture();
    h.decrypt.mockResolvedValueOnce({ ok: false, error: { code: "crypto-failed" } } as never);
    expect((await h.describe()).result).toEqual({ status: "refused", reason: "item-unavailable" });
  });
});

describe("URL form and concrete origins", () => {
  it.each([
    ["https://Example.test:443/path?q=1#fragment", "https://example.test"],
    ["http://example.test:8080/login", "http://example.test:8080"],
    ["HTTPS://example.test", "https://example.test"],
    ["https://[::1]:8443/login", "https://[::1]:8443"],
  ])("reduces %s to its own origin", async (value, origin) => {
    expect(ssoUriOrigin(value)).toBe(origin);
    const method = await firstMethod(
      fixture([field("SSO", ` ${value} `)], { username: " Person ", password: "" }),
    );
    expect(method).toMatchObject({ form: "url", origin, automatic: true });
    expect(method).not.toHaveProperty("label");
  });
  it.each([
    "example.test",
    "//example.test",
    "javascript:alert(1)",
    "ftp://example.test",
    "https://user:secret@example.test",
    "https://user@example.test",
    "https://example.test\\evil",
    "https://example.test/a b",
    "https://example.test/\nfoo",
    "https://example.test/\u0000foo",
    "https://example.test/\ud800",
    "https://",
  ])("rejects nonconcrete or ambiguous origin %j", (value) => {
    expect(ssoUriOrigin(value)).toBeUndefined();
  });
  it("refuses a password-bearing URL source and URL alternatives/mixed forms", async () => {
    expect(
      (await fixture([field("SSO", "https://idp.example.test")]).describe()).result,
    ).toMatchObject({ status: "refused", reason: "url-needs-empty-password" });
    for (const fields of [
      [field("SSO 2", "https://idp.example.test")],
      [field("SSO", "https://idp.example.test"), field("SSO 2")],
      [field(), field("SSO 2", "https://idp.example.test")],
    ]) {
      expect(
        // oxlint-disable-next-line no-await-in-loop -- exercise bounded synthetic cases in a deterministic order
        (await fixture(fields, { username: "person", password: "" }).describe()).result.status,
      ).toBe("refused");
    }
  });
  it("requires an allowed, readable, bounded native username and readable empty password", async () => {
    const h = fixture([field("SSO", "https://idp.example.test")], {
      username: "person",
      password: "",
    });
    expect((await h.describe([fieldId(0)])).result).toMatchObject({
      status: "refused",
      reason: "username-missing",
    });
    for (const id of ["login.username", "login.password"]) {
      h.state.unreadableFields.set(itemId, new Set([id]));
      // oxlint-disable-next-line no-await-in-loop -- exercise bounded synthetic cases in a deterministic order
      expect((await h.describe()).result).toMatchObject({
        status: "refused",
        reason: "field-unreadable",
      });
    }
    for (const username of ["", " ", "a".repeat(1025), "person\u0000", "person\ud800"]) {
      // oxlint-disable-next-line no-await-in-loop -- exercise bounded synthetic cases in a deterministic order
      const answer = await fixture([field("SSO", "https://idp.example.test")], {
        username,
        password: "",
      }).describe();
      expect(answer.result).toMatchObject({ status: "refused", reason: "username-missing" });
    }
  });
});

describe("transient proofs and native IdP candidate confirmation", () => {
  it("compares exact normalized usernames across connections under one relay key, not labels/site usernames", async () => {
    const source = fixture([field("SSO", "[Unrelated Label]  PERSON@EXAMPLE.TEST")]);
    const proof = (await firstMethod(source)).usernameProof;
    const target = fixture([], { username: " person@example.test ", password: "native" });
    target.state.ref.connectionId = "different-connection";
    expect(await candidates(target, proof)).toEqual({
      snapshotId,
      candidates: [{ itemId, origins: ["https://idp.example.test"] }],
    });
    expect(target.decrypt).toHaveBeenCalledOnce();
    expect(await candidates(target, proof, await keyOf(2))).toEqual({ snapshotId, candidates: [] });
    expect((await firstMethod(source, await keyOf(2))).usernameProof).not.toBe(proof);
    expect(proof).not.toContain("PERSON");
    expect(proof).not.toBe(await customFieldsDigest([field()], await keyOf()));
    for (const username of [
      "Site user",
      "person@example.test.evil",
      "PERSON＠EXAMPLE.TEST",
      "other@example.test",
    ]) {
      const unrelated = fixture([], { username, password: "native" });
      // oxlint-disable-next-line no-await-in-loop -- exercise bounded synthetic cases in a deterministic order
      expect(await candidates(unrelated, proof)).toEqual({ snapshotId, candidates: [] });
      expect(unrelated.decrypt).not.toHaveBeenCalled();
    }
  });
  it("never identifies a long full username through a truncated matching display cache", async () => {
    const username = "u".repeat(1024);
    const proof = (await firstMethod(fixture([field("SSO", `[Provider] ${username}`)])))
      .usernameProof;
    const target = fixture([], { username: `${username}different-account`, password: "native" });
    target.state.loginUsernames.set(itemId, username);
    expect(await candidates(target, proof)).toEqual({
      snapshotId,
      candidates: [{ itemId, origins: [], unavailable: "username-missing" }],
    });
    expect(target.decrypt).toHaveBeenCalledOnce();
    target.decrypted.login.username = "somebody-else";
    expect(await candidates(target, proof)).toEqual({ snapshotId, candidates: [] });
  });
  it("reads fresh methods/evidence every call and retains no custom decrypted values", async () => {
    const h = fixture();
    const original = await h.describe();
    h.decrypted.fields[0]!.value = "[Changed] another-person";
    const changedMethod = await h.describe();
    expect(changedMethod.result).not.toEqual(original.result);
    h.state.ciphers.set(itemId, { encrypted: "changed ciphertext" });
    expect((await h.describe()).sourceEvidence).not.toBe(original.sourceEvidence);
    expect(h.decrypt).toHaveBeenCalledTimes(3);
    expect(h.state.ciphers.get(itemId)).toEqual({ encrypted: "changed ciphertext" });
  });
  it("collects every concrete own URI, deduplicates and sorts, and never uses a label as a domain", async () => {
    const proof = (await firstMethod(fixture())).usernameProof;
    const target = fixture([], { username: "person@example.test", password: "native" });
    target.state.loginUris.set(itemId, [
      { uri: "https://z.example.test/path", match: 2 },
      { uri: "http://a.example.test/path", match: 3 },
      { uri: "https://z.example.test/other", match: 1 },
      { uri: "https://ignored.example.test", match: 5 },
      { uri: "https://default.example.test", match: null },
    ]);
    expect((await candidates(target, proof)).candidates).toEqual([
      {
        itemId,
        origins: [
          "http://a.example.test",
          "https://default.example.test",
          "https://z.example.test",
        ],
      },
    ]);
  });
  it.each([
    [{ uri: "https://regex.example.test", match: 4 }],
    [{ uri: "https://idp.example.test", match: 6 }],
    [{ uri: "https://idp.example.test", match: -1 }],
    [{ uri: null, match: 0 }],
    [{ uri: "bare-host.example", match: 1 }],
  ])("reports unevaluable URI rules case %# instead of treating them as no match", async (rule) => {
    const proof = (await firstMethod(fixture())).usernameProof;
    const target = fixture([], { username: "person@example.test", password: "native" });
    target.state.loginUris.set(itemId, [rule]);
    expect((await candidates(target, proof)).candidates).toEqual([
      { itemId, origins: [], unavailable: "uri-unavailable" },
    ]);
  });
  it("reports missing/default-unavailable/oversized URI sets, while Never contributes no origin", async () => {
    const proof = (await firstMethod(fixture())).usernameProof;
    const target = fixture([], { username: "person@example.test", password: "native" });
    target.state.loginUris.delete(itemId);
    expect((await candidates(target, proof)).candidates[0]?.unavailable).toBe("uri-unavailable");
    target.state.loginUris.set(itemId, [{ uri: "https://idp.example.test", match: null }]);
    target.state.uriContext = { defaultMatch: "unavailable" };
    expect((await candidates(target, proof)).candidates[0]?.unavailable).toBe("uri-unavailable");
    target.state.loginUris.set(
      itemId,
      Array.from({ length: 1001 }, () => ({ uri: "https://idp.example.test", match: 0 })),
    );
    expect((await candidates(target, proof)).candidates[0]?.unavailable).toBe("uri-unavailable");
    target.state.loginUris.set(itemId, [{ uri: "not a URI", match: 5 }]);
    expect((await candidates(target, proof)).candidates).toEqual([{ itemId, origins: [] }]);
  });
  it("does not decrypt excluded usernames and explicitly reports missing/unreadable items", async () => {
    const proof = (await firstMethod(fixture())).usernameProof;
    const h = fixture([], { username: "person@example.test", password: "native" });
    expect(
      await findSsoCandidates(
        h.state,
        { usernameProof: proof, candidates: [{ itemId, allowedFieldIds: [] }] },
        await keyOf(),
      ),
    ).toEqual({ snapshotId, candidates: [] });
    expect(h.decrypt).not.toHaveBeenCalled();
    h.state.unreadableFields.set(itemId, new Set(["login.username"]));
    expect((await candidates(h, proof)).candidates).toEqual([
      { itemId, origins: [], unavailable: "item-unavailable" },
    ]);
    h.state.unreadableFields.clear();
    h.state.ciphers.clear();
    expect((await candidates(h, proof)).candidates).toEqual([
      { itemId, origins: [], unavailable: "item-unavailable" },
    ]);
  });
  it.each(["sso-methods", "sso-candidates"])(
    "replaces a background-supplied key for %s",
    (kind) => {
      const command = { operation: { kind, key: "untrusted", itemId } };
      expect(withDigestKey(command, "offscreen-private")).toEqual({
        operation: { kind, key: "offscreen-private", itemId },
      });
      expect(command.operation.key).toBe("untrusted");
    },
  );
});

describe("SSO archived-item defense", () => {
  it("refuses an archived source even when called with explicit allowed custom fields", async () => {
    const h = fixture();
    Object.assign(h.decrypted, { archivedDate: "2026-11-12T00:00:00Z" });
    expect((await h.describe()).result).toEqual({ status: "refused", reason: "item-unavailable" });
  });
  it("refuses a freshly archived target despite a stale username shortlist", async () => {
    const proof = (await firstMethod(fixture())).usernameProof;
    const h = fixture([], { username: "person@example.test", password: "native" });
    Object.assign(h.decrypted, { archivedDate: "2026-11-12T00:00:00Z" });
    expect((await candidates(h, proof)).candidates).toEqual([
      { itemId, origins: [], unavailable: "item-unavailable" },
    ]);
    expect(h.decrypt).toHaveBeenCalledOnce();
  });
});
