import type { LocalVaultHandle } from "../../src/vault/manager-types";
import type { LocalVaultManager } from "../../src/vault/manager";
import type { accepted, candidate, gate, harness, itemId, managers } from "./harness";

type Harness = ReturnType<typeof harness>;
export type OperationName =
  | "listFields"
  | "catalog"
  | "matchUris"
  | "loginUsernames"
  | "findPasskeys"
  | "passkeyRpIds"
  | "signPasskey"
  | "verifyMasterPassword";
export type Operation = {
  name: OperationName;
  args: () => unknown[];
  invoke: (h: Harness, handle: LocalVaultHandle, signal?: AbortSignal) => Promise<unknown>;
  hold: (h: Harness, held: ReturnType<typeof gate>) => void;
};

/** What `vault/manager.test.ts` passes its case registrars: the harness and its fixtures. */
export type VaultManagerTestContext = {
  managers: typeof managers;
  harness: typeof harness;
  candidate: typeof candidate;
  accepted: typeof accepted;
  gate: typeof gate;
  itemId: typeof itemId;
  operation: Operation;
  signingInput: () => {
    itemId: string;
    credentialId: string;
    rpId: string;
    authenticatorData: string;
    clientDataHash: string;
  };
  invalid: {
    name: OperationName;
    code: "invalid-request" | "invalid-uri-input";
    invoke: Operation["invoke"];
  }[];
  compare: (ids?: string[]) => ReturnType<typeof candidate> & { compareCustomFields: string[] };
  unlocked: (
    h: Harness,
    password?: string,
  ) => Promise<Extract<Awaited<ReturnType<LocalVaultManager["unlock"]>>, { ok: true }>["data"]>;
  passwordFailure: { ok: false; error: { code: "crypto-failed" } };
};
