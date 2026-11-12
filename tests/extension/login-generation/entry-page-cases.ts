import { test, expect } from "@playwright/test";
import { startLoginFixture } from "../login-server";
import { startSyncService } from "../sync-service";
import { withVaultProfile } from "../vault-fixture";
import { sendToBackground as send } from "../background-message";
import type { EntryPageContext, RecipeChanges } from "./context";

export function registerEntryPages({
  site,
  password,
  serveSite,
  SETTLE_MS,
  syntheticClaude,
  connect,
  username,
}: EntryPageContext): void {
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
            if (runId)
              expect(fixture.evidence(runId)).toMatchObject({ posts: 1, allMatched: true });
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
            expect(claude.prompts[0]).toMatchObject({
              task: "entry",
              observation: { path: "/en/" },
            });
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

  for (const mode of ["url", "recipe-elsewhere", "same-url"] as const)
    test(`a sign-in form the person opens in place ${
      mode === "same-url"
        ? "without a URL change is sent, as Discord's after Add an account"
        : `after a same-document URL change is sent${mode === "recipe-elsewhere" ? " while the site has a recipe on another path" : ""}`
    } (ADR 0016)`, async () => {
      const fixture = await startLoginFixture(0, { password, accountName: username });
      const claude = syntheticClaude();
      const service = await startSyncService({ claude: claude.answer });
      // A landing page whose "I already have an account" button, pressed long after the page
      // settled, shows the sign-in form in the same document, as Duolingo's does
      // (2026-10-24): with pushState to `/?isLoggingIn=true`, or without a URL change.
      const top = "https://www.synthetic.example.test";
      try {
        await withVaultProfile(
          async (open) => {
            const browser = await open();
            await serveSite(browser.context, fixture);
            await browser.context.route(`${top}/**`, (route) =>
              route.fulfill({
                contentType: "text/html",
                body:
                  new URL(route.request().url()).pathname === "/account"
                    ? `<!doctype html><html lang="en"><head><title>Synthetic account</title></head><body>
            <main><h1>Enter your password</h1><form><input id="password" type="password">
            <button id="login" type="button">Log in</button></form></main></body></html>`
                    : `<!doctype html><html lang="en"><head><title>Synthetic</title></head><body>
            <main id="main"><h1>Learn for free</h1><button id="get-started" type="button">Get started</button>
            <button id="have-account" type="button">I already have an account</button></main>
            <script>document.querySelector("#have-account").addEventListener("click", () => {
              ${mode === "same-url" ? "" : 'history.pushState({}, "", "/?isLoggingIn=true");'}
              document.querySelector("#main").innerHTML =
                '<form><h1>Log in</h1><input id="email" placeholder="Email or username">' +
                '<input id="password" type="password" placeholder="Password">' +
                '<button id="login" type="button">Log in</button></form>';
            });</script>
          </body></html>`,
              }),
            );
            await connect(browser, service);

            if (mode === "recipe-elsewhere") {
              const account = await browser.context.newPage();
              await account.goto(`${top}/account`);
              await expect.poll(() => claude.prompts.length, { timeout: 20_000 }).toBe(1);
              await expect
                .poll(
                  async () =>
                    ((await (await service.request("/v1/recipes")).json()) as RecipeChanges).changes
                      .length,
                )
                .toBe(1);
              await account.close();
            }
            const sent = claude.prompts.length;
            const page = await browser.context.newPage();
            await page.goto(`${top}/`);
            // Well past the page's step wait, the person opens the form.
            await page.waitForTimeout(12_000);
            expect(claude.prompts).toHaveLength(sent);
            await page.locator("#have-account").click();
            await expect(page.locator("#password")).toBeVisible();
            // Also without a URL change, once per path (amended 2026-11-04).
            await expect
              .poll(() => claude.prompts.length, { timeout: 20_000 })
              .toBeGreaterThan(sent);
            expect(claude.prompts[sent]).toMatchObject({
              task: "generate",
              observation: { path: "/" },
            });
          },
          { args: ["--ignore-certificate-errors"] },
        );
      } finally {
        await service.close();
        await fixture.close();
      }
    });

  for (const hidden of [false, true])
    test(`a sign-in form in a frame of the site's page is generated and logs in there${hidden ? " once the hidden frame shows" : ""} (ADR 0086)`, async () => {
      test.setTimeout(90_000);
      const fixture = await startLoginFixture(0, { password });
      const claude = syntheticClaude();
      const service = await startSyncService({ claude: claude.answer });
      // The site's page embeds its sign-in form from the login host, as Apple Account's
      // page does from idmsa.apple.com (#1378).
      const top = "https://www.synthetic.example.test";
      try {
        await withVaultProfile(
          async (open, externalRequests) => {
            const browser = await open();
            await serveSite(browser.context, fixture);
            const runId = fixture.createRun();
            await browser.context.route(`${top}/**`, (route) =>
              route.fulfill({
                contentType: "text/html",
                body: `<!doctype html><html lang="en"><head><title>Synthetic account</title></head><body>
            <main><h1>Sign in to your account</h1>
            <iframe id="login-frame" title="Synthetic sign-in" width="600" height="400"
              ${hidden ? 'style="display:none"' : ""}
              src="${site}/sign-in?runId=${runId}&state=synthetic-state"></iframe></main>
          </body></html>`,
              }),
            );
            const options = await connect(browser, service);

            const page = await browser.context.newPage();
            await page.goto(`${top}/account`);
            const frame = page.frameLocator("#login-frame");
            if (hidden) {
              // Well past the frame's step wait, nothing was sent; then the page shows it.
              await page.waitForTimeout(12_000);
              expect(claude.prompts).toEqual([]);
              await page.locator("#login-frame").evaluate((element) => {
                (element as HTMLElement).style.removeProperty("display");
              });
            }
            await expect(frame.locator("#signed-in")).toBeVisible({ timeout: 60_000 });
            expect(fixture.evidence(runId)).toMatchObject({ posts: 1, allMatched: true });
            await expect
              .poll(() => send(options, { version: 1, type: "login.probe.status" }), {
                timeout: SETTLE_MS,
              })
              .toMatchObject({
                attempts: [
                  { state: "authenticated", outcome: "authenticated", account: { origin: site } },
                ],
              });
            // Only the frame's own document went out, under its origin and path without the
            // query, and the recipe is the frame origin's.
            expect(
              claude.prompts.map((prompt) => [
                prompt.task,
                prompt.observation.origin,
                prompt.observation.path,
              ]),
            ).toEqual([
              ["generate", site, "/sign-in"],
              ["judge-sign-in", site, "/account"],
            ]);
            expect(JSON.stringify(claude.prompts)).not.toContain("synthetic-state");
            expect(JSON.stringify(claude.prompts)).not.toContain("Sign in to your account");
            expect(JSON.stringify(claude.prompts)).not.toContain(password);
            const recipes = (await (await service.request("/v1/recipes")).json()) as RecipeChanges;
            expect(recipes.changes.map((change) => change.recipe?.origin)).toEqual([site]);
            expect([...new Set(externalRequests)].sort()).toEqual(["https://127.0.0.1", site, top]);
          },
          { args: ["--ignore-certificate-errors"] },
        );
      } finally {
        await service.close();
        await fixture.close();
      }
    });
}
