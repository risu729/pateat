import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { beginInput, settingsRequest, setupProbe, setupRequest } from "./connection-fixture";
import { logs } from "./login-fixture";
import { startLoginFixture } from "./login-server";
import { startSyncService } from "./sync-service";
import { withVaultProfile, type VaultBrowser } from "./vault-fixture";
import { sendToBackground as send } from "./background-message";
import type { LoginRecipeDocument } from "../../packages/contracts/src/index";

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
  observation: { path: string; candidates: Candidate[] };
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
    // The `script-link` and `script-url` fixtures' login links have no id, so only their
    // text names them.
    const login = () =>
      prompt.observation.candidates.some(
        ({ target }) => target.by === "id" && target.value === "login",
      )
        ? byTarget("login")
        : byTarget("Log in", "text");
    const passwordPage = prompt.observation.candidates.some(
      ({ target }) => target.by === "id" && target.value === "password",
    );
    const signedIn = prompt.observation.candidates.some(
      ({ target }) => target.by === "id" && target.value === "sign-out",
    );
    const choice = prompt.observation.candidates.some(
      ({ target }) => target.by === "accessible-name" && target.value === "Select Password.",
    );
    const optional = prompt.observation.candidates.some(
      ({ target }) => target.by === "id" && target.value === "remind-later",
    );
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
                  fields: [{ slot: "password", candidate: byTarget("password") }],
                  action: { candidate: login(), purpose: "submit" },
                }
              : {
                  decision: "plan",
                  pageKind: "sign-in",
                  irreversible: "no",
                  fields: [{ slot: "username", candidate: byTarget("account") }],
                  // A form that shows no button is submitted after its last field (ADR 0064).
                  action: {
                    candidate: prompt.observation.candidates.some(
                      ({ target }) => target.by === "id" && target.value === "next",
                    )
                      ? byTarget("next")
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
): Promise<Page> {
  await setupProbe(browser.page, { action: "configure", variant: "uri" });
  const options = await browser.context.newPage();
  await options.goto(`chrome-extension://${browser.extensionId}/options.html`);
  const accepted = await setupRequest(options, {
    type: "connection.begin",
    input: beginInput(),
  });
  if (!accepted.ok || accepted.kind !== "ready") throw new Error("Synthetic setup failed");
  // The probe build's demo vaults cannot answer URI queries; leave only Bitwarden.
  const initial = await settingsRequest(options);
  const settings = initial.snapshot.settings;
  settings.connections = settings.connections.map((entry) => ({
    ...entry,
    enabled: entry.connectionId === accepted.connectionId,
  }));
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
  return options;
}

for (const [button, marker] of [
  ["button", "button"],
  ["anchor", "button"],
  ["script-link", "button"],
  ["script-url", "button"],
  ["button", "link"],
] as const)
  test(`a login page without a recipe is generated on the service, logs in and learns its completion (${button}, ${marker} marker)`, async () => {
    const fixture = await startLoginFixture(0, { password });
    const claude = syntheticClaude();
    const service = await startSyncService({ claude: claude.answer });
    try {
      await withVaultProfile(
        async (open, externalRequests) => {
          const browser = await open();
          await serveSite(browser.context, fixture);
          const options = await connect(browser, service);

          const runId = fixture.createRun();
          const page = await browser.context.newPage();
          await page.goto(`${site}/sign-in?runId=${runId}&button=${button}&marker=${marker}`);
          await expect(page.locator("#signed-in")).toBeVisible();
          expect(fixture.evidence(runId)).toEqual({
            posts: 1,
            inputPosts: 0,
            clickPosts: 1,
            allMatched: true,
          });
          // The attempt settles on the judgement of the page after the submission.
          await expect
            .poll(() => send(options, { version: 1, type: "login.probe.status" }), {
              timeout: SETTLE_MS,
            })
            .toMatchObject({
              attempts: [{ state: "authenticated", outcome: "authenticated", submissions: 1 }],
            });
          // The service sent the login page without values, then the signed-in page.
          expect(claude.prompts.map((prompt) => [prompt.task, prompt.observation.path])).toEqual([
            ["generate", "/sign-in"],
            ["judge-sign-in", "/account"],
          ]);
          // The sign-in page went out with the hint that it shows no one signed in, and its
          // recipe is stored as a sign-in page (ADR 0035).
          expect(claude.prompts[0]).toMatchObject({ signedIn: false });
          expect(JSON.stringify(claude.prompts)).not.toContain(password);
          // The judgement learned the marker into the recipe's one layout.
          const recipes = (await (await service.request("/v1/recipes")).json()) as RecipeChanges;
          expect(recipes.changes.map((change) => change.recipe)).toMatchObject([
            {
              revision: 2,
              layouts: [
                {
                  pageKind: "sign-in",
                  completion: [
                    {
                      target:
                        marker === "link"
                          ? { by: "text", value: "My page" }
                          : { by: "id", value: "sign-out" },
                    },
                  ],
                },
              ],
            },
          ]);

          // The next visit runs the stored recipe and its learned completion with no model call.
          // A settled attempt holds the origin while its tab stays open.
          await page.close();
          const again = fixture.createRun();
          const next = await browser.context.newPage();
          await next.goto(`${site}/sign-in?runId=${again}&button=${button}&marker=${marker}`);
          await expect(next.locator("#signed-in")).toBeVisible();
          expect(fixture.evidence(again)).toMatchObject({ posts: 1, allMatched: true });
          // The learned marker alone proves the sign-in, even a link named by its text.
          await expect
            .poll(() => send(options, { version: 1, type: "login.probe.status" }))
            .toMatchObject({
              attempts: [{ state: "authenticated", outcome: "authenticated", submissions: 1 }],
            });
          expect(claude.prompts).toHaveLength(2);
          // Only the routed site and the loopback service were contacted by the browser.
          expect([...new Set(externalRequests)].sort()).toEqual(["https://127.0.0.1", site]);
        },
        { args: ["--ignore-certificate-errors"] },
      );
    } finally {
      await service.close();
      await fixture.close();
    }
  });

for (const { name, prefix, tenants } of [
  {
    name: "tenant UUID",
    prefix: "",
    tenants: ["123e4567-e89b-12d3-a456-426614174000", "89abcdef-0123-4567-89ab-cdef01234567"],
  },
  {
    name: "opaque authorization server ID",
    prefix: "/oauth2",
    tenants: ["aus1a2b3c4d5e6f7g8h9", "aus9h8g7f6e5d4c3b2a1"],
  },
]) {
  test(`a ${name} is redacted during generation and a second ID reuses the recipe (ADR 0039)`, async () => {
    const fixture = await startLoginFixture(0, { password });
    const claude = syntheticClaude();
    const service = await startSyncService({ claude: claude.answer });
    const paths = tenants.map((tenant) => `${prefix}/${tenant}/sign-in`);
    const redactedPath = `${prefix}/[id]/sign-in`;
    try {
      await withVaultProfile(
        async (open, externalRequests) => {
          const browser = await open();
          await browser.context.route(`${site}/**`, async (route) => {
            const url = new URL(route.request().url());
            const path = paths.includes(url.pathname) ? "/sign-in" : url.pathname;
            const response = await route.fetch({ url: `${fixture.origin}${path}${url.search}` });
            await route.fulfill({ response });
          });
          const options = await connect(browser, service);

          const runId = fixture.createRun();
          const page = await browser.context.newPage();
          await page.goto(`${site}${paths[0]}?runId=${runId}`);
          await expect(page.locator("#signed-in")).toBeVisible();
          expect(fixture.evidence(runId)).toMatchObject({ posts: 1, allMatched: true });
          await expect
            .poll(() => send(options, { version: 1, type: "login.probe.status" }), {
              timeout: SETTLE_MS,
            })
            .toMatchObject({ attempts: [{ state: "authenticated", outcome: "authenticated" }] });
          // The tenant's ID never leaves the device: the page goes with `[id]` in its place.
          expect(claude.prompts.map((prompt) => [prompt.task, prompt.observation.path])).toEqual([
            ["generate", redactedPath],
            ["judge-sign-in", "/account"],
          ]);
          expect(JSON.stringify(claude.prompts)).not.toContain(tenants[0]);
          expect(JSON.stringify(claude.prompts)).not.toContain(password);
          expect(await service.generationAttempts()).toEqual([
            { path: redactedPath, base_revision: 0 },
          ]);
          const recipes = (await (await service.request("/v1/recipes")).json()) as RecipeChanges;
          expect(recipes.changes.map((change) => change.recipe)).toMatchObject([
            {
              layouts: [
                {
                  steps: [
                    { kind: "fill", path: redactedPath },
                    { kind: "click", path: redactedPath },
                  ],
                },
              ],
            },
          ]);

          // Another tenant's page runs the stored recipe, its steps' path checks passing on
          // the other ID, with no model call.
          await page.close();
          const again = fixture.createRun();
          const next = await browser.context.newPage();
          await next.goto(`${site}${paths[1]}?runId=${again}`);
          await expect(next.locator("#signed-in")).toBeVisible();
          expect(fixture.evidence(again)).toMatchObject({ posts: 1, allMatched: true });
          expect(claude.prompts).toHaveLength(2);
          for (const tenant of tenants) {
            expect(JSON.stringify(claude.prompts)).not.toContain(tenant);
            expect(JSON.stringify(recipes)).not.toContain(tenant);
          }
          expect([...new Set(externalRequests)].sort()).toEqual(["https://127.0.0.1", site]);
        },
        { args: ["--ignore-certificate-errors"] },
      );
    } finally {
      await service.close();
      await fixture.close();
    }
  });
}

for (const { name, start, query, passwordPath } of [
  // Next hides the account form and shows the password form on the same path.
  {
    name: "same document",
    start: "/identifier-first",
    query: "?account",
    passwordPath: "/identifier-first",
  },
  // Next keeps the account form, with a hidden password input for the browser to fill,
  // while it looks the account up, then swaps the password form in on the same path.
  {
    name: "view swapped after a lookup",
    start: "/identifier-first",
    query: "?account&prefill",
    passwordPath: "/identifier-first",
  },
  // Next opens the password page as a new document on another path.
  { name: "new document", start: "/identifier", query: "", passwordPath: "/identifier/password" },
  // The account input is marked only for an email address: the page is offered once the
  // offer wait ends (ADR 0016, ADR 0057). The ADR 0031 identifier-page case covers an input named
  // only `login`.
  {
    name: "email input",
    start: "/identifier",
    query: "?email",
    passwordPath: "/identifier/password",
  },
  // The form shows no Next button until the account is typed, beside a "Use phone" button:
  // the plan's action is the account field, and Enter in it submits the form (ADR 0064).
  {
    name: "form without a button",
    start: "/identifier",
    query: "?no-button",
    passwordPath: "/identifier/password",
  },
])
  test(`a generated identifier page is continued on the password page it leads to (${name}, ADR 0018)`, async () => {
    const noButton = query === "?no-button";
    // An identifier input without `autocomplete="username"` waits for the offer wait.
    test.setTimeout(90_000);
    const fixture = await startLoginFixture(0, { password, accountName: username });
    const claude = syntheticClaude();
    const service = await startSyncService({ claude: claude.answer });
    try {
      await withVaultProfile(
        async (open, externalRequests) => {
          const browser = await open();
          await serveSite(browser.context, fixture);
          const options = await connect(browser, service);

          const page = await browser.context.newPage();
          await page.goto(`${site}${start}${query}`);
          // The account and the password both matched, after one Next and one Log in.
          await expect(page.locator("#signed-in")).toBeVisible({ timeout: 60_000 });
          await expect
            .poll(() => send(options, { version: 1, type: "login.probe.status" }), {
              timeout: SETTLE_MS,
            })
            .toMatchObject({
              attempts: [{ state: "authenticated", outcome: "authenticated", submissions: 2 }],
            });
          // The identifier page, then the password page continuing that recipe, then the
          // signed-in page; never a value.
          expect(claude.prompts.map((prompt) => [prompt.task, prompt.observation.path])).toEqual([
            ["generate", start],
            ["generate", passwordPath],
            ["judge-sign-in", "/account"],
          ]);
          expect(JSON.stringify(claude.prompts)).not.toContain(password);
          expect(JSON.stringify(claude.prompts)).not.toContain(username);
          // One Next and one Log in; the password page continued revision 1.
          expect(await page.locator("#fixture-status").textContent()).toContain(
            "Identity clicks: 1; Submit clicks: 1",
          );
          expect(await service.generationAttempts()).toEqual([
            { path: start, base_revision: 0 },
            { path: passwordPath, base_revision: 1 },
          ]);
          // The continuation and the marker were both written into the one layout.
          const recipes = (await (await service.request("/v1/recipes")).json()) as RecipeChanges;
          expect(recipes.changes.map((change) => change.recipe)).toMatchObject([
            {
              revision: 3,
              layouts: [
                {
                  steps: [
                    { kind: "fill", path: start },
                    {
                      kind: "click",
                      path: start,
                      purpose: "advance",
                      ...(noButton
                        ? { target: { by: "id", value: "account" }, press: "enter" }
                        : {}),
                    },
                    { kind: "fill", path: passwordPath },
                    { kind: "click", path: passwordPath, purpose: "submit" },
                  ],
                  completion: [{ target: { by: "id", value: "sign-out" } }],
                },
              ],
            },
          ]);
          // The "Use phone" button beside the account was never pressed.
          expect(await page.evaluate(() => sessionStorage.getItem("phoneClicks"))).toBeNull();

          // The next visit runs all four steps of the stored recipe with no model call.
          await page.close();
          const next = await browser.context.newPage();
          await next.goto(`${site}${start}${query}`);
          // The password fill waits for the page to settle before its account check.
          await expect(next.locator("#signed-in")).toBeVisible({ timeout: 10_000 });
          expect(claude.prompts).toHaveLength(3);
          expect([...new Set(externalRequests)].sort()).toEqual(["https://127.0.0.1", site]);
        },
        { args: ["--ignore-certificate-errors"] },
      );
    } finally {
      await service.close();
      await fixture.close();
    }
  });

test("an optional page after the sign-in completes the login as signed in, presses nothing and learns no marker there (ADR 0065)", async () => {
  test.setTimeout(120_000);
  const fixture = await startLoginFixture(0, { password });
  const claude = syntheticClaude();
  const service = await startSyncService({ claude: claude.answer });
  try {
    await withVaultProfile(
      async (open) => {
        const browser = await open();
        await serveSite(browser.context, fixture);
        const options = await connect(browser, service);
        const clicks = (page: Page) =>
          page.evaluate(() => ({
            submitClicks: Number(sessionStorage.getItem("submitClicks") || 0),
            verifyClicks: Number(sessionStorage.getItem("verifyClicks") || 0),
            laterClicks: Number(sessionStorage.getItem("laterClicks") || 0),
          }));
        const signedIn = () =>
          expect
            .poll(() => send(options, { version: 1, type: "login.probe.status" }), {
              timeout: 30_000,
            })
            .toMatchObject({
              attempts: [{ state: "authenticated", outcome: "authenticated", handlers: [] }],
            });
        const unconfirmed = async () =>
          (
            (await send(options, { version: 1, type: "login.probe.status" })) as {
              attempts: { unconfirmed?: true }[];
            }
          ).attempts[0]?.unconfirmed;
        const recipe = async () =>
          (
            (await (await service.request("/v1/recipes")).json()) as {
              changes: { recipe?: { handlers?: unknown; completion?: unknown } }[];
            }
          ).changes.map((change) => change.recipe);

        const page = await browser.context.newPage();
        await page.goto(`${site}/sign-in?optional`);
        // The password goes in and /checkup is judged optional: the login ends there as
        // signed in, and the page stays as it is.
        await expect(page.locator("#optional-page")).toBeVisible({ timeout: 60_000 });
        await signedIn();
        expect(await unconfirmed()).toBeUndefined();
        expect(await clicks(page)).toEqual({ submitClicks: 1, verifyClicks: 0, laterClicks: 0 });
        expect(new URL(page.url()).pathname).toBe("/checkup");
        expect(claude.prompts.map((prompt) => [prompt.task, prompt.observation.path])).toEqual([
          ["generate", "/sign-in"],
          ["judge-sign-in", "/checkup"],
        ]);
        expect(JSON.stringify(claude.prompts)).not.toContain(password);
        // Nothing is learned on the optional page.
        const [learned] = await recipe();
        expect(learned).not.toHaveProperty("completion");
        expect(learned).not.toHaveProperty("handlers");

        // The next login that meets it is judged again, as the path may ask for a step
        // then, and completes the same way.
        await page.close();
        const next = await browser.context.newPage();
        await next.goto(`${site}/sign-in?optional`);
        await expect(next.locator("#optional-page")).toBeVisible({ timeout: 30_000 });
        await signedIn();
        expect(await unconfirmed()).toBeUndefined();
        expect(await clicks(next)).toEqual({ submitClicks: 1, verifyClicks: 0, laterClicks: 0 });
        expect(claude.prompts.map((prompt) => prompt.observation.path)).toEqual([
          "/sign-in",
          "/checkup",
          "/checkup",
        ]);

        // A login that reaches the usual signed-in page learns its marker there.
        await next.close();
        const usual = await browser.context.newPage();
        await usual.goto(`${site}/sign-in`);
        await expect(usual.locator("#signed-in")).toBeVisible({ timeout: 30_000 });
        await signedIn();
        expect(claude.prompts.map((prompt) => prompt.observation.path).at(-1)).toBe("/account");
        await expect
          .poll(recipe)
          .toMatchObject([{ completion: [{ target: { by: "id", value: "sign-out" } }] }]);
      },
      { args: ["--ignore-certificate-errors"] },
    );
  } finally {
    await service.close();
    await fixture.close();
  }
});

test("a generated identifier page learns the password choice, presses it and continues on the password form it shows (ADR 0048)", async () => {
  test.setTimeout(90_000);
  const fixture = await startLoginFixture(0, { password, accountName: username });
  const claude = syntheticClaude();
  const service = await startSyncService({ claude: claude.answer });
  try {
    await withVaultProfile(
      async (open) => {
        const browser = await open();
        await serveSite(browser.context, fixture);
        const options = await connect(browser, service);
        // The choice page is judged once the advance's wait ran out.
        await shortenStepWait(options);

        const page = await browser.context.newPage();
        await page.goto(`${site}/method-choice-named?account&rerender`);
        // Next shows the choice; the learned handler presses "Select Password.", whose
        // password form shows in the same document on the same path. That page is sent to
        // continue the recipe, and the running login types the password and logs in.
        await expect(page.locator("#signed-in")).toBeVisible({ timeout: 60_000 });
        expect(
          await page.evaluate(() => ({
            identityClicks: Number(sessionStorage.getItem("identityClicks") || 0),
            chooseClicks: Number(sessionStorage.getItem("chooseClicks") || 0),
            mobileClicks: Number(sessionStorage.getItem("mobileClicks") || 0),
            submitClicks: Number(sessionStorage.getItem("submitClicks") || 0),
            identityMatched: sessionStorage.getItem("identityMatched"),
            passwordMatched: sessionStorage.getItem("passwordMatched"),
          })),
        ).toEqual({
          identityClicks: 1,
          chooseClicks: 1,
          mobileClicks: 0,
          submitClicks: 1,
          identityMatched: "true",
          passwordMatched: "true",
        });
        await expect
          .poll(() => send(options, { version: 1, type: "login.probe.status" }), {
            timeout: SETTLE_MS,
          })
          .toMatchObject({
            attempts: [
              {
                state: "authenticated",
                outcome: "authenticated",
                handlers: [{ index: 0, start: 2 }],
                submissions: 3,
              },
            ],
          });
        // The identifier page, the choice judged under revision 1, the password form after
        // the press continuing revision 2, then the signed-in page; never a value.
        expect(claude.prompts.map((prompt) => [prompt.task, prompt.observation.path])).toEqual([
          ["generate", "/method-choice-named"],
          ["judge-sign-in", "/method-choice-named"],
          ["generate", "/method-choice-named"],
          ["judge-sign-in", "/account"],
        ]);
        expect(JSON.stringify(claude.prompts)).not.toContain(password);
        expect(JSON.stringify(claude.prompts)).not.toContain(username);
        expect(await service.generationAttempts()).toEqual([
          { path: "/method-choice-named", base_revision: 0 },
          { path: "/method-choice-named", base_revision: 2 },
        ]);
      },
      { args: ["--ignore-certificate-errors"] },
    );
  } finally {
    await service.close();
    await fixture.close();
  }
});

test("a login whose saved binding names only the username takes over the continuation after the password choice and widens the binding (ADR 0027)", async () => {
  test.setTimeout(120_000);
  const fixture = await startLoginFixture(0, { password, accountName: username });
  const claude = syntheticClaude();
  const service = await startSyncService({ claude: claude.answer });
  try {
    await withVaultProfile(
      async (open) => {
        const browser = await open();
        await serveSite(browser.context, fixture);
        const options = await connect(browser, service);
        // The choice page is judged once the advance's wait ran out.
        await shortenStepWait(options);

        // As after an earlier sign-in that the person finished by hand while the login
        // was watched (ADR 0027): the site default and a binding of the recipe that names
        // only the username slot, which revision 1 fills.
        const current = await settingsRequest(options);
        const enabled = current.snapshot.settings.connections.find((entry) => entry.enabled)!;
        const connection = current.catalog.connections.find(
          (entry) => entry.id === enabled.connectionId,
        )!;
        const item = connection.items[0]!;
        const digest = await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(JSON.stringify([site, "/method-choice-named"])),
        );
        const recipeId = `gen-${Buffer.from(digest).toString("hex").slice(0, 32)}`;
        const owner = {
          origin: site,
          provider: connection.provider,
          userId: connection.userId!,
          itemId: item.id,
          itemName: item.label,
        };
        const settings = structuredClone(current.snapshot.settings);
        settings.siteDefaults.push(owner);
        settings.bindings.push({
          ...owner,
          recipeId,
          slots: [{ slot: "username", field: "username" }],
        });
        await settingsRequest(options, {
          version: 1,
          type: "settings.save",
          expectedRevision: current.snapshot.revision,
          settings,
        });
        const page = await browser.context.newPage();
        await page.goto(`${site}/method-choice-named?account&rerender`);
        // Next shows the choice; the learned handler presses "Select Password.", whose
        // password form shows in the same document on the same path. That page is sent to
        // continue the recipe, and the running login types the password and logs in.
        await expect(page.locator("#signed-in")).toBeVisible({ timeout: 60_000 });
        expect(
          await page.evaluate(() => ({
            identityClicks: Number(sessionStorage.getItem("identityClicks") || 0),
            chooseClicks: Number(sessionStorage.getItem("chooseClicks") || 0),
            mobileClicks: Number(sessionStorage.getItem("mobileClicks") || 0),
            submitClicks: Number(sessionStorage.getItem("submitClicks") || 0),
            identityMatched: sessionStorage.getItem("identityMatched"),
            passwordMatched: sessionStorage.getItem("passwordMatched"),
          })),
        ).toEqual({
          identityClicks: 1,
          chooseClicks: 1,
          mobileClicks: 0,
          submitClicks: 1,
          identityMatched: "true",
          passwordMatched: "true",
        });
        await expect
          .poll(() => send(options, { version: 1, type: "login.probe.status" }), {
            timeout: SETTLE_MS,
          })
          .toMatchObject({
            attempts: [
              {
                state: "authenticated",
                outcome: "authenticated",
                handlers: [{ index: 0, start: 2 }],
                submissions: 3,
              },
            ],
          });
        // The identifier page, the choice judged under revision 1, the password form after
        // the press continuing revision 2, then the signed-in page; never a value.
        expect(claude.prompts.map((prompt) => [prompt.task, prompt.observation.path])).toEqual([
          ["generate", "/method-choice-named"],
          ["judge-sign-in", "/method-choice-named"],
          ["generate", "/method-choice-named"],
          ["judge-sign-in", "/account"],
        ]);
        expect(JSON.stringify(claude.prompts)).not.toContain(password);
        expect(JSON.stringify(claude.prompts)).not.toContain(username);
        expect(await service.generationAttempts()).toEqual([
          { path: "/method-choice-named", base_revision: 0 },
          { path: "/method-choice-named", base_revision: 2 },
        ]);
        // The saved binding keeps its username entry and gains the password the login
        // filled (ADR 0027, amended 2026-10-19); the site default stays the same account.
        // A settings sync may name either after this device's connection.
        await expect
          .poll(async () => (await settingsRequest(options)).snapshot.settings.bindings)
          .toEqual([
            expect.objectContaining({
              ...owner,
              recipeId,
              slots: [
                { slot: "username", field: "username" },
                { slot: "password", field: "password" },
              ],
            }),
          ]);
        expect((await settingsRequest(options)).snapshot.settings.siteDefaults).toEqual([
          expect.objectContaining(owner),
        ]);

        // The next visit plans the stored recipe with the widened binding from its start and
        // signs in without a model call.
        await page.close();
        const next = await browser.context.newPage();
        await next.goto(`${site}/method-choice-named?account&rerender`);
        await expect(next.locator("#signed-in")).toBeVisible({ timeout: 60_000 });
        expect(
          await next.evaluate(() => ({
            submitClicks: Number(sessionStorage.getItem("submitClicks") || 0),
            passwordMatched: sessionStorage.getItem("passwordMatched"),
          })),
        ).toEqual({ submitClicks: 1, passwordMatched: "true" });
        expect(claude.prompts).toHaveLength(4);
      },
      { args: ["--ignore-certificate-errors"] },
    );
  } finally {
    await service.close();
    await fixture.close();
  }
});
test("an identifier form shown again where it posted is never continued (ADR 0018)", async () => {
  const fixture = await startLoginFixture(0, { password, accountName: username });
  const claude = syntheticClaude();
  const service = await startSyncService({ claude: claude.answer });
  try {
    await withVaultProfile(
      async (open, externalRequests) => {
        const browser = await open();
        await serveSite(browser.context, fixture);
        const options = await connect(browser, service);

        const page = await browser.context.newPage();
        await page.goto(`${site}/identifier?again`);
        // The site did not know the account: its form shows again on another path.
        await expect(page.locator("#account-error")).toBeVisible();
        await expect
          .poll(() => send(options, { version: 1, type: "login.probe.status" }))
          .toMatchObject({ attempts: [{ outcome: "unknown-submit", submissions: 1 }] });
        // The form shown again is not sent to continue the recipe, and the service does not
        // judge a page that shows a field the recipe fills, so the account is entered once,
        // nothing is appended and no other model call is made.
        expect(claude.prompts.map((prompt) => [prompt.task, prompt.observation.path])).toEqual([
          ["generate", "/identifier"],
        ]);
        expect(await page.locator("#fixture-status").textContent()).toContain(
          "Identity clicks: 1; Submit clicks: 0",
        );
        const recipes = (await (await service.request("/v1/recipes")).json()) as RecipeChanges;
        expect(recipes.changes.map((change) => change.recipe)).toMatchObject([
          {
            revision: 1,
            layouts: [{ steps: [{ kind: "fill" }, { kind: "click", purpose: "advance" }] }],
          },
        ]);
        expect([...new Set(externalRequests)].sort()).toEqual(["https://127.0.0.1", site]);
      },
      { args: ["--ignore-certificate-errors"] },
    );
  } finally {
    await service.close();
    await fixture.close();
  }
});

