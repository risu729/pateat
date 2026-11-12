import { describe, expect, it } from "vitest";
import * as v from "valibot";
import {
  ssoAuthorizeSchema,
  ssoCommandSchema,
  ssoIdpResultSchema,
  ssoInspectResultSchema,
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
