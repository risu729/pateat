import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { beginInput, settingsRequest, setupProbe, setupRequest } from "./connection-fixture";
import { startLoginFixture } from "./login-server";
import { startSyncService } from "./sync-service";
import { withVaultProfile } from "./vault-fixture";

// The synthetic Bitwarden item stores the URI https://synthetic.example.test/login and the
// login password "test_password". The site has no recipe; the service generates one with
// a local stand-in for Claude, so no request reaches Anthropic or any real site.
const site = "https://synthetic.example.test";

async function send(page: Page, message: unknown): Promise<unknown> {
  return page.evaluate(
    async (request) =>
      (
        globalThis as unknown as {
          chrome: { runtime: { sendMessage(value: unknown): Promise<unknown> } };
        }
      ).chrome.runtime.sendMessage(request),
    message,
  );
}

async function serveSite(context: BrowserContext, fixture: { origin: string }) {
  await context.route(`${site}/**`, async (route) => {
    const url = new URL(route.request().url());
    const response = await route.fetch({ url: `${fixture.origin}${url.pathname}${url.search}` });
    await route.fulfill({ response });
  });
}

type Candidate = { id: string; role: string; target: { by: string; value: string } };
type Prompt = { task: string; observation: { path: string; candidates: Candidate[] } };

/**
 * Answers the Worker's token exchange and Messages API calls the way Claude would for
 * the fixture pages: fill the password and press "Log in", then mark "Sign out" as the
 * signed-in evidence. The page descriptions it receives are recorded.
 */
function syntheticClaude() {
  const prompts: Prompt[] = [];
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
    const byTarget = (value: string, by = "id") => {
      const found = prompt.observation.candidates.find(
        (candidate) => candidate.target.by === by && candidate.target.value === value,
      );
      if (!found) throw new Error(`No candidate for ${by} ${value}`);
      return found.id;
    };
    // The `script-link` fixture's login link has no id, so only its text names it.
    const login = () =>
      prompt.observation.candidates.some(
        ({ target }) => target.by === "id" && target.value === "login",
      )
        ? byTarget("login")
        : byTarget("Log in", "text");
    const result =
      prompt.task === "generate"
        ? {
            decision: "plan",
            fields: [{ slot: "password", candidate: byTarget("password") }],
            action: { candidate: login(), purpose: "submit" },
          }
        : { decision: "signed-in", marker: byTarget("sign-out") };
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
  return { prompts, answer };
}

for (const button of ["button", "anchor", "script-link"] as const)
  test(`a login page without a recipe is generated on the service, logs in and learns its completion (${button})`, async () => {
    const fixture = await startLoginFixture(0, { password: "test_password" });
    const claude = syntheticClaude();
    const service = await startSyncService({ claude: claude.answer });
    try {
      await withVaultProfile(
        async (open, externalRequests) => {
          const browser = await open();
          await serveSite(browser.context, fixture);
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

          const runId = fixture.createRun();
          const page = await browser.context.newPage();
          await page.goto(`${site}/sign-in?runId=${runId}&button=${button}`);
          await expect(page.locator("#signed-in")).toBeVisible();
          expect(fixture.evidence(runId)).toEqual({
            posts: 1,
            inputPosts: 0,
            clickPosts: 1,
            allMatched: true,
          });
          // The attempt settles on the judgement of the page after the submission.
          await expect
            .poll(() => send(options, { version: 1, type: "login.probe.status" }))
            .toMatchObject({
              attempts: [{ state: "authenticated", outcome: "authenticated", submissions: 1 }],
            });
          // The service sent the login page without values, then the signed-in page.
          expect(claude.prompts.map((prompt) => [prompt.task, prompt.observation.path])).toEqual([
            ["generate", "/sign-in"],
            ["judge-sign-in", "/account"],
          ]);
          expect(JSON.stringify(claude.prompts)).not.toContain("test_password");
          const recipes = (await (await service.request("/v1/recipes")).json()) as {
            changes: { recipe?: { revision: number; completion?: unknown } }[];
          };
          expect(recipes.changes.map((change) => change.recipe)).toMatchObject([
            {
              revision: 2,
              completion: { path: "/account", target: { by: "id", value: "sign-out" } },
            },
          ]);

          // The next visit runs the stored recipe and its learned completion with no model call.
          // A settled attempt holds the origin while its tab stays open.
          await page.close();
          const again = fixture.createRun();
          const next = await browser.context.newPage();
          await next.goto(`${site}/sign-in?runId=${again}&button=${button}`);
          await expect(next.locator("#signed-in")).toBeVisible();
          expect(fixture.evidence(again)).toMatchObject({ posts: 1, allMatched: true });
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