test("an abstained continuation settles unknown without judging the page (ADR 0018)", async () => {
  // The login waits out the advance's wait on the password page before it settles.
  test.setTimeout(60_000);
  const fixture = await startLoginFixture(0, { password, accountName: username });
  const claude = syntheticClaude({ abstainOnPassword: true });
  const service = await startSyncService({ claude: claude.answer });
  try {
    await withVaultProfile(
      async (open, externalRequests) => {
        const browser = await open();
        await serveSite(browser.context, fixture);
        const options = await connect(browser, service);
        await shortenStepWait(options);

        const page = await browser.context.newPage();
        await page.goto(`${site}/identifier`);
        await expect(page).toHaveURL(`${site}/identifier/password`);
        // The password page is sent to continue the recipe; the model abstains.
        await expect.poll(() => claude.prompts.length, { timeout: 20_000 }).toBe(2);
        expect(claude.prompts.map((prompt) => [prompt.task, prompt.observation.path])).toEqual([
          ["generate", "/identifier"],
          ["generate", "/identifier/password"],
        ]);
        // The login settles unknown there once the advance's wait is over: the password is
        // never typed and the page never judged.
        await expect
          .poll(() => send(options, { version: 1, type: "login.probe.status" }))
          .toMatchObject({
            attempts: [{ state: "reconciling", outcome: "unknown-submit", submissions: 1 }],
          });
        await expect
          .poll(() => logs(browser.background, "login.attempt"))
          .toContainEqual(expect.objectContaining({ outcome: "unknown-submit", settled: true }));
        expect(claude.prompts).toHaveLength(2);
        await expect(page.locator("#password")).toHaveValue("");
        // A reload of the same login sends nothing again: the watched login's check of the
        // reloaded page decides against sending it, and logs that it is not judged either.
        await page.reload();
        await expect
          .poll(() => logs(browser.background, "recipe.judge"))
          .toContainEqual(expect.objectContaining({ reason: "continuation", watched: true }));
        expect(claude.prompts).toHaveLength(2);
        expect(JSON.stringify(claude.prompts)).not.toContain(password);
        expect(JSON.stringify(claude.prompts)).not.toContain(username);
        // The stored recipe still ends at the identifier page's Next.
        const recipes = (await (await service.request("/v1/recipes")).json()) as RecipeChanges;
        expect(recipes.changes.map((change) => change.recipe)).toMatchObject([
          {
            revision: 1,
            layouts: [{ steps: [{ kind: "fill" }, { kind: "click", purpose: "advance" }] }],
          },
        ]);
        expect(recipes.changes[0]!.recipe!.layouts[0]!.steps).toHaveLength(2);
        expect([...new Set(externalRequests)].sort()).toEqual(["https://127.0.0.1", site]);
      },
      { args: ["--ignore-certificate-errors"] },
    );
  } finally {
    await service.close();
    await fixture.close();
  }
});

