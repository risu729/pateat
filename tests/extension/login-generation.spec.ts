import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import {
  beginInput,
  settingsRequest,
  setupProbe,
  setupRequest,
  useOnly,
} from "./connection-fixture";
import { logs } from "./login-fixture";
import { startLoginFixture } from "./login-server";
import { startSyncService } from "./sync-service";
import { withVaultProfile, type VaultBrowser } from "./vault-fixture";
import { sendToBackground as send } from "./background-message";
import type { LoginRecipeDocument } from "../../packages/contracts/src/index";

import { registerRecipeLearning } from "./login-generation-cases/recipe-learning";
import { registerContinuations } from "./login-generation-cases/continuations";
import { registerEntryPages } from "./login-generation-cases/entry-pages";
import { registerLayoutRepair } from "./login-generation-cases/layout-repair";

// The synthetic Bitwarden item stores the URI https://synthetic.example.test/login, the
// username "test_username" and the login password "test_password". The site has no recipe;
// the service generates one with a local stand-in for Claude, so no request reaches
// Anthropic or any real site.
const site = "https://synthetic.example.test";
const username = "test_username";
const password = "test_password";

async function serveSite(context: BrowserContext, fixture: { origin: string }) {
  await context.route(`${site}/**`, async (route) => {
    const url = new URL(route.request().url());
    // A redirect goes to the browser, so the page's URL follows it, as on a real site.
    const response = await route.fetch({
      url: `${fixture.origin}${url.pathname}${url.search}`,
      maxRedirects: 0,
    });
    await route.fulfill({ response });
  });
}

/** `GET /v1/recipes` as these tests read it: each login recipe with its layouts (ADR 0060). */
type RecipeChanges = { changes: { recipe?: LoginRecipeDocument }[] };
/**
 * Gives the probe a 2-second step wait in place of the 10-second one, for a test whose login
 * runs past an advance's wait; the loopback origin is the probe's default.
 */
async function shortenStepWait(options: Page) {
  expect(
    await send(options, {
      version: 1,
      type: "login.probe.configure",
      origin: "http://127.0.0.1:3847",
      stepWaitMs: 2000,
    }),
  ).toMatchObject({ ok: true });
}

/**
 * How long a test waits for a login without a learned completion to settle on the judged
 * signed-in page: the submission's 3-second observation budget runs out, the page is
 * judged, and the sign-in is read again a second later (ADR 0029), about 5 seconds after
 * the page shows, which Playwright's default 5-second poll only just missed or met. The
 * wait ends as soon as the login does.
 */
const SETTLE_MS = 15_000;

type Candidate = { id: string; role: string; target: { by: string; value: string } };
type Prompt = {
  task: string;
  signedIn?: boolean;
  observation: { origin: string; path: string; candidates: Candidate[] };
};

/**
 * Answers the Worker's token exchange and Messages API calls the way Claude would for
 * the fixture pages: fill the password and press "Log in", or on a page without a password
 * input fill the account and press "Next", then mark "Sign out" as the signed-in evidence.
 * A judged page that asks how to verify names its "Select Password." control as the
 * button that goes on to the password (ADR 0048), and an optional page after the sign-in,
 * one with a "Remind me later" button, is `optional` (ADR 0065). The page descriptions it
 * receives, and when each arrived, are recorded.
 */
