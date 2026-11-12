import { describe, expect, it } from "vitest";
import * as v from "valibot";
import { validSsoResult } from "./sso-result";
import { ssoCandidateInputSchema, ssoSourceInputSchema } from "./sso-wire";
import { commandSchema, type HostOperation, type HostSessionRef } from "./wire";

const itemId = "a0000000-0000-4000-8000-000000000001";
const otherId = "a0000000-0000-4000-8000-000000000002";
const snapshotId = "b0000000-0000-4000-8000-000000000001";
const fieldId = `custom.${snapshotId}.0`;
const session: HostSessionRef = {
  connectionId: "synthetic",
  userId: itemId,
  brokerGeneration: snapshotId,
  sessionId: snapshotId,
  snapshotId,
};
const methodsOperation: Extract<HostOperation, { kind: "sso-methods" }> = {
  kind: "sso-methods",
  session,
  itemId: itemId.toUpperCase(),
  allowedFieldIds: [fieldId],
};
const candidateOperation: Extract<HostOperation, { kind: "sso-candidates" }> = {
  kind: "sso-candidates",
  session,
  usernameProof: "P".repeat(43),
  candidates: [{ itemId: itemId.toUpperCase(), allowedFieldIds: ["login.username"] }],
};
const method = () => ({
  method: { number: 1 },
  fieldId,
  automatic: true,
  form: "bracket",
  label: "Provider",
  usernameProof: "P".repeat(43),
});
const methods = () => ({
  itemId,
  snapshotId,
  sourceEvidence: "E".repeat(43),
  result: { status: "ready", methods: [method()] },
});
const candidates = () => ({
  snapshotId,
  candidates: [{ itemId, origins: ["https://idp.example.test"] }],
});

describe("SSO strict response binding", () => {
  it("accepts only the requested source/snapshot and candidate subset", () => {
    expect(validSsoResult(methodsOperation, methods())).toBe(true);
    expect(validSsoResult(candidateOperation, candidates())).toBe(true);
    expect(validSsoResult(candidateOperation, { snapshotId, candidates: [] })).toBe(true);
    expect(
      validSsoResult(methodsOperation, {
        ...methods(),
        result: { status: "refused", reason: "field-unreadable", field: "SSO" },
      }),
    ).toBe(true);
  });
  it.each([
    { ...methods(), itemId: otherId },
    { ...methods(), snapshotId: otherId },
    { ...methods(), extra: "plaintext" },
    { ...methods(), sourceEvidence: "not-a-digest" },
    { ...methods(), result: { status: "refused", reason: "plaintext secret" } },
    { ...methods(), result: { status: "refused", reason: "invalid-value", value: "plaintext" } },
    {
      ...methods(),
      result: { status: "ready", methods: [{ ...method(), fieldId: "login.password" }] },
    },
    { ...methods(), result: { status: "ready", methods: [{ ...method(), automatic: false }] } },
    {
      ...methods(),
      result: { status: "ready", methods: [{ ...method(), method: { number: 2 } }] },
    },
    {
      ...methods(),
      result: { status: "ready", methods: [{ ...method(), method: { number: 0 } }] },
    },
    {
      ...methods(),
      result: { status: "ready", methods: [{ ...method(), method: { number: 1000001 } }] },
    },
    {
      ...methods(),
      result: { status: "ready", methods: [{ ...method(), method: { number: 1, fieldId } }] },
    },
    {
      ...methods(),
      result: { status: "ready", methods: [{ ...method(), usernameProof: "plaintext" }] },
    },
    {
      ...methods(),
      result: { status: "ready", methods: [{ ...method(), origin: "https://idp.example.test" }] },
    },
    { ...methods(), result: { status: "ready", methods: [{ ...method(), label: undefined }] } },
    { ...methods(), result: { status: "ready", methods: [method(), method()] } },
    {
      ...methods(),
      result: { status: "ready", methods: [{ ...method(), form: "url", label: undefined }] },
    },
    {
      ...methods(),
      result: {
        status: "ready",
        methods: [
          { ...method(), form: "url", label: undefined, origin: "https://idp.example.test/path" },
        ],
      },
    },
  ])("refuses widened, inconsistent or value-bearing source answer case %#", (data) => {
    expect(validSsoResult(methodsOperation, data)).toBe(false);
  });
  it("enforces unique method numbers and snapshot-bound field IDs independently", () => {
    const secondField = `custom.${snapshotId}.1`;
    const operation = { ...methodsOperation, allowedFieldIds: [fieldId, secondField] };
    const variants = [
      [method(), { ...method(), fieldId: secondField }],
      [method(), { ...method(), method: { number: 2 }, automatic: false }],
    ];
    for (const list of variants)
      expect(
        validSsoResult(operation, { ...methods(), result: { status: "ready", methods: list } }),
      ).toBe(false);
    expect(
      validSsoResult(operation, {
        ...methods(),
        result: {
          status: "ready",
          methods: [
            method(),
            { ...method(), fieldId: secondField, method: { number: 2 }, automatic: false },
          ],
        },
      }),
    ).toBe(true);
  });
  it("accepts URL origin only for a single automatic method without a label", () => {
    const url = { ...method(), form: "url", label: undefined, origin: "https://idp.example.test" };
    expect(
      validSsoResult(methodsOperation, {
        ...methods(),
        result: { status: "ready", methods: [url] },
      }),
    ).toBe(true);
    expect(
      validSsoResult(methodsOperation, {
        ...methods(),
        result: { status: "ready", methods: [{ ...url, label: "Provider" }] },
      }),
    ).toBe(false);
    expect(
      validSsoResult(methodsOperation, {
        ...methods(),
        result: { status: "ready", methods: [{ ...url, method: { number: 2 }, automatic: false }] },
      }),
    ).toBe(false);
  });
  it.each([
    { ...candidates(), snapshotId: otherId },
    { ...candidates(), username: "plaintext" },
    { snapshotId, candidates: [{ itemId: otherId, origins: ["https://idp.example.test"] }] },
    { snapshotId, candidates: [{ ...candidates().candidates[0], username: "plaintext" }] },
    { snapshotId, candidates: [candidates().candidates[0], candidates().candidates[0]] },
    {
      snapshotId,
      candidates: [{ itemId, origins: ["https://idp.example.test", "https://idp.example.test"] }],
    },
    { snapshotId, candidates: [{ itemId, origins: ["https://idp.example.test/path"] }] },
    { snapshotId, candidates: [{ itemId, origins: ["https://user:secret@idp.example.test"] }] },
    { snapshotId, candidates: [{ itemId, origins: ["javascript:alert(1)"] }] },
    {
      snapshotId,
      candidates: [{ itemId, origins: ["https://idp.example.test/"], unavailable: "invented" }],
    },
  ])("refuses widened, duplicate or nonorigin candidate answer case %#", (data) => {
    expect(validSsoResult(candidateOperation, data)).toBe(false);
  });
});

