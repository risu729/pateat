import type { PasskeySource } from "../../src/passkeys/runtime";
export type RuntimeFixtures = {
  extensionId: string;
  origin: string;
  sender(overrides?: Record<string, unknown>): {
    id: string;
    tab: { id: number };
    frameId: number;
    documentId: string;
    documentLifecycle: string;
    origin: string;
    url: string;
  };
  candidate: {
    credentialId: string;
    rpId: string;
    userHandle: string;
    discoverable: boolean;
    counter: number;
  };
  request: { challenge: string; rpId: string; allowCredentials: never[] };
  get(
    operationId?: ReturnType<Crypto["randomUUID"]>,
    userActivation?: boolean,
    focused?: boolean,
  ): {
    version: number;
    type: string;
    operationId: ReturnType<Crypto["randomUUID"]>;
    request: RuntimeFixtures["request"];
    userActivation: boolean;
    focused: boolean;
  };
  source(overrides?: Partial<PasskeySource>): PasskeySource;
};
export type RuntimeGet = ReturnType<RuntimeFixtures["get"]>;
