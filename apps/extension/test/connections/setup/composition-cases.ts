import { expect, it } from "vitest";
import type { SetupBegin } from "../../../src/connections/types";
import { accountProfile } from "../../../../../packages/bitwarden/src/__fixtures__/account";
import { rawCustomAccount } from "../../../../../packages/bitwarden/src/__fixtures__/connection";
import { v1Email, v1Password } from "../../../../../packages/bitwarden/src/__fixtures__/crypto";
import type { SetupTestContext } from "./context";

export function registerCompositionCases({
  authenticationHash,
  newInput,
  harness,
  noSecrets,
}: Pick<SetupTestContext, "authenticationHash" | "newInput" | "harness" | "noSecrets">) {
  it("checks permission before prelogin and publishes only metadata after durable native acceptance", async () => {
    const h = harness();
    const result = await h.caller.begin(newInput());
    expect(result).toMatchObject({ ok: true, kind: "ready", policyReviewItemIds: [] });
    expect(h.events.indexOf("permission")).toBeLessThan(h.events.indexOf("prelogin"));
    expect(
      h.events.filter((event) =>
        ["prelogin", "derive", "token", "sync", "accept", "policy"].includes(event),
      ),
    ).toEqual(["prelogin", "derive", "token", "sync", "accept", "policy"]);
    expect(h.fetch).toHaveBeenCalledTimes(3);
    const token = h.fetch.mock.calls.find(([url]) => url.endsWith("/token"))!;
    const form = new URLSearchParams(String(token[1].body));
    expect(form.get("password")).toBe(authenticationHash);
    expect(form.get("username")).toBe(v1Email);
    expect(token[0]).toBe("https://identity.bitwarden.com/connect/token");
    expect(h.fetch.mock.calls.find(([url]) => url.endsWith("/sync"))?.[0]).toBe(
      "https://api.bitwarden.com/sync",
    );
    noSecrets(result);
    noSecrets([...h.configurations.values()]);
    expect(h.policy.adopt.mock.calls[0]?.[0].catalog.items[0]?.allowedOrigins).toEqual([]);
  });
  it.each([
    { label: "the replaced snapshot", replaced: true, adopted: true },
    { label: "another snapshot", replaced: false, adopted: false },
  ])(
    "adopts with the items found unchanged against $label only when it is the one replaced",
    async ({ replaced, adopted }) => {
      const h = harness({ existing: true });
      const begun = await h.caller.begin({
        kind: "existing",
        connectionId: accountProfile.connectionId,
        password: v1Password,
      });
      expect(begun.ok).toBe(true);
      h.manager.accept.mockClear();
      h.policy.adopt.mockClear();
      const itemId = rawCustomAccount().sync.ciphers[0]!.id;
      const previous = h.durable()!.accepted!.snapshotId;
      h.policy.protectedItems.mockResolvedValue([itemId]);
      const commit = h.manager.accept.getMockImplementation()!;
      h.manager.accept.mockImplementationOnce(async (input, signal) => {
        const result = await commit(input, signal);
        return result.ok
          ? {
              ...result,
              data: {
                ...result.data,
                sameCustomFields: [itemId],
                comparedSnapshotId: replaced ? previous : crypto.randomUUID(),
              },
            }
          : result;
      });
      expect((await h.caller.sync(accountProfile.connectionId)).ok).toBe(true);
      expect(h.policy.protectedItems).toHaveBeenCalledWith(accountProfile.connectionId);
      expect(h.manager.accept.mock.calls[0]?.[0].compareCustomFields).toEqual([itemId]);
      expect(h.policy.adopt.mock.calls[0]?.[0].sameCustomFields).toEqual(adopted ? [itemId] : []);
    },
  );
  it("still syncs, comparing nothing, when the protected items cannot be read", async () => {
    const h = harness();
    h.policy.protectedItems.mockRejectedValue(new Error("Synthetic settings unavailable"));
    expect(await h.caller.begin(newInput())).toMatchObject({ ok: true, kind: "ready" });
    expect(h.manager.accept.mock.calls[0]?.[0].compareCustomFields).toEqual([]);
    expect(h.policy.adopt.mock.calls[0]?.[0].sameCustomFields).toEqual([]);
  });
  it("completes setup when password prelogin answers only the flat KDF fields", async () => {
    // Bitwarden Cloud US (2026.9.2) answered /accounts/prelogin/password in this shape.
    const prelogin = { kdf: 0, kdfIterations: 600_000, kdfMemory: null, kdfParallelism: null };
    const h = harness({ prelogin });
    const result = await h.caller.begin(newInput());
    expect(result).toMatchObject({ ok: true, kind: "ready" });
    expect(h.fetch.mock.calls[0]?.[0]).toBe(
      "https://identity.bitwarden.com/accounts/prelogin/password",
    );
    expect(h.host.deriveAuthentication).toHaveBeenCalledWith(
      expect.objectContaining({ prelogin: { mode: "password", response: prelogin } }),
      expect.any(AbortSignal),
    );
  });
  it("a missing provider permission performs no HTTP or expensive crypto", async () => {
    const h = harness();
    h.permission(false);
    expect(await h.caller.begin(newInput())).toEqual({
      ok: false,
      error: { code: "provider-permission-required" },
    });
    expect(h.fetch).not.toHaveBeenCalled();
    expect(h.host.deriveAuthentication).not.toHaveBeenCalled();
    expect(h.manager.accept).not.toHaveBeenCalled();
  });
  // packages/bitwarden's transport tests prove which roots are inadmissible.
  it("rejects an invalid configured root before permission or HTTP", async () => {
    const h = harness();
    const environment = { kind: "self-hosted", baseUrl: "http://vault.example" } as const;
    expect((await h.caller.begin({ ...newInput(), environment })).ok).toBe(false);
    expect(h.permissions.contains).not.toHaveBeenCalled();
    expect(h.fetch).not.toHaveBeenCalled();
  });
  it("uses the persisted provider/email for existing connections and rejects retargeting payload extras", async () => {
    const h = harness({ existing: true });
    const result = await h.caller.begin({
      kind: "existing",
      connectionId: accountProfile.connectionId,
      password: v1Password,
    });
    expect(result.ok).toBe(true);
    expect(h.permissions.contains.mock.calls[0]?.[0]).toEqual(accountProfile);
    expect(h.host.deriveAuthentication.mock.calls[0]?.[0]).toMatchObject({ email: v1Email });
    expect(h.manager.accept.mock.calls[0]?.[0].autoUnlock).toBe("enable");
    const count = h.fetch.mock.calls.length;
    const malformed = {
      kind: "existing",
      connectionId: accountProfile.connectionId,
      password: v1Password,
      environment: { kind: "cloud", region: "eu" },
    };
    expect((await h.caller.begin(malformed as SetupBegin)).ok).toBe(false);
    expect(h.fetch).toHaveBeenCalledTimes(count);
  });
}
