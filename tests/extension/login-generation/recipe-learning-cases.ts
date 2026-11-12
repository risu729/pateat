import { test, expect } from "@playwright/test";
import { startLoginFixture } from "../login-server";
import { startSyncService } from "../sync-service";
import { withVaultProfile } from "../vault-fixture";
import { sendToBackground as send } from "../background-message";
import type { RecipeChanges, RecipeLearningContext } from "./context";

export function registerRecipeLearning({
  site,
  password,
  serveSite,
  SETTLE_MS,
  syntheticClaude,
  connect,
}: RecipeLearningContext): void {
  for (const [button, marker] of [
    ["button", "button"],
    ["anchor", "button"],
    ["script-link", "button"],
    ["script-url", "button"],
    ["shadow", "button"],
    ["labelled", "button"],
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
}
