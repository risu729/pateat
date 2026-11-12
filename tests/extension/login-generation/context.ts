import type { LoginGenerationTestFixtures } from "../login-generation.spec";

export type { RecipeChanges } from "../login-generation.spec";

export type RecipeLearningContext = Pick<
  LoginGenerationTestFixtures,
  "site" | "password" | "serveSite" | "SETTLE_MS" | "syntheticClaude" | "connect"
>;

export type ContinuationContext = Pick<
  LoginGenerationTestFixtures,
  | "site"
  | "password"
  | "serveSite"
  | "SETTLE_MS"
  | "syntheticClaude"
  | "connect"
  | "username"
  | "shortenStepWait"
>;

export type EntryPageContext = Pick<
  LoginGenerationTestFixtures,
  "site" | "password" | "serveSite" | "SETTLE_MS" | "syntheticClaude" | "connect" | "username"
>;

export type LayoutRepairContext = Pick<
  LoginGenerationTestFixtures,
  "site" | "password" | "serveSite" | "syntheticClaude" | "connect"
>;