function syntheticClaude({ abstainOnPassword = false }: { abstainOnPassword?: boolean } = {}) {
  const prompts: Prompt[] = [];
  const times: number[] = [];
  function answer(path: string, payload: string): unknown {
    if (path === "/v1/oauth/token")
      return { access_token: "synthetic-access-token", token_type: "Bearer", expires_in: 600 };
    if (path !== "/v1/messages") throw new Error(`Unexpected Anthropic path ${path}`);
    const body = JSON.parse(payload) as {
      messages: { content: string | { type: string; text?: string }[] }[];
    };
    const texts = body.messages.flatMap((message) =>
      typeof message.content === "string"
        ? [message.content]
        : message.content.flatMap((part) => (part.text === undefined ? [] : [part.text])),
    );
    const prompt = texts
      .map((text) => {
        try {
          return JSON.parse(text) as Prompt;
        } catch {
          return undefined;
        }
      })
      .find((parsed) => parsed?.task !== undefined);
    if (!prompt) throw new Error("No synthetic prompt found");
    prompts.push(prompt);
    times.push(Date.now());
    const byTarget = (value: string, by = "id") => {
      const found = prompt.observation.candidates.find(
        (candidate) => candidate.target.by === by && candidate.target.value === value,
      );
      if (!found) throw new Error(`No candidate for ${by} ${value}`);
      return found.id;
    };
    const hasId = (value: string) =>
      prompt.observation.candidates.some(
        ({ target }) => target.by === "id" && target.value === value,
      );
    // The `script-link` and `script-url` fixtures' login links have no id, so only their
    // text names them, and the `labelled` fixture's submit input only its accessible name;
    // the `redesign` fixture's button is `continue`; only a test attribute names the
    // `identifier-kept` fixture's submit button.
    const hasTest = (value: string) =>
      prompt.observation.candidates.some(
        ({ target }) => target.by === "data-test" && target.value === value,
      );
    const login = () =>
      hasId("login")
        ? byTarget("login")
        : hasTest("button")
          ? byTarget("button", "data-test")
          : hasId("continue")
            ? byTarget("continue")
            : prompt.observation.candidates.some(({ target }) => target.by === "accessible-name")
              ? byTarget("Log in", "accessible-name")
              : byTarget("Log in", "text");
    // The `redesign` fixture names its password input `passcode`.
    const passwordField = hasId("password") ? "password" : hasId("passcode") ? "passcode" : "";
    const passwordPage = passwordField !== "";
    const signedIn = prompt.observation.candidates.some(
      ({ target }) => target.by === "id" && target.value === "sign-out",
    );
    const choice = prompt.observation.candidates.some(
      ({ target }) => target.by === "accessible-name" && target.value === "Select Password.",
    );
    const optional = prompt.observation.candidates.some(
      ({ target }) => target.by === "id" && target.value === "remind-later",
    );
    // The `identifier-kept` fixture's code view asks for the authenticator's code.
    const codePage = hasId("code");
    // A page without a login form (ADR 0031): its "Login" link opens the sign-in page.
    const result =
      prompt.task === "entry"
        ? { decision: "entry", entry: byTarget("Login", "text") }
        : prompt.task !== "generate"
          ? choice
            ? {
                decision: "challenge",
                passwordButton: byTarget("Select Password.", "accessible-name"),
              }
            : codePage
              ? {
                  decision: "challenge",
                  code: {
                    field: byTarget("code"),
                    submit: byTarget("button", "data-test"),
                    source: "authenticator-app",
                  },
                }
              : optional
                ? { decision: "optional" }
                : signedIn
                  ? { decision: "signed-in", marker: byTarget("sign-out") }
                  : prompt.observation.candidates.some(
                        ({ target }) => target.by === "text" && target.value === "My page",
                      )
                    ? // The `link` marker variant's account link has no id, so only its text names it.
                      { decision: "signed-in", marker: byTarget("My page", "text") }
                    : { decision: "rejected" }
          : passwordPage && abstainOnPassword
            ? { decision: "abstain", reason: "ambiguous" }
            : passwordPage
              ? {
                  decision: "plan",
                  pageKind: "sign-in",
                  irreversible: "no",
                  fields: [{ slot: "password", candidate: byTarget(passwordField) }],
                  action: { candidate: login(), purpose: "submit" },
                }
              : {
                  decision: "plan",
                  pageKind: "sign-in",
                  irreversible: "no",
                  // The `identifier-kept` fixture's email input is `email`.
                  fields: [
                    {
                      slot: "username",
                      candidate: hasId("account") ? byTarget("account") : byTarget("email"),
                    },
                  ],
                  // A form that shows no button is submitted after its last field (ADR 0064).
                  action: {
                    candidate: prompt.observation.candidates.some(
                      ({ target }) => target.by === "id" && target.value === "next",
                    )
                      ? byTarget("next")
                      : hasTest("button")
                        ? byTarget("button", "data-test")
                        : byTarget("account"),
                    purpose: "advance",
                  },
                };
    return {
      id: "msg_synthetic",
      type: "message",
      role: "assistant",
      model: "claude-opus-5-5",
      content: [{ type: "text", text: JSON.stringify({ result }) }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 3_000, output_tokens: 900 },
    };
  }
  return { prompts, times, answer };
}

