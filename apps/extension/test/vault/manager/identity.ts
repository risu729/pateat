import { expect, it } from "vitest";
import { type VaultEntry, vaultFailure } from "../../../src/vault/record";
import { preparedVault } from "../../../../../packages/bitwarden/src/__fixtures__/unlock";
import { activeEntry } from "../../../src/vault/__fixtures__/vault";
import type { VaultManagerTestContext } from "./context";

export function registerIdentityCases({
  harness,
  candidate,
}: Pick<VaultManagerTestContext, "harness" | "candidate">) {
  it.each(["active", "disabled"] as const)(
    "retains the prior V2 account format even with floor1 in %s state",
    async (state) => {
      const prior = activeEntry("v2");
      prior.accepted.minimumSecurityVersion = 1;
      prior.accepted.prepared.minimumSecurityVersion = 1;
      const initial: VaultEntry =
        state === "active"
          ? prior
          : {
              schemaVersion: 1,
              revision: prior.revision,
              profile: prior.profile,
              state: "disabled",
              accepted: prior.accepted,
            };
      const h = harness({ initial });
      expect(await h.manager.accept(candidate())).toEqual(vaultFailure("security-downgrade"));
      expect(h.host.open).not.toHaveBeenCalled();
    },
  );
  it("carries the prior verified floor into a fresh native open rather than trusting lower prepared metadata", async () => {
    const h = harness({ initial: activeEntry("v2") });
    const next = { ...candidate(), prepared: preparedVault("v2") };
    expect(next.prepared.minimumSecurityVersion).toBe(1);
    const result = await h.manager.accept(next);
    expect(result.ok).toBe(true);
    expect(h.host.open.mock.calls[0]![0].prepared.minimumSecurityVersion).toBe(2);
  });
  it("rejects a different account subject before native open", async () => {
    const h = harness({ initial: activeEntry() });
    const next = candidate();
    next.prepared.binding.userId = "50000000-0000-4000-8000-000000000001";
    expect(await h.manager.accept(next)).toEqual(vaultFailure("account-mismatch"));
    expect(h.host.open).not.toHaveBeenCalled();
  });
}
