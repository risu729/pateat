import type { BitwardenResult } from "@pateat/bitwarden";
import type { CryptoHost } from "../crypto/host";
import type { HostSessionRef } from "../crypto/wire";
import type {
  SsoSourceInput,
  SsoCandidateInput,
  SsoMethods,
  SsoCandidates,
} from "../crypto/sso-wire";
import type { LocalVaultHandle } from "./manager";
import { vaultFailure, type VaultResult } from "./record";

export type SsoCryptoHost = Partial<Pick<CryptoHost, "ssoMethods" | "ssoCandidates">>;
export function ssoManagerOperations(
  host: SsoCryptoHost,
  withLiveVault: <T>(
    handle: LocalVaultHandle,
    job: (session: HostSessionRef) => Promise<BitwardenResult<T>>,
  ) => Promise<VaultResult<T>>,
) {
  return {
    async ssoMethods(
      handle: LocalVaultHandle,
      input: SsoSourceInput,
    ): Promise<VaultResult<SsoMethods>> {
      if (!host.ssoMethods) return vaultFailure("invalid-request");
      try {
        handle = structuredClone(handle);
        input = structuredClone(input);
      } catch {
        return vaultFailure("invalid-request");
      }
      return withLiveVault(handle, (session) => host.ssoMethods!(session, input));
    },
    async ssoCandidates(
      handle: LocalVaultHandle,
      input: SsoCandidateInput,
    ): Promise<VaultResult<SsoCandidates>> {
      if (!host.ssoCandidates) return vaultFailure("invalid-request");
      try {
        handle = structuredClone(handle);
        input = structuredClone(input);
      } catch {
        return vaultFailure("invalid-request");
      }
      return withLiveVault(handle, (session) => host.ssoCandidates!(session, input));
    },
  };
}
