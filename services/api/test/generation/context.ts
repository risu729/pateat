import type {
  LoginObservation,
  LoginRecipe,
  ObservedCandidate,
  RecipeCompletionResult,
  RecipeGenerationResult,
  SemanticSlot,
  StoredLoginRecipe,
} from "@pateat/contracts";

export type Usage = { input_tokens: number; output_tokens: number };
export type Reply = { text: string; usage?: Usage } | { refusal: string; usage?: Usage } | number;
export type Device = { ownerId: string; deviceId: string; token: string };
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

/** Original helpers are passed by reference; registrars destructure only immutable bindings. */
export interface GenerationContext {
  ORIGIN: string;
  DAY_MS: number;
  WORST_CASE: number;
  slots: SemanticSlot[];
  element: (
    id: string,
    role: ObservedCandidate["role"],
    label: string,
  ) => {
    id: string;
    role: ObservedCandidate["role"];
    target: { by: "id"; value: string };
    label: string;
  };
  observation: (path: string, candidates: ObservedCandidate[], origin?: string) => LoginObservation;
  emailPage: LoginObservation;
  passwordPage: LoginObservation;
  homePage: LoginObservation;
  WIDE: string;
  bigPage: () => LoginObservation;
  route: (recipe: StoredLoginRecipe | LoginRecipe) => LoginRecipe;
  plan: (fields: [string, string][], action: string, purpose: "advance" | "submit") => string;
  holdSlots: (ownerId: string, taken?: number[]) => Promise<D1Result<unknown>[]>;
  owner: (options?: { claude?: boolean }) => Promise<Device>;
  layoutKey: (ownerId: string, recipeId: string) => Promise<string | undefined>;
  branchOf: (ownerId: string, recipeId: string, side?: "account" | "other") => Promise<string>;
  post: (
    device: Device,
    path: string,
    body: unknown,
    method?: string,
    raw?: boolean,
  ) => Promise<Response>;
  storedHead: (ownerId: string, recipeId: string) => Promise<unknown>;
  documentOf: (recipe: LoginRecipe) => StoredLoginRecipe;
  projected: <Answer>(answer: Answer) => Answer;
  generate: (
    device: Device,
    page: LoginObservation,
    base?: unknown,
  ) => Promise<RecipeGenerationResult>;
  complete: (
    device: Device,
    recipeId: string,
    revision: number,
    page?: LoginObservation,
    partial?: true,
  ) => Promise<{
    status: number;
    body: RecipeCompletionResult | { error: string };
  }>;
  serverTiming: (response: Response) => Record<string, number | undefined>;
  rows: (sql: string, ...values: unknown[]) => Promise<Row[]>;
  month: () => string;
  day: () => string;
  failLogPurge: () => { mockRestore: () => void };
  failLogUpdate: (column: "revision" | "server_ms") => { mockRestore: () => void };
  logRows: (
    ownerId: string,
    role?: string,
  ) => Promise<
    {
      recipe_id: unknown;
      branch: unknown;
      base_revision: unknown;
      revision: unknown;
      recipe_page: unknown;
      build: unknown;
      observation_hash: unknown;
      answer: unknown;
      request: { observation: unknown };
    }[]
  >;
  hashOf: (value: unknown) => Promise<string>;
  twoPageRecipe: (
    device: Device,
  ) => Promise<Extract<RecipeGenerationResult, { status: "recipe" }>["change"]>;
  bigSlots: { id: string; kind: "identifier"; description: string; fieldName: string }[];
  state: GenerationState;
}

export interface RecipeChoiceContext extends GenerationContext {
  choice: (
    model: string,
    effort: "low" | "medium",
    speed: "standard" | "fast",
  ) => {
    provider: "anthropic";
    model: string;
    effort: "low" | "medium";
    speed: "standard" | "fast";
  };
  asked: () => { model: string; effort: string | undefined; speed: string | undefined }[];
}

export interface PageJudgementContext extends GenerationContext {
  judgeReply: (result: unknown) => { text: string };
  webauthnPage: LoginObservation;
  dayStart: () => number;
  judgements: (device: Device) => Promise<Row[]>;
  seed: (
    device: Device,
    recipeId: string,
    revision: number,
    path: string,
    at: number,
    options?: {
      promptVersion?: string;
      verdict?: string | null;
      inputs?: string | null;
    },
  ) => Promise<D1Result<unknown>>;
  seedUsage: (
    device: Device,
    recipeId: string,
    revision: number,
    path: string,
    at: number,
  ) => Promise<void>;
  spend: (device: Device) => Promise<Row[]>;
  head: (device: Device, recipeId: string) => Promise<unknown>;
}
