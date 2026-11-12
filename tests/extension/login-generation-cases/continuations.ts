import type { Page } from "@playwright/test";
import type { LoginGenerationCaseContext, RecipeChanges } from "../login-generation.spec";

export function registerContinuations({
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
  | "SETTLE_MS"
  | "syntheticClaude"
  | "connect"
  | "username"
  | "shortenStepWait"
  | "logs"
  | "settingsRequest"
>): void {
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
    // Continue keeps the email input, filled and writable, above the password input it adds
    // on the same path, every input sharing one test attribute (issue #1413).
    {
      name: "email input kept",
      start: "/identifier-kept",
      query: "",
      passwordPath: "/identifier-kept",
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

  test("a code view swapped in where every input shares one test attribute gets the item's TOTP code (issue #1413)", async () => {
    test.setTimeout(90_000);
    const fixture = await startLoginFixture(0, { password, accountName: username });
    const claude = syntheticClaude();
    const service = await startSyncService({ claude: claude.answer });
    try {
      await withVaultProfile(
        async (open) => {
          const browser = await open();
          await serveSite(browser.context, fixture);
          const options = await connect(browser, service, "uri-totp");

          const page = await browser.context.newPage();
          await page.goto(`${site}/identifier-kept?code`);
          // The account and the password were each entered once, then the code view showed
          // in the same document, its code input carrying the email input's test attribute.
          // The fields are named by their IDs, so the code input is no sign-in field: the
          // judge names it, a `totp` handler is learned and the item's code goes in.
          await page.waitForURL(`${site}/account`, { timeout: 60_000 });
          expect(await page.locator("#fixture-status").textContent()).toContain(
            "Identity clicks: 1; Submit clicks: 1; Identity matched: true; Password matched: true",
          );
          expect(await page.evaluate(() => sessionStorage.getItem("codeMatched"))).toBe("true");
          await expect
            .poll(() => send(options, { version: 1, type: "login.probe.status" }), {
              timeout: SETTLE_MS,
            })
            .toMatchObject({ attempts: [{ outcome: "authenticated" }] });
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
                changes: { recipe?: { layouts: { handlers?: unknown; completion?: unknown }[] } }[];
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
          expect(learned?.layouts).toHaveLength(1);
          expect(learned?.layouts[0]).not.toHaveProperty("completion");
          expect(learned?.layouts[0]).not.toHaveProperty("handlers");

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
            .toMatchObject([
              { layouts: [{ completion: [{ target: { by: "id", value: "sign-out" } }] }] },
            ]);
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
          // `connect` left only the Bitwarden connection in use.
          const connection = current.catalog.connections.find(
            (entry) => entry.provider === "bitwarden",
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
            server: connection.server,
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
}
