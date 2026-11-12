import type { Mock } from "vitest";
import type { CryptoHost, CryptoHostPort } from "../../../src/crypto/host";
import type { HostCommand, HostSessionRef } from "../../../src/crypto/wire";

type NativeContext = { documentId?: string; documentUrl?: string };
type Event<T extends unknown[]> = {
  addListener: (listener: (...args: T) => void) => void;
  removeListener: (listener: (...args: T) => void) => void;
  emit: (...args: T) => void;
};
type Harness = {
  host: CryptoHost;
  port: CryptoHostPort;
  onConnect: Event<[CryptoHostPort]>;
  onMessage: Event<[unknown]>;
  onDisconnect: Event<[]>;
  posted: unknown[];
  commands: HostCommand[];
  command: (index?: number) => Promise<HostCommand>;
  reply: (command: HostCommand, result: unknown, extra?: Record<string, unknown>) => void;
  answerOpen: (request: HostCommand) => HostSessionRef;
  open: (ownedConnectionId?: string) => Promise<HostSessionRef>;
  closeDocument: Mock<() => Promise<void>>;
  createDocument: Mock<() => Promise<void>>;
  getContexts: Mock<() => Promise<NativeContext[]>>;
  setContexts: (next: NativeContext[]) => void;
};
type Authentication = {
  connectionId: string;
  email: string;
  password: string;
  prelogin: { mode: "legacy"; response: { kdf: number; kdfIterations: number } };
};
type OpenInput = Parameters<CryptoHost["open"]>[0];
type PasskeyBinding = { connectionId: string; userId: string; snapshotId: string; itemId: string };
type StoredPasskey = PasskeyBinding & {
  credentialId: string;
  rpId: string;
  userHandle: string;
  discoverable: boolean;
  counter: number;
  userName: null;
};
type SourceInput = { itemId: string; allowedFieldIds: string[] };
type CandidateInput = { usernameProof: string; candidates: SourceInput[] };

export interface CryptoHostTestContext {
  harness: (options?: {
    timeoutMs?: number;
    argon2idTimeoutMs?: number;
    existing?: boolean;
    automaticReady?: boolean;
    checkpoint?: (stage: "before-dispatch" | "after-result") => Promise<void>;
    creationContexts?: NativeContext[];
    contextLookup?: () => Promise<void>;
  }) => Harness;
  auth: () => Authentication;
  argon2idAuth: (owner?: string) => Authentication & {
    prelogin: { response: { kdfMemory: number; kdfParallelism: number } };
  };
  prepared: () => OpenInput["prepared"];
  openInput: (ownedConnectionId?: string) => OpenInput & {
    unlock: { kind: "password"; password: string };
  };
  within: <T>(promise: Promise<T>, ms: number) => Promise<T | "waiting">;
  extensionId: string;
  offscreenUrl: string;
  oldOffscreenUrl: string;
  documentId: string;
  snapshotId: string;
  itemId: string;
  connectionId: string;
  uriCandidates: {
    connectionId: string;
    userId: string;
    snapshotId: string;
    targetOrigin: string;
    candidates: { itemId: string; matches: { uriIndex: number; match: number }[] }[];
    unavailableUris: { itemId: string; uriIndex: number; reason: string }[];
    unavailableItemIds: never[];
  };
  otherItem: string;
  digests: { digests: { [itemId: string]: string | null } };
  usernames: { usernames: { [itemId: string]: string | null } };
  storedPasskey: StoredPasskey;
  signInput: {
    itemId: string;
    credentialId: string;
    rpId: string;
    authenticatorData: string;
    clientDataHash: string;
  };
  passkeySignature: PasskeyBinding & { credentialId: string; signature: string };
  passkeyMatches: {
    connectionId: string;
    userId: string;
    snapshotId: string;
    rpId: string;
    candidates: StoredPasskey[];
    unavailableItemIds: string[];
  };
  sourceInput: SourceInput;
  candidateInput: CandidateInput;
  sourceResult: {
    itemId: string;
    snapshotId: string;
    sourceEvidence: string;
    result: {
      status: string;
      methods: {
        method: { number: number };
        fieldId: string;
        automatic: boolean;
        form: string;
        label: string;
        usernameProof: string;
      }[];
    };
  };
  candidateResult: { snapshotId: string; candidates: { itemId: string; origins: string[] }[] };
}
