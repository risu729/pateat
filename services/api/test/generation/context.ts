import type {
  GenerationFixtures,
  PageJudgementFixtures,
  RecipeChoiceFixtures,
} from "../generation.test";

export type Usage = { input_tokens: number; output_tokens: number };
/** A text answer, a refusal with its category, or an HTTP error status. */
export type Reply = { text: string; usage?: Usage } | { refusal: string; usage?: Usage } | number;
export type Device = { ownerId: string; deviceId: string; token: string };
/** The columns the assertions read by name; other columns are compared whole. */
export type Row = Record<string, unknown> &
  Partial<Record<"id" | "role" | "path" | "outcome" | "request" | "result", unknown>>;

/** Forwarded by getters and setters to the entrypoint's single mutable owner. */
export interface GenerationState {
  replies: Reply[];
  during: (() => Promise<void>) | undefined;
  held: Promise<void> | undefined;
  tokenStatus: number;
  tokenDelayMs: number;
  tokenHook: (() => Promise<void>) | undefined;
  sent: { authorization: string | null; apiKey: string | null; body: unknown }[];
}

/**
 * The entry's helpers, typed from their definitions there. They are passed by reference;
 * registrars destructure only immutable bindings.
 */
export type GenerationContext = GenerationFixtures;
export type RecipeChoiceContext = RecipeChoiceFixtures;
export type PageJudgementContext = PageJudgementFixtures;