describe("SSO request admission", () => {
  it("bounds source/candidate counts and IDs before dispatch", () => {
    expect(v.safeParse(ssoSourceInputSchema, { itemId, allowedFieldIds: [] }).success).toBe(true);
    for (const input of [
      { itemId: "arbitrary", allowedFieldIds: [] },
      { itemId, allowedFieldIds: [""] },
      { itemId, allowedFieldIds: ["x".repeat(129)] },
      { itemId, allowedFieldIds: Array(2001).fill("login.username") },
      { itemId, allowedFieldIds: [], key: "background-key" },
    ])
      expect(v.safeParse(ssoSourceInputSchema, input).success).toBe(false);
    const candidate = { itemId, allowedFieldIds: ["login.username"] };
    expect(
      v.safeParse(ssoCandidateInputSchema, {
        usernameProof: "P".repeat(43),
        candidates: Array(2000).fill(candidate),
      }).success,
    ).toBe(true);
    expect(
      v.safeParse(ssoCandidateInputSchema, {
        usernameProof: "P".repeat(43),
        candidates: Array(2001).fill(candidate),
      }).success,
    ).toBe(false);
    for (const proof of ["", "P".repeat(42), "P".repeat(44), "+".repeat(43)])
      expect(
        v.safeParse(ssoCandidateInputSchema, { usernameProof: proof, candidates: [candidate] })
          .success,
      ).toBe(false);
  });
  it.each([methodsOperation, candidateOperation])(
    "admits commands for $kind and rejects malformed relay key material",
    (operation) => {
      const command = {
        version: 1,
        type: "crypto.command",
        generation: snapshotId,
        requestId: itemId,
        connectionId: session.connectionId,
        operation,
      };
      expect(v.safeParse(commandSchema, command).success).toBe(true);
      expect(
        v.safeParse(commandSchema, { ...command, operation: { ...operation, key: "K".repeat(43) } })
          .success,
      ).toBe(true);
      expect(
        v.safeParse(commandSchema, { ...command, operation: { ...operation, key: "background" } })
          .success,
      ).toBe(false);
    },
  );
});
