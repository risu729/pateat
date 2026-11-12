import { test, expect, type Page, type Worker } from "@playwright/test";
import type { SettingsResponse } from "../../packages/contracts/src/index";
import { logs, withStoppedLoginWorker, withLoginExtension } from "./login-fixture";
import { startLoginFixture } from "./login-server";
import { sendToBackground as send } from "./background-message";
import { registerInputEffects } from "./login-cases/input-effects";
import { registerPrimaryLogin } from "./login-cases/primary-login";
import { registerMethodChoice } from "./login-cases/method-choice";
import { registerCodes } from "./login-cases/codes";
import { registerForms } from "./login-cases/forms";
import { registerLifecycle } from "./login-cases/lifecycle";
import { registerFailureSigns } from "./login-cases/failure-signs";
import type { ProbeChrome } from "./login-cases/context";

async function configure(
  options: Page,
  extensionId: string,
  origin: string,
  selectAccount = true,
  passkey?: "discoverable" | "second-factor",
  totp = false,
  /** The probe's step wait in place of the 10-second one, for a test that runs past it. */
  stepWaitMs?: number,
) {
  await options.goto(`chrome-extension://${extensionId}/options.html`);
  await expect(options.locator("#settings-status")).toContainText("Saved settings loaded");
  expect(
    await send(options, {
      version: 1,
      type: "login.probe.configure",
      origin,
      ...(passkey ? { passkey } : {}),
      ...(totp ? { totp: true } : {}),
      ...(stepWaitMs === undefined ? {} : { stepWaitMs }),
    }),
  ).toMatchObject({ ok: true });
  const response = (await send(options, { version: 1, type: "settings.get" })) as SettingsResponse;
  if (!response.ok) throw new Error("Synthetic settings unavailable");
  const settings = response.snapshot.settings;
  settings.siteDefaults = selectAccount
    ? [
        {
          origin,
          provider: "dummy",
          server: "cloud-us",
          userId: "demo-personal-account",
          itemId: "primary",
        },
      ]
    : [];
  const saved = (await send(options, {
    version: 1,
    type: "settings.save",
    expectedRevision: response.snapshot.revision,
    settings,
  })) as SettingsResponse;
  expect(saved.ok).toBe(true);
}

async function inactiveTab(worker: Worker, url: string) {
  return worker.evaluate(async (targetUrl) => {
    const chrome = (globalThis as unknown as { chrome: ProbeChrome }).chrome;
    return await chrome.tabs.create({ url: targetUrl, active: false });
  }, url);
}

/** The fields of the local log's `login.state` entries. */
const stateLogs = (worker: Worker) => logs(worker, "login.state");

/** How many observations of its documents' pages the logins got back, from the probe's status. */
async function observations(options: Page): Promise<number> {
  const status = (await send(options, { version: 1, type: "login.probe.status" })) as {
    documents: { observations?: number }[];
  };
  return status.documents.reduce((sum, entry) => sum + (entry.observations ?? 0), 0);
}

/** Waits until the logins checked their pages `count` more times. */
async function checkedAgain(options: Page, count: number) {
  const before = await observations(options);
  await expect.poll(() => observations(options)).toBeGreaterThanOrEqual(before + count);
}

/**
 * A step wait for the probe, in place of the 10-second one, for tests that run past it: long
 * enough for the pages of those tests to show their next view within it.
 */
const SHORT_STEP_WAIT_MS = 2000;

async function clicks(page: Page) {
  return page.evaluate(() => Number(sessionStorage.getItem("submitClicks") || 0));
}

async function control(
  options: Page,
  checkpoint: "before-delivery" | "before-ack" | "intent-write-failure",
) {
  expect(
    await send(options, {
      version: 1,
      type: "login.probe.control",
      action: "arm",
      checkpoint,
    }),
  ).toMatchObject({ ok: true });
}

async function mutations(page: Page) {
  return page.evaluate(
    () => (globalThis as unknown as { syntheticMutations: number }).syntheticMutations,
  );
}

async function observeInputEffects(
  page: Page,
  fixture: Awaited<ReturnType<typeof startLoginFixture>>,
  runId: string,
  count: number,
) {
  // A restored unknown outcome can be published before async reconciliation starts.
  // Cover its full three-second observation budget before making negative assertions.
  const until = Date.now() + 4000;
  /* eslint-disable no-await-in-loop */
  while (Date.now() < until) {
    expect(fixture.evidence(runId)).toEqual({
      posts: count,
      inputPosts: count,
      clickPosts: 0,
      allMatched: true,
    });
    expect(await mutations(page)).toBe(count);
    await new Promise<void>((finish) => setTimeout(finish, 50));
  }
  /* eslint-enable no-await-in-loop */
}

