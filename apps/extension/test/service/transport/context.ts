import type { TransportTestFixtures } from "../../../src/service/transport.test";

export type PairingContext = Pick<TransportTestFixtures, "ORIGIN" | "CREDENTIAL" | "respond">;

export type SettingsContext = Pick<
  TransportTestFixtures,
  "ORIGIN" | "CREDENTIAL" | "respond" | "untimed"
>;

export type GenerationContext = Pick<
  TransportTestFixtures,
  "ORIGIN" | "CREDENTIAL" | "respond" | "untimed" | "edgeRateLimitPage"
>;

export type OutcomeContext = Pick<TransportTestFixtures, "ORIGIN" | "CREDENTIAL" | "respond">;

export type TimingContext = Pick<TransportTestFixtures, "ORIGIN" | "CREDENTIAL">;