/**
 * Connects the synthetic vault and the loopback service in the profile and returns the
 * options page that sends extension messages.
 */
async function connect(
  browser: VaultBrowser,
  service: Awaited<ReturnType<typeof startSyncService>>,
  variant: "uri" | "uri-totp" = "uri",
): Promise<Page> {
  await setupProbe(browser.page, { action: "configure", variant });
  const options = await browser.context.newPage();
  await options.goto(`chrome-extension://${browser.extensionId}/options.html`);
  const accepted = await setupRequest(options, {
    type: "connection.begin",
    input: beginInput(),
  });
  if (!accepted.ok || accepted.kind !== "ready") throw new Error("Synthetic setup failed");
  // The probe build's demo vaults cannot answer URI queries; leave only Bitwarden.
  const initial = await settingsRequest(options);
  const settings = useOnly(initial.snapshot.settings, initial.catalog, accepted.connectionId);
  const saved = await settingsRequest(options, {
    version: 1,
    type: "settings.save",
    expectedRevision: initial.snapshot.revision,
    settings,
  });
  await browser.background.evaluate(
    async (record) =>
      (
        globalThis as unknown as {
          chrome: { storage: { local: { set(value: unknown): Promise<void> } } };
        }
      ).chrome.storage.local.set({ "pateat.sync-service.v1": record }),
    {
      version: 1,
      kind: "connected",
      origin: service.origin,
      label: "Synthetic test device",
      deviceId: service.deviceId,
      credential: service.credential,
    },
  );
  expect(await send(options, { version: 1, type: "service.get" })).toMatchObject({
    ok: true,
    state: { kind: "connected" },
  });
  // Saving settings syncs at once; the earlier save already scheduled the next one.
  await settingsRequest(options, {
    version: 1,
    type: "settings.save",
    expectedRevision: saved.snapshot.revision,
    settings: saved.snapshot.settings,
  });
  // A paired device uses no vault item until its first settings sync (ADR 0023).
  await expect
    .poll(async () => (await settingsRequest(options)).catalog.settingsSyncPending)
    .toBeUndefined();
  return options;
}

export type { RecipeChanges };

export type LoginGenerationCaseContext = {
  test: typeof test;
  expect: typeof expect;
  startLoginFixture: typeof startLoginFixture;
  startSyncService: typeof startSyncService;
  withVaultProfile: typeof withVaultProfile;
  send: typeof send;
  site: typeof site;
  password: typeof password;
  serveSite: typeof serveSite;
  SETTLE_MS: typeof SETTLE_MS;
  syntheticClaude: typeof syntheticClaude;
  connect: typeof connect;
  username: typeof username;
  shortenStepWait: typeof shortenStepWait;
  logs: typeof logs;
  settingsRequest: typeof settingsRequest;
};

registerRecipeLearning({
  test,
  expect,
  startLoginFixture,
  startSyncService,
  withVaultProfile,
  send,
  site,
  password,
  serveSite,
  SETTLE_MS,
  syntheticClaude,
  connect,
});

registerContinuations({
  test,
  expect,
  startLoginFixture,
  startSyncService,
  withVaultProfile,
  send,
  site,
  password,
  serveSite,
  SETTLE_MS,
  syntheticClaude,
  connect,
  username,
  shortenStepWait,
  logs,
  settingsRequest,
});

registerEntryPages({
  test,
  expect,
  startLoginFixture,
  startSyncService,
  withVaultProfile,
  send,
  site,
  password,
  serveSite,
  SETTLE_MS,
  syntheticClaude,
  connect,
  username,
});

registerLayoutRepair({
  test,
  expect,
  startLoginFixture,
  startSyncService,
  withVaultProfile,
  send,
  site,
  password,
  serveSite,
  syntheticClaude,
  connect,
});
