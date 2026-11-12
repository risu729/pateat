import type { LoginGenerationCaseContext, RecipeChanges } from "../login-generation.spec";

export function registerLayoutRepair({
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
}: Pick<
  LoginGenerationCaseContext,
  | "test"
  | "expect"
  | "startLoginFixture"
  | "startSyncService"
  | "withVaultProfile"
  | "send"
  | "site"
  | "password"
  | "serveSite"
  | "syntheticClaude"
  | "connect"
>): void {
  test("a generated recipe whose start page changed gets a layout for it on the first load, never for a maintenance page (ADR 0041)", async () => {
    // Each page that misses its first step reports after the ten-second step wait.
    test.setTimeout(180_000);
    const fixture = await startLoginFixture(0, { password });
    const claude = syntheticClaude();
    const service = await startSyncService({ claude: claude.answer });
    try {
      await withVaultProfile(
        async (open, externalRequests) => {
          const browser = await open();
          await serveSite(browser.context, fixture);
          const options = await connect(browser, service);
          const repairs = () =>
            browser.background.evaluate(async () => {
              const key = "pateat.recipe-repairs.v1";
              const stored = await (
                globalThis as unknown as {
                  chrome: {
                    storage: { local: { get(key: string): Promise<Record<string, unknown>> } };
                  };
                }
              ).chrome.storage.local.get(key);
              const record = stored[key] as
                | { recipes: { revision: number; held?: number }[] }
                | undefined;
              return record?.recipes.map(({ revision, held }) => ({
                revision,
                held: held !== undefined,
              }));
            });

          // The recipe is generated on the first visit and learns its completion.
          let page = await browser.context.newPage();
          await page.goto(`${site}/sign-in?runId=${fixture.createRun()}`);
          await expect(page.locator("#signed-in")).toBeVisible();
          await expect.poll(() => claude.prompts.length).toBe(2);
          await expect
            .poll(() => send(options, { version: 1, type: "login.probe.status" }))
            .toMatchObject({ attempts: [{ state: "authenticated", outcome: "authenticated" }] });
          await page.close();

          // A maintenance page answered 503 on the login page's URL is never sent.
          page = await browser.context.newPage();
          await page.goto(`${site}/sign-in?maintenance`);
          await page.waitForTimeout(12_000);
          await page.close();
          expect(await repairs()).toBeUndefined();
          expect(claude.prompts).toHaveLength(2);

          // The redesigned page misses on its first load and is sent at once; the layout the
          // service adds for it logs in on the same page.
          const runId = fixture.createRun();
          page = await browser.context.newPage();
          await page.goto(`${site}/sign-in?redesign&runId=${runId}`);
          await expect(page.locator("#signed-in")).toBeVisible({ timeout: 30_000 });
          expect(fixture.evidence(runId)).toMatchObject({ posts: 1, allMatched: true });
          await expect
            .poll(() => claude.prompts.map((prompt) => [prompt.task, prompt.observation.path]))
            .toEqual([
              ["generate", "/sign-in"],
              ["judge-sign-in", "/account"],
              ["generate", "/sign-in"],
            ]);
          // The page after it shows the marker the other layout learned, which proves the
          // sign-in without a judgement (ADR 0029).
          await expect
            .poll(() => send(options, { version: 1, type: "login.probe.status" }))
            .toMatchObject({ attempts: [{ state: "authenticated", outcome: "authenticated" }] });
          // A start page goes out as a first page, with the signed-in hint (ADR 0035).
          expect(claude.prompts[2]).toMatchObject({ signedIn: false });
          expect(JSON.stringify(claude.prompts)).not.toContain(password);
          expect(await repairs()).toEqual([{ revision: 2, held: false }]);
          // The new layout sits beside the stale one, which keeps what it learned.
          await expect
            .poll(async () => {
              const recipes = (await (
                await service.request("/v1/recipes")
              ).json()) as RecipeChanges;
              return recipes.changes.map((change) => change.recipe);
            })
            .toMatchObject([
              {
                revision: 3,
                layouts: [
                  {
                    steps: [
                      { kind: "fill", fields: [{ target: { by: "id", value: "password" } }] },
                      { kind: "click", target: { by: "id", value: "login" } },
                    ],
                    completion: [{ target: { by: "id", value: "sign-out" } }],
                  },
                  {
                    steps: [
                      { kind: "fill", fields: [{ target: { by: "id", value: "passcode" } }] },
                      { kind: "click", target: { by: "id", value: "continue" } },
                    ],
                  },
                ],
              },
            ]);
          await page.close();

          // The old page still logs in with its own layout and no model call.
          const again = fixture.createRun();
          page = await browser.context.newPage();
          await page.goto(`${site}/sign-in?runId=${again}`);
          await expect(page.locator("#signed-in")).toBeVisible();
          expect(fixture.evidence(again)).toMatchObject({ posts: 1, allMatched: true });
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
}
