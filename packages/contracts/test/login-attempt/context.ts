import type { LoginDocument, LoginRecipe } from "../../src/login";
import type { createAttemptMetadata, transitionLoginAttempt } from "../../src/login-attempt";

export type LoginAttemptMetadataLike = ReturnType<typeof transitionLoginAttempt>;

export interface LoginAttemptTestContext {
  facts: { password: boolean; totp: boolean; passkey: boolean; discoverablePasskey: boolean };
  document: LoginDocument;
  recipe: LoginRecipe;
  noTimeBefore: {
    since: number;
    serviceMs: number;
    networkMs: number;
    personMs: number;
    pageMs: number;
  };
  detected: (selected?: LoginRecipe) => ReturnType<typeof createAttemptMetadata>;
  readyToClick: () => LoginAttemptMetadataLike;
  submitting: () => LoginAttemptMetadataLike;
}

export interface PasswordStopTestContext extends LoginAttemptTestContext {
  top: LoginDocument;
  id: (value: string) => { by: "id"; value: string };
  emailFirst: LoginRecipe;
  keyOnly: LoginAttemptTestContext["facts"];
  create: (
    change?: Partial<Parameters<typeof createAttemptMetadata>[0]>,
    stopAt?: number | null,
  ) => ReturnType<typeof createAttemptMetadata>;
  advanced: (
    change?: Partial<Parameters<typeof createAttemptMetadata>[0]>,
  ) => LoginAttemptMetadataLike;
  atStop: () => LoginAttemptMetadataLike;
  answer: { readonly type: "STOP_ANSWERED"; readonly operationId: "answer-one" };
}
