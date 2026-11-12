import { describe, expect, it } from "vitest";
import * as v from "valibot";
import { commandSchema } from "./wire";
import {
  ssoAuthorizeSchema,
  ssoCommandSchema,
  ssoIdpResultSchema,
  ssoInspectResultSchema,
  ssoReturnResultSchema,
} from "./sso-operation-wire";

const target = { by: "id", value: "provider-entry" };
const base = { version: 1, token: "document-token" };
const operation = { flowId: "flow", operationId: "operation" };
const accepted = (schema: v.GenericSchema, input: unknown) => v.safeParse(schema, input).success;

describe("SSO document operation messages", () => {
  const commands = [
    { ...base, type: "login.sso.inspect", target },
    { ...base, type: "login.sso.prepare", ...operation, target },
    { ...base, type: "login.sso.commit", ...operation, handle: "prepared-handle" },
    { ...base, type: "login.sso.idp", username: "Synthetic.Account@example.test" },
  ];
  it.each(commands)("accepts the finite $type command", (command) => {
    expect(accepted(ssoCommandSchema, command)).toBe(true);
  });
  it.each(["password", "usernameProof", "sourceEvidence", "account", "origin", "destinations"])(
    "rejects an extra %s on a commit rather than transporting authority",
    (field) => {
      expect(accepted(ssoCommandSchema, { ...commands[2], [field]: "synthetic-secret" })).toBe(
        false,
      );
    },
  );
  it("accepts usernames only in the local IdP-reading command", () => {
    for (const command of commands.slice(0, 3))
      expect(accepted(ssoCommandSchema, { ...command, username: "person@example.test" })).toBe(
        false,
      );
    expect(accepted(ssoCommandSchema, { ...commands[3], username: "" })).toBe(false);
    expect(accepted(ssoCommandSchema, { ...commands[3], username: "x".repeat(1025) })).toBe(false);
  });
  it.each(["token", "flowId", "operationId", "handle"])("requires bounded nonempty %s", (field) => {
    for (const value of ["", "x".repeat(129), null, 7]) {
      expect(accepted(ssoCommandSchema, { ...commands[2], [field]: value })).toBe(false);
      expect(
        accepted(ssoAuthorizeSchema, {
          ...base,
          type: "login.sso.authorize",
          phase: "pointer",
          ...operation,
          handle: "prepared-handle",
          [field]: value,
        }),
      ).toBe(false);
    }
  });
  it("binds authorization to one opaque prepared operation and rejects document spoofing", () => {
    const authorize = {
      ...base,
      type: "login.sso.authorize",
      phase: "pointer",
      ...operation,
      handle: "prepared-handle",
    };
    expect(accepted(ssoAuthorizeSchema, authorize)).toBe(true);
    for (const field of ["document", "tabId", "frameId", "url", "target", "username"])
      expect(accepted(ssoAuthorizeSchema, { ...authorize, [field]: "page-supplied" })).toBe(false);
    expect(accepted(ssoCommandSchema, authorize)).toBe(false);
  });
  it("rejects unrecognized versions and command families", () => {
    for (const type of [
      "login.sso.authorize",
      "login.sso.click",
      "login.sso.navigate",
      "login.execute",
    ])
      expect(accepted(ssoCommandSchema, { ...commands[0], type })).toBe(false);
    expect(accepted(ssoCommandSchema, { ...commands[0], version: 2 })).toBe(false);
  });
});

describe("SSO operation results", () => {
  it("keeps inspection and preparation replies value-free and bounded", () => {
    const result = {
      ok: true,
      url: "https://rp.example.test/signin",
      destinations: ["https://idp.example.test/"],
    };
    expect(accepted(ssoInspectResultSchema, result)).toBe(true);
    expect(accepted(ssoInspectResultSchema, { ...result, handle: "prepared-handle" })).toBe(true);
    expect(
      accepted(ssoInspectResultSchema, { ...result, destinations: Array(9).fill(result.url) }),
    ).toBe(false);
    expect(accepted(ssoInspectResultSchema, { ...result, username: "person@example.test" })).toBe(
      false,
    );
    expect(accepted(ssoInspectResultSchema, { ok: false, reason: "target-changed" })).toBe(true);
    expect(
      accepted(ssoInspectResultSchema, { ok: false, reason: "target-changed", url: result.url }),
    ).toBe(false);
  });
  it("accepts only finite native and intermediate IdP results", () => {
    for (const kind of ["account", "continue", "stay-signed-in"])
      expect(accepted(ssoIdpResultSchema, { kind, target })).toBe(true);
    for (const kind of ["native", "unknown"])
      expect(accepted(ssoIdpResultSchema, { kind })).toBe(true);
    expect(accepted(ssoIdpResultSchema, { kind: "unsafe", reason: "consent" })).toBe(true);
    for (const kind of ["consent", "sign-up", "sharing", "nested-sso", "fedcm", "success"])
      expect(accepted(ssoIdpResultSchema, { kind, target })).toBe(false);
  });
  it("does not let a result carry credentials, an account choice, or RP authentication proof", () => {
    for (const field of ["username", "password", "account", "proof", "authenticated", "origin"])
      expect(accepted(ssoIdpResultSchema, { kind: "native", [field]: "synthetic" })).toBe(false);
    expect(accepted(ssoIdpResultSchema, { kind: "native", target })).toBe(false);
    expect(accepted(ssoIdpResultSchema, { kind: "account" })).toBe(false);
  });
});

