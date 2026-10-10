import { describe, expect, it, vi } from "vitest";
import type { VaultConnectionMetadata } from "@pateat/contracts";
import {
  combineFieldSources,
  createVaultFieldSource,
  createVaultUriMatcher,
  dummyFieldSource,
  loginSecretKind,
} from "./vault";

vi.mock("wxt/browser", () => ({ browser: {} }));
const connectionId = "50000000-0000-4000-8000-000000000001";
const snapshotId = "60000000-0000-4000-8000-000000000001";
const userId = "70000000-0000-4000-8000-000000000001";
const itemId = "80000000-0000-4000-8000-000000000001";
const account = { origin: "https://login.example", connectionId, itemId };
function connection(overrides: Partial<VaultConnectionMetadata> = {}): VaultConnectionMetadata {
  return {
    id: connectionId,
    label: "Synthetic vault",
    provider: "bitwarden",
    snapshotId,
    groups: [],
    items: [],
    ...overrides,
  };
}
function harness(
  result: unknown = { ok: true, data: { kind: "text", value: "synthetic" } },
  handle: { userId: string; snapshotId: string } | null = { userId, snapshotId },
) {
  const profile = { connectionId, environment: { kind: "cloud", region: "us" } };
  const connections = {
    registry: { get: vi.fn(async (id: string) => (id === connectionId ? { profile } : undefined)) },
    vaultFor: vi.fn(() => ({ manager: { status: () => ({ ...(handle ? { handle } : {}) }) } })),
    resolveField: vi.fn(async () => result),
  };
  return {
    connections,
    source: createVaultFieldSource(
      connections as unknown as Parameters<typeof createVaultFieldSource>[0],
    ),
  };
}

describe("live vault login field source", () => {
  it("resolves one reference bound to the open snapshot through the connection runtime", async () => {
    const h = harness();
    await expect(
      h.source({ account, connection: connection(), fieldId: "login.password" }),
    ).resolves.toBe("synthetic");
    expect(h.connections.resolveField).toHaveBeenCalledWith(connectionId, {
      connectionId,
      userId,
      itemId,
      snapshotId,
      fieldId: "login.password",
    });
  });
  it("fills a locally generated OTP code", async () => {
    const h = harness({
      ok: true,
      data: { kind: "otp", value: "012345", validUntilMs: 1, period: 30 },
    });
    await expect(
      h.source({ account, connection: connection(), fieldId: "login.totp" }),
    ).resolves.toBe("012345");
  });
  it.each([
    ["a denied field", { ok: false, error: { code: "field-denied" } }],
    ["a Boolean field", { ok: true, data: { kind: "boolean", checked: true } }],
  ])("returns no value for %s", async (_name, result) => {
    const h = harness(result);
    await expect(
      h.source({ account, connection: connection(), fieldId: "custom.x.2" }),
    ).resolves.toBeUndefined();
  });
  it.each([
    ["a locked vault", null],
    ["a different open snapshot", { userId, snapshotId: "60000000-0000-4000-8000-000000000002" }],
  ])("does not resolve against %s", async (_name, handle) => {
    const h = harness(undefined, handle);
    await expect(
      h.source({ account, connection: connection(), fieldId: "login.password" }),
    ).resolves.toBeUndefined();
    expect(h.connections.resolveField).not.toHaveBeenCalled();
  });
  it.each([
    ["another provider", connection({ provider: "dummy" })],
    ["another connection", connection({ id: "50000000-0000-4000-8000-000000000002" })],
    ["a catalog without a snapshot", connection({ snapshotId: undefined })],
  ])("rejects %s before any vault access", async (_name, metadata) => {
    const h = harness();
    await expect(
      h.source({ account, connection: metadata, fieldId: "login.password" }),
    ).resolves.toBeUndefined();
    expect(h.connections.registry.get).not.toHaveBeenCalled();
    expect(h.connections.resolveField).not.toHaveBeenCalled();
  });
  it("dispatches by provider without falling back to another source", async () => {
    const live = vi.fn(async () => "live");
    const fields = combineFieldSources({ bitwarden: live, dummy: dummyFieldSource });
    await expect(
      fields({ account, connection: connection(), fieldId: "login.password" }),
    ).resolves.toBe("live");
    await expect(
      fields({
        account,
        connection: connection({ provider: "dummy" }),
        fieldId: "password",
      }),
    ).resolves.toBe("Pateat-synthetic-only!");
    await expect(
      fields({
        account,
        connection: connection({ provider: "unconfigured" }),
        fieldId: "password",
      }),
    ).resolves.toBeUndefined();
    await expect(
      fields({
        account,
        connection: connection({ provider: "constructor" }),
        fieldId: "password",
      }),
    ).resolves.toBeUndefined();
    expect(live).toHaveBeenCalledTimes(1);
  });
});

describe("live vault URI matcher", () => {
  function matcher(handle: { userId: string; snapshotId: string } | null = { userId, snapshotId }) {
    const profile = { connectionId, environment: { kind: "cloud", region: "us" } };
    const matched = { ok: true, data: { connectionId, snapshotId, candidates: [] } };
    const manager = {
      status: () => ({ ...(handle ? { handle } : {}) }),
      matchUris: vi.fn(async () => matched),
    };
    const connections = {
      registry: {
        get: vi.fn(async (id: string) => (id === connectionId ? { profile } : undefined)),
      },
      vaultFor: vi.fn(() => ({ manager })),
    };
    return {
      manager,
      matched,
      match: createVaultUriMatcher(
        connections as unknown as Parameters<typeof createVaultUriMatcher>[0],
      ),
    };
  }
  it("asks the connection's open snapshot for the page URL", async () => {
    const h = matcher();
    await expect(h.match(connectionId, "https://login.example/signin")).resolves.toBe(h.matched);
    expect(h.manager.matchUris).toHaveBeenCalledWith(
      { userId, snapshotId },
      "https://login.example/signin",
    );
  });
  it("answers unavailable, not no-match, when locked or unconfigured", async () => {
    const locked = matcher(null);
    await expect(locked.match(connectionId, "https://login.example/")).resolves.toEqual({
      ok: false,
      error: { code: "crypto-locked" },
    });
    expect(locked.manager.matchUris).not.toHaveBeenCalled();
    await expect(
      matcher().match("50000000-0000-4000-8000-000000000009", "https://login.example/"),
    ).resolves.toEqual({ ok: false, error: { code: "invalid-request" } });
  });
});

describe("login secret kinds", () => {
  it.each([
    ["bitwarden", "login.password", "password"],
    ["bitwarden", "login.totp-code", "otp"],
    ["bitwarden", "login.username", undefined],
    // Hidden and Linked custom fields stay unclassified for now.
    ["bitwarden", "custom.60000000-0000-4000-8000-000000000001.0", undefined],
    ["dummy", "password", "password"],
    ["dummy", "username", undefined],
    ["dummy", "login.password", undefined],
  ] as const)("classifies %s %s as %s", (provider, fieldId, kind) => {
    expect(loginSecretKind({ provider }, fieldId)).toBe(kind);
  });
});