for (const { name, loginPage } of [
  { name: "login page", loginPage: "/sign-in" },
  // The login page asks for the account alone, by an input named only `login` (ADR 0016).
  { name: "identifier page", loginPage: "/identifier" },
])
  test(`a page that sent the visitor to sign in first presses its Login link to the ${name} (ADR 0031)`, async () => {
    // The entry page waits for a sign-in input until its DOM is quiet before it is sent,
    // and an identifier page waits again (ADR 0057).
    test.setTimeout(loginPage === "/sign-in" ? 90_000 : 120_000);
    const fixture = await startLoginFixture(0, { password, accountName: username });
    const claude = syntheticClaude();
    const service = await startSyncService({ claude: claude.answer });
    // A top page on another host of the site: no form, a "Create account" and a
    // "Login" link to the login page, and a sign-in through another site.
    const top = "https://www.synthetic.example.test";
    try {
      await withVaultProfile(
        async (open, externalRequests) => {
          const browser = await open();
          await serveSite(browser.context, fixture);
          const runId = loginPage === "/sign-in" ? fixture.createRun() : undefined;
          await browser.context.route(`${top}/**`, (route) =>
            route.fulfill({
              contentType: "text/html",
              body: `<!doctype html><html lang="en"><head><title>Synthetic art</title></head><body>
              <header>
                <a href="${site}/signup">Create account</a>
                <a href="${site}${runId ? `/sign-in?runId=${runId}` : "/identifier?login"}">Login</a>
                <a href="https://other-site.test/oauth">Continue with Other</a>
              </header>
              <main><h1>Synthetic art</h1><p>Sign in to see your bookmarks.</p></main>
            </body></html>`,
            }),
          );
          const options = await connect(browser, service);

          const page = await browser.context.newPage();
          await page.goto(`${top}/en/?return_to=%2Fbookmarks`);
          // The entry page is sent, its Login link pressed, and the login page it leads to is
          // generated and logs in.
          await expect(page.locator("#signed-in")).toBeVisible({
            timeout: runId ? 60_000 : 90_000,
          });
          if (runId) expect(fixture.evidence(runId)).toMatchObject({ posts: 1, allMatched: true });
          // One Next and one Log in, each with the matching account and password.
          else
            expect(await page.locator("#fixture-status").textContent()).toContain(
              "Identity clicks: 1; Submit clicks: 1",
            );
          // The press is no login attempt: only the login page's attempt is recorded.
          await expect
            .poll(() => send(options, { version: 1, type: "login.probe.status" }), {
              timeout: SETTLE_MS,
            })
            .toMatchObject({ attempts: [{ state: "authenticated", account: { origin: site } }] });
          expect(claude.prompts.map((prompt) => [prompt.task, prompt.observation.path])).toEqual([
            ["entry", "/en/"],
            ...(loginPage === "/sign-in"
              ? [["generate", "/sign-in"]]
              : [
                  ["generate", "/identifier"],
                  ["generate", "/identifier/password"],
                ]),
            ["judge-sign-in", "/account"],
          ]);
          // The entry page goes without its query, values or links to another site.
          const [entry] = claude.prompts;
          expect(entry!.observation.candidates.map((candidate) => candidate.target)).toEqual([
            { by: "text", value: "Create account" },
            { by: "text", value: "Login" },
          ]);
          expect(JSON.stringify(claude.prompts)).not.toContain("return_to");
          expect(JSON.stringify(claude.prompts)).not.toContain("other-site");
          expect(JSON.stringify(claude.prompts)).not.toContain(password);
          expect(JSON.stringify(claude.prompts)).not.toContain(username);
          const recipes = (await (await service.request("/v1/recipes")).json()) as {
            changes: { recipe?: { origin: string; entry?: unknown } }[];
          };
          expect(recipes.changes.map((change) => change.recipe)).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                origin: top,
                entry: { path: "/en/", target: { by: "text", value: "Login" } },
              }),
            ]),
          );
          expect([...new Set(externalRequests)].sort()).toEqual(["https://127.0.0.1", site, top]);
        },
        { args: ["--ignore-certificate-errors"] },
      );
    } finally {
      await service.close();
      await fixture.close();
    }
  });