describe("RP return identity messages", () => {
  it("accepts only a document-bound local return read and an optional bounded username", () => {
    const request = { ...base, type: "login.sso.return" };
    expect(accepted(ssoCommandSchema, request)).toBe(true);
    expect(accepted(ssoCommandSchema, { ...request, username: "synthetic@example.test" })).toBe(
      true,
    );
    for (const username of ["", "x".repeat(1025), null])
      expect(accepted(ssoCommandSchema, { ...request, username })).toBe(false);
    for (const field of ["account", "origin", "target", "password", "proof", "authenticated"])
      expect(accepted(ssoCommandSchema, { ...request, [field]: "page-supplied" })).toBe(false);
  });
  it("returns only finite local identity evidence and never account values or authentication proof", () => {
    for (const identity of ["match", "different", "absent"])
      expect(accepted(ssoReturnResultSchema, { ok: true, identity })).toBe(true);
    expect(accepted(ssoReturnResultSchema, { ok: false, reason: "unsafe-return" })).toBe(true);
    for (const identity of ["authenticated", "masked-match", "partial-match", "unknown"])
      expect(accepted(ssoReturnResultSchema, { ok: true, identity })).toBe(false);
    for (const field of ["username", "account", "proof", "authenticated", "url"])
      expect(
        accepted(ssoReturnResultSchema, { ok: true, identity: "match", [field]: "private" }),
      ).toBe(false);
  });
});

it("requires an explicit finite authorization phase without changing the prepared commit command", () => {
  const request = { ...base, type: "login.sso.authorize", ...operation, handle: "prepared-handle" };
  expect(accepted(ssoAuthorizeSchema, request)).toBe(false);
  for (const phase of ["pointer", "click"])
    expect(accepted(ssoAuthorizeSchema, { ...request, phase })).toBe(true);
  for (const phase of ["prepare", "spent", "", null])
    expect(accepted(ssoAuthorizeSchema, { ...request, phase })).toBe(false);
  expect(
    accepted(ssoCommandSchema, {
      ...base,
      type: "login.sso.commit",
      ...operation,
      handle: "prepared-handle",
      phase: "click",
    }),
  ).toBe(false);
});

describe("ephemeral selected IdP expectation on preparation only", () => {
  const prepare = { ...base, type: "login.sso.prepare", ...operation, target };
  const idp = { username: "Synthetic.Exact@example.test", kind: "continue" };
  it.each(["account", "continue", "stay-signed-in"])(
    "accepts the exact local %s identity expectation",
    (kind) => {
      expect(accepted(ssoCommandSchema, { ...prepare, idp: { ...idp, kind } })).toBe(true);
    },
  );
  it.each([
    { ...idp, username: "" },
    { ...idp, username: "x".repeat(1025) },
    { ...idp, username: null },
    { username: idp.username },
    { kind: "continue" },
    { ...idp, kind: "native" },
    { ...idp, kind: "unsafe" },
    { ...idp, origin: "https://forged.example.test" },
    { ...idp, account: "forged" },
    { ...idp, password: "secret" },
    { ...idp, target },
    null,
  ])("rejects malformed or authority-bearing expectation %#", (expectation) => {
    expect(accepted(ssoCommandSchema, { ...prepare, idp: expectation })).toBe(false);
  });
  it("does not permit a prepared expectation on commits, inspection, return, or authorization", () => {
    for (const command of [
      { ...base, type: "login.sso.commit", ...operation, handle: "handle" },
      { ...base, type: "login.sso.inspect", target },
      { ...base, type: "login.sso.return" },
      { ...base, type: "login.sso.idp", username: idp.username },
    ])
      expect(accepted(ssoCommandSchema, { ...command, idp })).toBe(false);
    expect(
      accepted(ssoAuthorizeSchema, {
        ...base,
        type: "login.sso.authorize",
        ...operation,
        handle: "handle",
        phase: "pointer",
        idp,
      }),
    ).toBe(false);
  });
});

it("binds the narrow native cancellation to a bounded exact attempt and document token", () => {
  const cancel = { ...base, type: "login.native.cancel", attemptId: "old-native" };
  expect(accepted(commandSchema, cancel)).toBe(true);
  for (const field of ["token", "attemptId"])
    for (const value of ["", "x".repeat(129), null, 1])
      expect(accepted(commandSchema, { ...cancel, [field]: value })).toBe(false);
  for (const field of ["origin", "document", "tabId", "target", "username", "all"])
    expect(accepted(commandSchema, { ...cancel, [field]: true })).toBe(false);
});
