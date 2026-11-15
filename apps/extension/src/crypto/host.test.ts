import { afterEach, describe, vi } from "vitest";
import { accountUserId } from "../../../../packages/bitwarden/src/__fixtures__/account";
import { v1Email, v1Password } from "../../../../packages/bitwarden/src/__fixtures__/crypto";
import {
  connectionId,
  disposeHosts,
  documentId,
  extensionId,
  harness,
  itemId,
  offscreenUrl,
  oldOffscreenUrl,
  openInput,
  prepared,
  snapshotId,
} from "../../test/crypto-host/harness";
import { registerAuthorizationCases } from "../../test/crypto-host/authorization-cases";
import { registerRequestFencingCases } from "../../test/crypto-host/request-fencing-cases";
import { registerUriSessionLaneCases } from "../../test/crypto-host/uri-session-lane-cases";
import { registerCustomFieldDigestCases } from "../../test/crypto-host/custom-field-digest-cases";
import { registerLoginUsernameCases } from "../../test/crypto-host/login-username-cases";
import { registerPasskeyCases } from "../../test/crypto-host/passkey-cases";
import { registerCancellationHostLossCases } from "../../test/crypto-host/cancellation-host-loss-cases";

/** Settles with the promise's result, or "waiting" if it is still pending after `ms`. */
function within<T>(promise: Promise<T>, ms: number) {
  return Promise.race([
    promise,
    new Promise<"waiting">((resolve) => setTimeout(() => resolve("waiting"), ms)),
  ]);
}

function auth() {
  return {
    connectionId: String(connectionId),
    email: v1Email,
    password: v1Password,
    prelogin: { mode: "legacy" as const, response: { kdf: 0, kdfIterations: 100_000 } },
  };
}

/** A sign-in whose prelogin asks for Argon2id. */
function argon2idAuth(owner = "connection-2") {
  return {
    ...auth(),
    connectionId: owner,
    prelogin: {
      mode: "legacy" as const,
      response: { kdf: 1, kdfIterations: 2, kdfMemory: 16, kdfParallelism: 1 },
    },
  };
}

afterEach(async () => {
  vi.useRealTimers();
  await disposeHosts();
  vi.restoreAllMocks();
});

describe("background-only crypto host authorization and handshake", () => {
  registerAuthorizationCases({
    harness,
    auth,
    extensionId,
    offscreenUrl,
    oldOffscreenUrl,
    documentId,
    connectionId,
  });
});

describe("fixed operations, session scope and reply fencing", () => {
  registerRequestFencingCases({ harness, auth, snapshotId, itemId, connectionId });

  const uriCandidates = {
    connectionId,
    userId: accountUserId,
    snapshotId,
    targetOrigin: "https://example.com",
    candidates: [{ itemId, matches: [{ uriIndex: 0, match: 0 }] }],
    unavailableUris: [{ itemId, uriIndex: 1, reason: "default-match-unavailable" }],
    unavailableItemIds: [],
  };
  registerUriSessionLaneCases({
    harness,
    auth,
    openInput,
    within,
    snapshotId,
    itemId,
    connectionId,
    uriCandidates,
  });

  const otherItem = "30000000-0000-4000-8000-000000000003";
  const digests = { digests: { [itemId]: "A".repeat(43), [otherItem]: null } };
  registerCustomFieldDigestCases({ harness, itemId, otherItem, digests });

  const usernames = { usernames: { [itemId]: "alice@example.test", [otherItem]: null } };
  registerLoginUsernameCases({ harness, itemId, otherItem, usernames });

  const passkeyBinding = { connectionId, userId: accountUserId, snapshotId, itemId };
  const storedPasskey = {
    ...passkeyBinding,
    credentialId: "EjRWeBI0QjSCNBI0VniavA",
    rpId: "example.com",
    userHandle: "c3ludGhldGljLXVzZXI",
    discoverable: true,
    counter: 0,
    userName: null,
  };
  const signInput = {
    itemId,
    credentialId: storedPasskey.credentialId,
    rpId: storedPasskey.rpId,
    authenticatorData: "A".repeat(50),
    clientDataHash: "B".repeat(43),
  };
  const passkeySignature = {
    ...passkeyBinding,
    credentialId: storedPasskey.credentialId,
    signature: "MAYCAQECAQE",
  };
  const passkeyMatches = {
    connectionId,
    userId: accountUserId,
    snapshotId,
    rpId: storedPasskey.rpId,
    candidates: [storedPasskey],
    unavailableItemIds: [crypto.randomUUID()],
  };
  registerPasskeyCases({
    harness,
    snapshotId,
    itemId,
    connectionId,
    storedPasskey,
    signInput,
    passkeySignature,
    passkeyMatches,
  });
});

describe("cancellation, deadlines and host loss", () => {
  registerCancellationHostLossCases({
    harness,
    auth,
    argon2idAuth,
    prepared,
    openInput,
    within,
    snapshotId,
    itemId,
    connectionId,
  });
});
