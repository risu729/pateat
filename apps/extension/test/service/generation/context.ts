import type { GenerationTestFixtures } from "../../../src/service/generation.test";
import type { LoginObservation, RecipeGenerationRequest, SemanticSlot } from "@pateat/contracts";
import type { Mock } from "vitest";
import type { ServiceConnection } from "../../../src/service/runtime";
import type { ServiceTransport } from "../../../src/service/transport";
import type { LoginGeneration } from "../../../src/login/runtime/deps";

export type Answer = Awaited<ReturnType<ServiceTransport["generateRecipe"]>>;
type Identity = { version: 1; id: string; revision: number; origin: string };

type RootContext = GenerationTestFixtures;

type StoredRoute<T extends RootContext["route"]> = Identity & {
  layouts: ({ key: string; createdAt: number } & Omit<T, keyof Identity | "layout">)[];
};
type ChangedRoute<T extends RootContext["route"]> = Omit<RootContext["recipeChange"], "recipe"> & {
  recipe: StoredRoute<T>;
};

interface RequestsContext {
  freed: [string, Answer, string, string][];
  unavailable: (reason: string) => {
    kind: "result";
    result: {
      version: 1;
      status: "unavailable";
      reason: string;
    };
  };
  failure: (error: string) => {
    kind: "result";
    result: {
      version: 1;
      status: "failed";
      error: string;
    };
  };
}

interface TimingContext {
  timing: {
    roundTripMs: number;
    serverMs: number;
    networkMs: number;
    modelMs: number;
  };
}

interface HandlersContext {
  totp: {
    id: string;
    kind: "one-time-code";
    description: string;
  };
  handledRuns: RootContext["runs"] & {
    handlers: { kind: "passkey"; path: string; target: { by: "text"; value: string } }[];
  };
  handled: ChangedRoute<HandlersContext["handledRuns"]>;
  webauthn: LoginObservation;
  completed: ChangedRoute<
    HandlersContext["handledRuns"] & { completion: { target: { by: "id"; value: string } }[] }
  >;
}

interface ContinuationContext {
  base: {
    recipeId: string;
    revision: number;
  };
  continuation: RecipeGenerationRequest;
  continued: RootContext["recipeChange"];
}

interface RepairContext {
  repair: RecipeGenerationRequest;
}

interface ContinuationClaimsContext {
  base: {
    recipeId: string;
    revision: number;
  };
  continuation: RecipeGenerationRequest;
  answerOf: (revision: number) => {
    kind: "result";
    result: { version: 1; status: "recipe"; change: RootContext["recipeChange"] };
  };
  sent: {
    outcome: string;
    reason: string;
  };
}

interface SlotMapsContext {
  offered: RecipeGenerationRequest;
  customSlots: {
    slot: string;
    offered: string;
  }[];
  mapped: (
    | {
        slot: string;
        field: {
          custom: string;
          position?: never;
          count?: never;
        };
      }
    | {
        slot: string;
        field: {
          custom: string;
          position: number;
          count: number;
        };
      }
  )[];
  recipeId: string;
  idOf: (index: number) => string;
  slotSetup: (options?: {
    customSlots?: {
      slot: string;
      offered: string;
    }[];
    stored?: unknown;
    failWrite?: boolean;
    failReads?: number;
    change?: RootContext["recipeChange"];
  }) => {
    generation: LoginGeneration;
    service: {
      connection: Mock<() => Promise<ServiceConnection | undefined>>;
    };
    slotStorage: {
      read: Mock<() => Promise<unknown>>;
      write: Mock<(value: unknown) => Promise<void>>;
    };
    order: string[];
    stored: () => unknown;
  };
  ownMap: (
    id: string,
    slots: {
      slot: string;
      field: {
        custom: string;
      };
    }[],
  ) => {
    service: string;
    deviceId: string;
    recipeId: string;
    slots: {
      slot: string;
      field: {
        custom: string;
      };
    }[];
  };
  continued: RootContext["recipeChange"];
  continuation: RecipeGenerationRequest;
}

interface SamplesContext {
  recipeId: string;
  signedIn: LoginObservation;
  sample: {
    recipeId: string;
    revision: number;
    route: "password";
    branch: string;
  };
  accountSlots: SemanticSlot[];
  sampleSetup: (paired?: boolean | ServiceConnection) => {
    generation: LoginGeneration;
    samplePage: Mock<
      (
        origin: string,
        credential: string,
        recipeId: string,
        request: import("@pateat/contracts").RecipePageSampleRequest,
      ) => Promise<
        import("/home/risu/work/pateat-security-20261111/service-generation-tests/apps/extension/src/service/transport").PageSampleResult
      >
    >;
    sampleStorage: {
      read: Mock<() => Promise<unknown>>;
      write: Mock<(value: unknown) => Promise<void>>;
    };
    describePage: Mock<
      () => Promise<
        | {
            observation: LoginObservation;
            slots: readonly SemanticSlot[];
          }
        | {
            unsent: string;
          }
      >
    >;
    order: string[];
    stored: () => unknown;
    advance: (ms: number) => void;
  };
}

