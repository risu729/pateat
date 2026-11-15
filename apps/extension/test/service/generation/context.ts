import type { GenerationTestFixtures } from "../../../src/service/generation.test";
import type { LoginObservation, RecipeGenerationRequest, SemanticSlot } from "@pateat/contracts";
import type { Mock } from "vitest";
import type { ServiceConnection } from "../../../src/service/runtime";
import type { ServiceTransport } from "../../../src/service/transport";
import type { LoginGeneration } from "../../../src/login/runtime/deps";

type Answer = Awaited<ReturnType<ServiceTransport["generateRecipe"]>>;
type Identity = { version: 1; id: string; revision: number; origin: string };

type StoredRoute<T extends GenerationTestFixtures["route"]> = Identity & {
  layouts: ({ key: string; createdAt: number } & Omit<T, keyof Identity | "layout">)[];
};
type ChangedRoute<T extends GenerationTestFixtures["route"]> = Omit<
  GenerationTestFixtures["recipeChange"],
  "recipe"
> & {
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
  handledRuns: GenerationTestFixtures["runs"] & {
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
  continued: GenerationTestFixtures["recipeChange"];
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
    result: { version: 1; status: "recipe"; change: GenerationTestFixtures["recipeChange"] };
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
    change?: GenerationTestFixtures["recipeChange"];
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
  continued: GenerationTestFixtures["recipeChange"];
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
    samplePage: Mock<ServiceTransport["samplePage"]>;
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

/** What `service/generation.test.ts` passes its case registrars: its fixtures and helpers. */
export type ServiceGenerationTestContext = GenerationTestFixtures &
  RequestsContext &
  TimingContext &
  HandlersContext &
  ContinuationContext &
  RepairContext &
  ContinuationClaimsContext &
  SlotMapsContext &
  SamplesContext &
  RepairClaimsContext;