for (const changing of [false, true])
  test(`a page without a sign-in input is sent ${changing ? "at its five-second limit while its DOM keeps changing" : "once its DOM is quiet for a second"} (ADR 0057)`, async () => {
    const fixture = await startLoginFixture(0, { password, accountName: username });
    const claude = syntheticClaude();
    const service = await startSyncService({ claude: claude.answer });
    // An entry page (ADR 0031) on another host of the site, whose clock may tick every
    // 200 ms.
    const top = "https://www.synthetic.example.test";
    try {
      await withVaultProfile(
        async (open) => {
          const browser = await open();
          await serveSite(browser.context, fixture);
          await browser.context.route(`${top}/**`, (route) =>
            route.fulfill({
              contentType: "text/html",
              body: `<!doctype html><html lang="en"><head><title>Synthetic art</title></head><body>
              <header><a href="${site}/sign-in">Login</a></header>
              <main><h1>Synthetic art</h1><p>Sign in to see your bookmarks.</p>
              <p id="clock">0</p></main>
              ${changing ? `<script>let ticks = 0; setInterval(() => { document.querySelector("#clock").textContent = String(++ticks); }, 200);</script>` : ""}
            </body></html>`,
            }),
          );
          await connect(browser, service);

          const page = await browser.context.newPage();
          const loading = Date.now();
          await page.goto(`${top}/en/?return_to=%2Fbookmarks`);
          await expect.poll(() => claude.prompts.length, { timeout: 20_000 }).toBeGreaterThan(0);
          expect(claude.prompts[0]).toMatchObject({ task: "entry", observation: { path: "/en/" } });
          // The wait begins after the page started loading: a changing page is never sent at
          // its first quiet second, a quiet page is sent well before the five-second limit,
          // and either well before the step wait's ten seconds. The bounds leave room for a
          // slow machine.
          const sent = claude.times[0]! - loading;
          if (changing) {
            expect(sent).toBeGreaterThanOrEqual(4_000);
            expect(sent).toBeLessThan(9_000);
          } else expect(sent).toBeLessThan(4_000);
        },
        { args: ["--ignore-certificate-errors"] },
      );
    } finally {
      await service.close();
      await fixture.close();
    }
  });