async function expectWatchingWithoutAttempt(options: Page) {
  await expect
    .poll(async () => await send(options, { version: 1, type: "login.probe.status" }))
    .toMatchObject({ attempts: [], documents: [{ state: "watching" }] });
  // Cover several watch checks before the negative assertions.
  await options.waitForTimeout(1000);
  expect(await send(options, { version: 1, type: "login.probe.status" })).toMatchObject({
    attempts: [],
    documents: [{ state: "watching" }],
  });
}

async function expectInputOutcome(
  options: Page,
  result: "authenticated" | "credential-rejected" | "unknown-submit",
) {
  // A rejected login is released at once, and the tab asks for an account (ADR 0021 D).
  if (result === "credential-rejected") {
    await expect
      .poll(async () => await send(options, { version: 1, type: "login.probe.status" }))
      .toMatchObject({ attempts: [], asks: ["rejected"] });
    // The released page announced again and was refused while the tab asks: it never logs
    // in again.
    await expect
      .poll(async () => await send(options, { version: 1, type: "login.probe.status" }))
      .toMatchObject({ documents: [{ state: "denied", reason: "account-asked" }] });
    expect(await send(options, { version: 1, type: "login.probe.status" })).toMatchObject({
      attempts: [],
      asks: ["rejected"],
    });
    return;
  }
  await expect
    .poll(async () => await send(options, { version: 1, type: "login.probe.status" }))
    .toMatchObject({
      attempts: [
        {
          state: result === "authenticated" ? "authenticated" : "reconciling",
          outcome: result,
          operationKind: "fill",
          submissions: 1,
        },
      ],
    });
}

registerInputEffects({
  test,
  expect,
  withStoppedLoginWorker,
  withLoginExtension,
  startLoginFixture,
  send,
  configure,
  clicks,
  control,
  mutations,
  observeInputEffects,
  expectWatchingWithoutAttempt,
  expectInputOutcome,
});

registerPrimaryLogin({
  test,
  expect,
  withLoginExtension,
  startLoginFixture,
  send,
  configure,
  inactiveTab,
  clicks,
});

/** What the `/method-choice` fixture page counted; never a value. */
async function choiceEvidence(page: Page) {
  return page.evaluate(() => ({
    identityClicks: Number(sessionStorage.getItem("identityClicks") || 0),
    chooseClicks: Number(sessionStorage.getItem("chooseClicks") || 0),
    mobileClicks: Number(sessionStorage.getItem("mobileClicks") || 0),
    submitClicks: Number(sessionStorage.getItem("submitClicks") || 0),
    identityMatched: sessionStorage.getItem("identityMatched"),
    passwordMatched: sessionStorage.getItem("passwordMatched"),
  }));
}

registerMethodChoice({
  test,
  expect,
  logs,
  withLoginExtension,
  startLoginFixture,
  send,
  configure,
  stateLogs,
  SHORT_STEP_WAIT_MS,
  choiceEvidence,
});

/**
 * What the synthetic code page recorded: counts and whether the code matched, never the
 * code. A typed code sends one input event per digit.
 */
async function codeEvidence(page: Page) {
  return page.evaluate(() => ({
    codeInputs: Number(sessionStorage.getItem("codeInputs") || 0),
    verifyClicks: Number(sessionStorage.getItem("verifyClicks") || 0),
    autoSubmits: Number(sessionStorage.getItem("autoSubmits") || 0),
    codeMatched: sessionStorage.getItem("codeMatched"),
  }));
}

registerCodes({
  test,
  expect,
  logs,
  withLoginExtension,
  startLoginFixture,
  send,
  configure,
  checkedAgain,
  SHORT_STEP_WAIT_MS,
  clicks,
  codeEvidence,
});

registerForms({
  test,
  expect,
  logs,
  withLoginExtension,
  startLoginFixture,
  send,
  configure,
  SHORT_STEP_WAIT_MS,
  clicks,
  expectWatchingWithoutAttempt,
});

registerLifecycle({
  test,
  expect,
  withLoginExtension,
  startLoginFixture,
  send,
  configure,
  checkedAgain,
  SHORT_STEP_WAIT_MS,
  clicks,
  expectWatchingWithoutAttempt,
});

registerFailureSigns({
  test,
  expect,
  logs,
  withLoginExtension,
  startLoginFixture,
  send,
  configure,
  stateLogs,
  clicks,
  codeEvidence,
});
