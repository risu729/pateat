import type {
  connectionId,
  documentId,
  extensionId,
  harness,
  itemId,
  offscreenUrl,
  oldOffscreenUrl,
  openInput,
  prepared,
  snapshotId,
} from "./harness";

type Authentication = {
  connectionId: string;
  email: string;
  password: string;
  prelogin: { mode: "legacy"; response: { kdf: number; kdfIterations: number } };
};
type PasskeyBinding = { connectionId: string; userId: string; snapshotId: string; itemId: string };
type StoredPasskey = PasskeyBinding & {
  credentialId: string;
  rpId: string;
  userHandle: string;
  discoverable: boolean;
  counter: number;
  userName: null;
};

/** What `crypto/host.test.ts` passes its case registrars: the harness and its fixtures. */
export type CryptoHostTestContext = {
  harness: typeof harness;
  prepared: typeof prepared;
  openInput: typeof openInput;
  extensionId: typeof extensionId;
  offscreenUrl: typeof offscreenUrl;
  oldOffscreenUrl: typeof oldOffscreenUrl;
  documentId: typeof documentId;
  snapshotId: typeof snapshotId;
  itemId: typeof itemId;
  connectionId: typeof connectionId;
  auth: () => Authentication;
  argon2idAuth: (owner?: string) => Authentication & {
    prelogin: { response: { kdfMemory: number; kdfParallelism: number } };
  };
  within: <T>(promise: Promise<T>, ms: number) => Promise<T | "waiting">;
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
};
