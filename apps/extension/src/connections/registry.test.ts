import { describe, expect, it, vi } from "vitest";
import { createConnectionRegistry, admitConnectionConfigurations } from "./registry";
import type { BitwardenConnectionConfiguration } from "./types";

vi.mock("wxt/browser", () => ({ browser: {} }));
function configuration(
  id = "50000000-0000-4000-8000-000000000001",
): BitwardenConnectionConfiguration {
  return {
    profile: { connectionId: id, environment: { kind: "cloud", region: "us" } },
    label: "Synthetic vault",
    email: "synthetic@example.test",
    deviceIdentifier: crypto.randomUUID(),
  };
}
function harness(initial: unknown = undefined) {
  let stored = structuredClone(initial);
  const storage = {
    read: vi.fn(async () => structuredClone(stored)),
    write: vi.fn(async (input: unknown) => {
      stored = structuredClone(input);
    }),
  };
  return {
    storage,
    registry: createConnectionRegistry(storage),
    stored: () => structuredClone(stored),
  };
}
describe("value-free immutable connection registry", () => {
  it("serializes independent additions without losing either connection and returns detached metadata", async () => {
    const h = harness();
    const a = configuration();
    const b = configuration("50000000-0000-4000-8000-000000000002");
    b.profile = { ...b.profile, environment: { kind: "cloud", region: "eu" } };
    await Promise.all([h.registry.put(a), h.registry.put(b)]);
    const entries = await h.registry.list();
    expect(entries).toEqual([a, b]);
    entries[0]!.label = "Modified detached metadata";
    expect((await h.registry.list())[0]!.label).toBe(a.label);
  });
  it.each(["provider", "email", "device"] as const)(
    "cannot retarget a configured ID by changing %s",
    async (part) => {
      const a = configuration();
      const h = harness([a]);
      const changed = structuredClone(a);
      if (part === "provider")
        changed.profile = {
          ...changed.profile,
          environment: { kind: "self-hosted", baseUrl: "https://vault.example" },
        };
      if (part === "email") changed.email = "other@example.test";
      if (part === "device") changed.deviceIdentifier = crypto.randomUUID();
      await expect(h.registry.put(changed)).rejects.toThrow("immutable-configuration");
      expect(h.stored()).toEqual([a]);
      expect(h.storage.write).not.toHaveBeenCalled();
    },
  );
  it("captures input before awaiting storage so caller mutation cannot retarget its provider", async () => {
    const h = harness();
    const input = configuration();
    const original = structuredClone(input);
    const pending = h.registry.put(input);
    Reflect.set(input.profile, "environment", {
      kind: "self-hosted",
      baseUrl: "https://changed.example",
    });
    input.email = "changed@example.test";
    await pending;
    expect(h.stored()).toEqual([original]);
  });
  it.each(["password", "accessToken", "masterPasswordHash"])(
    "rejects unexpected %s instead of persisting a credential alongside metadata",
    (secret) => {
      expect(() =>
        admitConnectionConfigurations([{ ...configuration(), [secret]: "synthetic-secret" }]),
      ).toThrow();
    },
  );
  it("does not replace corrupt durable metadata with a bootstrap registry", async () => {
    const h = harness([{ ...configuration(), password: "synthetic-secret" }]);
    await expect(
      h.registry.put(configuration("50000000-0000-4000-8000-000000000002")),
    ).rejects.toThrow();
    expect(h.storage.write).not.toHaveBeenCalled();
    expect(h.stored()).toHaveLength(1);
  });
});
