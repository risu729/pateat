import type { test, expect, Page, Worker } from "@playwright/test";
import type { logs, withStoppedLoginWorker, withLoginExtension } from "../login-fixture";
import type { startLoginFixture } from "../login-server";
import type { sendToBackground } from "../background-message";

export type ProbeChrome = {
  tabs: { create: (options: { url: string; active: boolean }) => Promise<{ id: number }> };
  storage: {
    local: {
      get: (key: string) => Promise<Record<string, unknown>>;
      set: (values: Record<string, unknown>) => Promise<void>;
    };
  };
};

export type LoginCaseContext = {
  test: typeof test;
  expect: typeof expect;
  logs: typeof logs;
  withStoppedLoginWorker: typeof withStoppedLoginWorker;
  withLoginExtension: typeof withLoginExtension;
  startLoginFixture: typeof startLoginFixture;
  send: typeof sendToBackground;
  configure: (
    options: Page,
    extensionId: string,
    origin: string,
    selectAccount?: boolean,
    passkey?: "discoverable" | "second-factor",
    totp?: boolean,
    stepWaitMs?: number,
  ) => Promise<void>;
  inactiveTab: (worker: Worker, url: string) => Promise<{ id: number }>;
  stateLogs: (worker: Worker) => ReturnType<typeof logs>;
  checkedAgain: (options: Page, count: number) => Promise<void>;
  SHORT_STEP_WAIT_MS: 2000;
  clicks: (page: Page) => Promise<number>;
  control: (
    options: Page,
    checkpoint: "before-delivery" | "before-ack" | "intent-write-failure",
  ) => Promise<void>;
  mutations: (page: Page) => Promise<number>;
  observeInputEffects: (
    page: Page,
    fixture: Awaited<ReturnType<typeof startLoginFixture>>,
    runId: string,
    count: number,
  ) => Promise<void>;
  expectWatchingWithoutAttempt: (options: Page) => Promise<void>;
  expectInputOutcome: (
    options: Page,
    result: "authenticated" | "credential-rejected" | "unknown-submit",
  ) => Promise<void>;
  choiceEvidence: (page: Page) => Promise<{
    identityClicks: number;
    chooseClicks: number;
    mobileClicks: number;
    submitClicks: number;
    identityMatched: string | null;
    passwordMatched: string | null;
  }>;
  codeEvidence: (page: Page) => Promise<{
    codeInputs: number;
    verifyClicks: number;
    autoSubmits: number;
    codeMatched: string | null;
  }>;
};
