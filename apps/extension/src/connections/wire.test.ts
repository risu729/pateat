import * as v from "valibot";
import { describe, expect, it } from "vitest";
import { parseSetupReply, setupBeginSchema, setupRequestSchema } from "./wire";

function begin(email: string) {
  return {
    kind: "new",
    environment: { kind: "cloud", region: "us" },
    label: "Synthetic vault",
    email,
    password: "synthetic-password",
    enabled: true,
  };
}
describe("setup begin email", () => {
  it.each(["o'brien@example.test", "tom&jerry@example.test", "name@example.x"])(
    "accepts %s, which the official Bitwarden login accepts",
    (email) => {
      expect(v.is(setupBeginSchema, begin(email))).toBe(true);
    },
  );
  it.each(["first..last@example.test", "名前@example.test", " user@example.test"])(
    "refuses %j, which Angular's Validators.email refuses",
    (email) => {
      expect(v.is(setupBeginSchema, begin(email))).toBe(false);
    },
  );
});

describe("vault lock and unlock requests (ADR 0075)", () => {
  const requestId = "60000000-0000-4000-8000-000000000001";
  it("accepts a lock of one connection", () => {
    expect(
      v.is(setupRequestSchema, { requestId, type: "connection.lock", connectionId: "synthetic" }),
    ).toBe(true);
  });
  it("accepts an unlock with its connection and master password", () => {
    const request = {
      requestId,
      type: "connection.unlock",
      input: { connectionId: "synthetic", password: "synthetic-password" },
    };
    expect(v.parse(setupRequestSchema, request)).toEqual(request);
  });
  it.each([
    { requestId, type: "connection.lock" },
    { requestId, type: "connection.lock", connectionId: "" },
    { requestId, type: "connection.lock", connectionId: "synthetic", password: "extra" },
    { requestId: "not-a-uuid", type: "connection.lock", connectionId: "synthetic" },
    { requestId, type: "connection.unlock", input: { connectionId: "synthetic", password: "" } },
    { requestId, type: "connection.unlock", input: { connectionId: "synthetic" } },
    { requestId, type: "connection.unlock", input: { password: "synthetic-password" } },
    { requestId, type: "connection.unlock", connectionId: "synthetic", password: "p" },
    {
      requestId,
      type: "connection.unlock",
      input: { connectionId: "synthetic", password: "synthetic-password", autoUnlock: "enable" },
    },
    {
      requestId,
      type: "connection.unlock",
      input: { connectionId: "x".repeat(201), password: "synthetic-password" },
    },
  ])("refuses the malformed request %j", (request) => {
    expect(v.is(setupRequestSchema, request)).toBe(false);
  });
  it("a sign-in again no longer carries an automatic-unlock choice", () => {
    const existing = { kind: "existing", connectionId: "synthetic", password: "p" };
    expect(v.is(setupBeginSchema, existing)).toBe(true);
    expect(v.is(setupBeginSchema, { ...existing, autoUnlock: "preserve" })).toBe(false);
  });
});

describe("vault lock and unlock replies (ADR 0075)", () => {
  const connection = {
    connectionId: "synthetic",
    label: "Synthetic vault",
    email: "test@example.test",
    environment: { kind: "cloud", region: "us" },
    autoUnlock: "disabled",
    state: "locked",
    providerSession: "active",
  } as const;
  it.each(["locked", "unlocked"] as const)("parses the %s reply", (kind) => {
    const reply = { ok: true, kind, connectionId: "synthetic" } as const;
    expect(parseSetupReply(reply)).toEqual(reply);
  });
  it("parses a locked connection in the status", () => {
    const reply = { ok: true, kind: "status", connections: [connection] } as const;
    expect(parseSetupReply(reply)).toEqual(reply);
  });
  it.each([
    { ok: true, kind: "locked" },
    { ok: true, kind: "unlocked", connectionId: "" },
    { ok: true, kind: "unlocked", connectionId: "synthetic", handle: {} },
    { ok: true, kind: "status", connections: [{ ...connection, state: "logged-out" }] },
  ])("refuses the malformed reply %j", (reply) => {
    expect(() => parseSetupReply(reply)).toThrow();
  });
});
