/** Synthetic provider DTOs; these strings are opaque and cannot decrypt a vault. */
export const legacyPrelogin = {
  kdf: 0,
  kdfIterations: 600_000,
  kdfMemory: null,
  kdfParallelism: null,
};

export const passwordPrelogin = {
  kdfSettings: { kdfType: 1, iterations: 3, memory: 64, parallelism: 4 },
  salt: "synthetic-user@example.test",
};

export function encryptedSync() {
  return {
    object: "sync",
    profile: {
      id: "00000000-0000-4000-8000-000000000001",
      key: "99.synthetic-unknown-encrypted-user-key",
      organizations: [],
    },
    folders: [],
    collections: [],
    ciphers: [
      {
        id: "00000000-0000-4000-8000-000000000002",
        type: 99,
        name: "99.synthetic-unknown-encrypted-name",
        login: { password: "99.synthetic-unknown-encrypted-password" },
      },
    ],
    policies: [],
    policiesNew: [],
    sends: [],
    domains: null,
    userDecryption: {
      v2UpgradeToken: {
        wrappedUserKey1: "99.synthetic-unknown-wrapped-key-one",
        wrappedUserKey2: "99.synthetic-unknown-wrapped-key-two",
      },
    },
    futureProviderEnvelope: { encryptedValue: "99.synthetic-future-envelope" },
  };
}

export function jsonResponse(value: unknown, init: ResponseInit = {}) {
  const headers = new Headers(init.headers);
  if (!headers.has("content-type")) headers.set("content-type", "application/json");
  return new Response(JSON.stringify(value), {
    ...init,
    headers,
  });
}

/** Each pull delivers one chunk, letting tests prove incremental limit enforcement. */
export function streamedResponse(chunks: string[], headers: Record<string, string> = {}) {
  let index = 0;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        const chunk = chunks[index++];
        if (chunk === undefined) controller.close();
        else controller.enqueue(new TextEncoder().encode(chunk));
      },
      cancel() {
        cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  return {
    response: new Response(body, { headers: { "content-type": "application/json", ...headers } }),
    cancelled: () => cancelled,
    pulls: () => index,
  };
}
