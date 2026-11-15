import type { expect, test } from "@playwright/test";
import type { PasskeySpecHelpers } from "../passkeys.spec";

/** What the relying party page's last request settled with, as the page serializes it. */
export type Serialized =
  | { error: string }
  | {
      instance: boolean;
      responseInstance: boolean;
      id: string;
      rawId: string;
      type: string;
      attachment: string | null;
      clientDataJSON: string;
      authenticatorData: string;
      signature: string;
      userHandle: string | null;
      extensions: unknown;
      json: unknown;
    };

export type Spec = {
  challenge: string;
  rpId?: string;
  userVerification?: string;
  allow?: string[];
  mediation?: string;
  uiMode?: string;
  timeout?: number;
};

/** What `passkeys.spec.ts` passes its case registrars: the test API and its own helpers. */
export type PasskeyCaseContext = PasskeySpecHelpers & { test: typeof test; expect: typeof expect };