interface RepairClaimsContext {
  recipeId: string;
  shared: () => {
    stored: () => unknown;
    set: (value: unknown) => void;
    storage: () => {
      read: Mock<() => Promise<unknown>>;
      write: Mock<(value: unknown) => Promise<void>>;
    };
  };
  claimSetup: (options?: {
    store?: ReturnType<
      () => {
        stored: () => unknown;
        set: (value: unknown) => void;
        storage: () => {
          read: Mock<() => Promise<unknown>>;
          write: Mock<(value: unknown) => Promise<void>>;
        };
      }
    >;
    paired?: () => ServiceConnection | undefined;
    now?: {
      value: number;
    };
  }) => {
    generation: LoginGeneration;
    replaceStorage: {
      read: Mock<() => Promise<unknown>>;
      write: Mock<(value: unknown) => Promise<void>>;
    };
    store: {
      stored: () => unknown;
      set: (value: unknown) => void;
      storage: () => {
        read: Mock<() => Promise<unknown>>;
        write: Mock<(value: unknown) => Promise<void>>;
      };
    };
    advance: (ms: number) => void;
  };
  entries: (h: {
    store: ReturnType<
      () => {
        stored: () => unknown;
        set: (value: unknown) => void;
        storage: () => {
          read: Mock<() => Promise<unknown>>;
          write: Mock<(value: unknown) => Promise<void>>;
        };
      }
    >;
  }) => {
    recipeId: string;
    deviceId: string;
    route: string;
    at: number;
  }[];
}

export type Requests1Context = Pick<
  RootContext,
  | "connection"
  | "observation"
  | "request"
  | "KEY"
  | "chooserOf"
  | "runs"
  | "recipeChange"
  | "entryChange"
  | "entryRequest"
  | "setup"
>;

export type Requests2Context = Pick<
  RootContext,
  "connection" | "observation" | "request" | "KEY" | "storedOf" | "route" | "recipeChange" | "setup"
> &
  Pick<RequestsContext, "freed">;

export type Requests3Context = Pick<RootContext, "observation" | "recipeChange" | "setup"> &
  Pick<RequestsContext, "unavailable" | "failure">;

export type Timing1Context = Pick<
  RootContext,
  "observation" | "request" | "recipeChange" | "entryRequest" | "setup"
> &
  Pick<TimingContext, "timing">;

export type Handlers1Context = Pick<
  RootContext,
  "connection" | "KEY" | "chooserOf" | "recipeChange" | "setup"
> &
  Pick<HandlersContext, "handledRuns" | "handled" | "webauthn">;

export type Handlers2Context = Pick<
  RootContext,
  "connection" | "observation" | "request" | "recipeChange" | "setup"
> &
  Pick<HandlersContext, "totp" | "handled" | "webauthn" | "completed">;

export type Continuation1Context = Pick<
  RootContext,
  "connection" | "observation" | "request" | "runs" | "setup"
> &
  Pick<ContinuationContext, "base" | "continuation" | "continued">;

export type Repair1Context = Pick<
  RootContext,
  "connection" | "request" | "recipeChange" | "setup"
> &
  Pick<RepairContext, "repair">;

export type ContinuationClaims1Context = Pick<
  RootContext,
  "observation" | "request" | "runs" | "setup"
> &
  Pick<ContinuationClaimsContext, "continuation" | "answerOf" | "sent">;

export type ContinuationClaims2Context = Pick<
  RootContext,
  "connection" | "observation" | "request" | "KEY" | "setup"
> &
  Pick<ContinuationClaimsContext, "base" | "continuation" | "answerOf" | "sent">;

export type SlotMaps1Context = Pick<RootContext, "connection" | "observation"> &
  Pick<SlotMapsContext, "offered" | "customSlots" | "mapped" | "recipeId" | "idOf" | "slotSetup">;

export type SlotMaps2Context = Pick<RootContext, "storedOf" | "route"> &
  Pick<
    SlotMapsContext,
    | "offered"
    | "customSlots"
    | "mapped"
    | "recipeId"
    | "idOf"
    | "slotSetup"
    | "ownMap"
    | "continued"
    | "continuation"
  >;

export type Samples1Context = Pick<RootContext, "connection" | "KEY"> &
  Pick<SamplesContext, "recipeId" | "signedIn" | "sample" | "accountSlots" | "sampleSetup">;

export type RepairClaims1Context = Pick<RootContext, "connection"> &
  Pick<RepairClaimsContext, "recipeId" | "shared" | "claimSetup" | "entries">;

export type Popup1Context = Pick<RootContext, "observation" | "request" | "recipeChange" | "setup">;