for (const footer of [false, true])
  test(`a sign-in form shown after the page was quiet for over a second is still sent${footer ? " beside an email address in its footer" : ""} (ADR 0016, ADR 0057)`, async () => {
    const fixture = await startLoginFixture(0, { password, accountName: username });
    const claude = syntheticClaude();
    const service = await startSyncService({ claude: claude.answer });
    // A page on another host of the site that shows nothing, changes nothing for 4 seconds,
    // as behind a CSS-only spinner, and then shows its sign-in form. A footer's email
    // address is no list of accounts and is announced only for the log (ADR 0028).
    const top = "https://www.synthetic.example.test";
    try {
      await withVaultProfile(
        async (open) => {
          const browser = await open();
          await serveSite(browser.context, fixture);
          await browser.context.route(`${top}/**`, (route) =>
            route.fulfill({
              contentType: "text/html",
              body: `<!doctype html><html lang="en"><head><title>Synthetic sign-in</title></head><body>
            <main id="main"><h1>Synthetic sign-in</h1></main>
            ${footer ? "<footer>help@synthetic.example.test</footer>" : ""}
            <script>setTimeout(() => {
              document.querySelector("#main").insertAdjacentHTML("beforeend",
                '<form><label>Password <input id="password" type="password"></label>' +
                '<button id="login" type="button">Log in</button></form>');
            }, 4000);</script>
          </body></html>`,
            }),
          );
          await connect(browser, service);

          const page = await browser.context.newPage();
          await page.goto(`${top}/account`);
          await expect(page.locator("#password")).toBeVisible();
          // The page was decided as nothing else after its first quiet second, but its form
          // still shows within the step wait, so it is sent as a sign-in page.
          await expect.poll(() => claude.prompts.length, { timeout: 20_000 }).toBeGreaterThan(0);
          expect(claude.prompts[0]).toMatchObject({
            task: "generate",
            observation: { path: "/account" },
          });
          expect(claude.prompts.map((prompt) => prompt.task)).not.toContain("entry");
        },
        { args: ["--ignore-certificate-errors"] },
      );
    } finally {
      await service.close();
      await fixture.close();
    }
  });
