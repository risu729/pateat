import type { LoginCaseContext } from "./context";
import type { SettingsResponse } from "../../../packages/contracts/src/index";

export function registerLifecycle({
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
}: Pick<
  LoginCaseContext,
  | "test"
  | "expect"
  | "withLoginExtension"
  | "startLoginFixture"
  | "send"
  | "configure"
  | "checkedAgain"
  | "SHORT_STEP_WAIT_MS"
  | "clicks"
  | "expectWatchingWithoutAttempt"
>): void {
  test("credential rejection and unknown outcome each stop after one submission", async () => {
    const fixture = await startLoginFixture();
    try {
      await withLoginExtension(async (context, _worker, id) => {
        const options = await context.newPage();
        await configure(options, id, fixture.origin);
        const rejected = await context.newPage();
        await rejected.goto(`${fixture.origin}/rejection`);
        await expect(rejected.locator("#rejected")).toBeVisible();
        await expect
          .poll(async () =>
            JSON.stringify(await send(options, { version: 1, type: "login.probe.status" })),
          )
          .toContain('"asks":["rejected"]');
        // A released rejection must not log in again in its page: its announcement after the
        // release was refused while the tab asks.
        await expect
          .poll(async () => await send(options, { version: 1, type: "login.probe.status" }))
          .toMatchObject({ documents: [{ state: "denied", reason: "account-asked" }] });
        expect(await clicks(rejected)).toBe(1);
        await rejected.close();
        // Closing the tab ends its ask, so the next page logs in afresh.
        await expect
          .poll(async () => {
            const status = (await send(options, { version: 1, type: "login.probe.status" })) as {
              attempts: unknown[];
              asks: unknown[];
            };
            return status.attempts.length + status.asks.length;
          })
          .toBe(0);
        const unknown = await context.newPage();
        await unknown.goto(`${fixture.origin}/unknown`);
        await expect.poll(() => clicks(unknown)).toBe(1);
        await expect
          .poll(async () =>
            JSON.stringify(await send(options, { version: 1, type: "login.probe.status" })),
          )
          .toContain("unknown-submit");
        // A DOM update wakes observation again; uncertainty must not replay a click.
        await unknown.evaluate(() => document.body.append(document.createElement("p")));
        await unknown.waitForTimeout(1000);
        expect(await clicks(unknown)).toBe(1);
        expect(
          JSON.stringify(await send(options, { version: 1, type: "login.probe.status" })),
        ).toContain("unknown-submit");
      });
    } finally {
      await fixture.close();
    }
  });

  test("policy revocation while awaiting delayed fields prevents fill and submission", async () => {
    const fixture = await startLoginFixture();
    try {
      await withLoginExtension(async (context, _worker, id) => {
        const options = await context.newPage();
        await configure(options, id, fixture.origin);
        const page = await context.newPage();
        await page.goto(`${fixture.origin}/delayed`);
        await expect
          .poll(async () =>
            JSON.stringify(await send(options, { version: 1, type: "login.probe.status" })),
          )
          .toContain('"executing"');
        const response = (await send(options, {
          version: 1,
          type: "settings.get",
        })) as SettingsResponse;
        if (!response.ok) throw new Error("Synthetic settings unavailable");
        const settings = response.snapshot.settings;
        settings.excludedSites = [{ hostname: "127.0.0.1", includeSubdomains: false }];
        expect(
          await send(options, {
            version: 1,
            type: "settings.save",
            expectedRevision: response.snapshot.revision,
            settings,
          }),
        ).toMatchObject({ ok: true });
        await page.evaluate(() =>
          (window as unknown as { releaseDelayedLogin: () => void }).releaseDelayedLogin(),
        );
        await expect
          .poll(async () =>
            JSON.stringify(await send(options, { version: 1, type: "login.probe.status" })),
          )
          .toContain("policy-changed");
        await expect(page.locator("#password")).toHaveValue("");
        expect(await clicks(page)).toBe(0);
      });
    } finally {
      await fixture.close();
    }
  });

  test("navigation invalidates a pending wait before it can fill the replacement document", async () => {
    const fixture = await startLoginFixture();
    try {
      await withLoginExtension(async (context, _worker, id) => {
        const options = await context.newPage();
        await configure(options, id, fixture.origin);
        const page = await context.newPage();
        await page.goto(`${fixture.origin}/delayed`);
        await expect
          .poll(async () =>
            JSON.stringify(await send(options, { version: 1, type: "login.probe.status" })),
          )
          .toContain('"executing"');
        const before = (await send(options, { version: 1, type: "login.probe.status" })) as {
          attempts: { document: { documentId: string } }[];
        };
        const originalDocument = before.attempts[0]!.document.documentId;
        await page.goto(`${fixture.origin}/single`);
        // Nothing was submitted, so the replacement page settles no unknown result: the wait
        // ends there without one (ADR 0022).
        await expect
          .poll(async () =>
            JSON.stringify(await send(options, { version: 1, type: "login.probe.status" })),
          )
          .toContain('"state":"blocked"');
        const after = (await send(options, { version: 1, type: "login.probe.status" })) as {
          attempts: { document: { documentId: string }; outcome?: string; submissions: number }[];
        };
        expect(after.attempts[0]!.document.documentId).not.toBe(originalDocument);
        expect(after.attempts[0]).toMatchObject({ submissions: 0 });
        expect(after.attempts[0]!.outcome).not.toBe("unknown-submit");
        await expect(page.locator("#password")).toHaveValue("");
        expect(await clicks(page)).toBe(0);
      });
    } finally {
      await fixture.close();
    }
  });

  test("a competing tab cannot race a login of the same site that is still running", async () => {
    const fixture = await startLoginFixture();
    try {
      await withLoginExtension(async (context, _worker, id) => {
        const options = await context.newPage();
        await configure(options, id, fixture.origin);
        const first = await context.newPage();
        await first.goto(`${fixture.origin}/delayed`);
        await expect
          .poll(async () =>
            JSON.stringify(await send(options, { version: 1, type: "login.probe.status" })),
          )
          .toContain('"executing"');
        const second = await context.newPage();
        await second.goto(`${fixture.origin}/single`);
        await expect
          .poll(async () =>
            JSON.stringify(await send(options, { version: 1, type: "login.probe.status" })),
          )
          .toContain("origin-busy");
        expect(await clicks(second)).toBe(0);
        await expect(second.locator("#password")).toHaveValue("");
      });
    } finally {
      await fixture.close();
    }
  });

  test("another tab logs in once the site's login in the first tab authenticated", async () => {
    const fixture = await startLoginFixture();
    try {
      await withLoginExtension(async (context, _worker, id) => {
        const options = await context.newPage();
        await configure(options, id, fixture.origin);
        const first = await context.newPage();
        await first.goto(`${fixture.origin}/single`);
        await expect(first.locator("#authenticated")).toBeVisible();
        // The login form showing in a new tab means the site's session has ended (ADR 0022).
        const second = await context.newPage();
        await second.goto(`${fixture.origin}/single`);
        await expect(second.locator("#authenticated")).toBeVisible();
        expect(await clicks(first)).toBe(1);
        expect(await clicks(second)).toBe(1);
        await expect
          .poll(async () => {
            const response = (await send(options, { version: 1, type: "login.probe.status" })) as {
              attempts: { state: string }[];
            };
            return response.attempts.filter((attempt) => attempt.state === "authenticated");
          })
          .toHaveLength(2);
      });
    } finally {
      await fixture.close();
    }
  });

  for (const { name, path } of [
    { name: "a same-document URL change renders the form", path: "/spa" },
    // The form is already on the page; only history.pushState changes, with no DOM mutation.
    { name: "a same-document URL change reaches the form's path", path: "/spa?static" },
    { name: "a hidden login dialog opens", path: "/dialog" },
  ]) {
    test(`an attempt starts only when ${name}`, async () => {
      const fixture = await startLoginFixture();
      try {
        await withLoginExtension(async (context, _worker, id) => {
          const options = await context.newPage();
          await configure(options, id, fixture.origin);
          const page = await context.newPage();
          await page.goto(`${fixture.origin}${path}`);
          await expectWatchingWithoutAttempt(options);
          // The person opens the form; the attempt starts from the already loaded document.
          await page.click("#open-login");
          await expect(page.locator("#authenticated")).toBeVisible();
          expect(await clicks(page)).toBe(1);
          expect(page.url()).toBe(
            `${fixture.origin}${path.startsWith("/spa") ? "/spa-login" : path}`,
          );
          await expect
            .poll(async () => await send(options, { version: 1, type: "login.probe.status" }))
            .toMatchObject({ attempts: [{ state: "authenticated", submissions: 1 }] });
        });
      } finally {
        await fixture.close();
      }
    });
  }

  test("a submit button that renders late is clicked once it appears", async () => {
    const fixture = await startLoginFixture();
    try {
      await withLoginExtension(async (context, _worker, id) => {
        const options = await context.newPage();
        await configure(options, id, fixture.origin);
        const page = await context.newPage();
        await page.goto(`${fixture.origin}/slow-button?delay=4000`);
        await expect(page.locator("#authenticated")).toBeVisible({ timeout: 10_000 });
        expect(await clicks(page)).toBe(1);
      });
    } finally {
      await fixture.close();
    }
  });

  test("a later page that renders its form late continues the multi-page login", async () => {
    const fixture = await startLoginFixture();
    try {
      await withLoginExtension(async (context, _worker, id) => {
        const options = await context.newPage();
        await configure(options, id, fixture.origin);
        const page = await context.newPage();
        await page.goto(`${fixture.origin}/identity?slow-password`);
        await expect(page.locator("#authenticated")).toBeVisible({ timeout: 15_000 });
        expect(
          await page.evaluate(() => ({
            identityClicks: Number(sessionStorage.getItem("identityClicks") || 0),
            submitClicks: Number(sessionStorage.getItem("submitClicks") || 0),
            passwordMatched: sessionStorage.getItem("passwordMatched"),
          })),
        ).toEqual({ identityClicks: 1, submitClicks: 1, passwordMatched: "true" });
      });
    } finally {
      await fixture.close();
    }
  });

  test("a step whose element never appears stops after two retries of its step wait without a click", async () => {
    // The first wait and each of its two retries waits the whole step wait for the button.
    test.setTimeout(60_000);
    const fixture = await startLoginFixture();
    try {
      await withLoginExtension(async (context, _worker, id) => {
        const options = await context.newPage();
        await configure(options, id, fixture.origin, true, undefined, false, SHORT_STEP_WAIT_MS);
        const page = await context.newPage();
        const started = Date.now();
        await page.goto(`${fixture.origin}/slow-button?never`);
        await expect
          .poll(async () => await send(options, { version: 1, type: "login.probe.status" }), {
            timeout: 45_000,
          })
          .toMatchObject({
            attempts: [{ state: "blocked", outcome: "retry-limit", retries: 2, submissions: 0 }],
          });
        expect(Date.now() - started).toBeGreaterThanOrEqual(3 * SHORT_STEP_WAIT_MS - 500);
        expect(await clicks(page)).toBe(0);
      });
    } finally {
      await fixture.close();
    }
  });

  test("a login form inside a same-site frame logs in within the frame", async () => {
    const fixture = await startLoginFixture();
    try {
      await withLoginExtension(async (context, _worker, id) => {
        const options = await context.newPage();
        await configure(options, id, fixture.origin);
        const page = await context.newPage();
        await page.goto(`${fixture.origin}/frame-host`);
        await expect(page.frameLocator("#login-frame").locator("#authenticated")).toBeVisible();
        const frame = page.frame({ url: `${fixture.origin}/single` });
        expect(
          await frame?.evaluate(() => Number(sessionStorage.getItem("submitClicks") || 0)),
        ).toBe(1);
        const status = async () =>
          (await send(options, { version: 1, type: "login.probe.status" })) as {
            attempts: { state: string; submissions: number; document: { frameId: number } }[];
          };
        // The frame shows `#authenticated` before the attempt records its result.
        await expect
          .poll(async () => (await status()).attempts)
          .toMatchObject([{ state: "authenticated", submissions: 1 }]);
        expect((await status()).attempts[0]!.document.frameId).toBeGreaterThan(0);
      });
    } finally {
      await fixture.close();
    }
  });

  test("a frame whose tab shows another site is never filled", async () => {
    const fixture = await startLoginFixture();
    // The same login page, embedded by a page on another origin (another loopback port).
    const other = await startLoginFixture();
    try {
      await withLoginExtension(async (context, _worker, id) => {
        const options = await context.newPage();
        await configure(options, id, fixture.origin);
        const page = await context.newPage();
        await page.goto(`${other.origin}/frame-host?port=${new URL(fixture.origin).port}`);
        await expect
          .poll(async () => await send(options, { version: 1, type: "login.probe.status" }))
          .toMatchObject({
            attempts: [],
            documents: expect.arrayContaining([
              expect.objectContaining({ reason: "frame-top-mismatch" }),
            ]),
          });
        await page.waitForTimeout(1000);
        const frame = page.frameLocator("#login-frame");
        await expect(frame.locator("#password")).toHaveValue("");
        await expect(frame.locator("#authenticated")).toHaveCount(0);
        expect(
          await page
            .frame({ url: `${fixture.origin}/single` })
            ?.evaluate(() => Number(sessionStorage.getItem("submitClicks") || 0)),
        ).toBe(0);
        expect(await send(options, { version: 1, type: "login.probe.status" })).toMatchObject({
          attempts: [],
        });
      });
    } finally {
      await other.close();
      await fixture.close();
    }
  });

  test("an unrelated frame beside the form does not disturb the page's login", async () => {
    const fixture = await startLoginFixture();
    try {
      await withLoginExtension(async (context, _worker, id) => {
        const options = await context.newPage();
        await configure(options, id, fixture.origin);
        const page = await context.newPage();
        await page.goto(`${fixture.origin}/single?ad`);
        await expect(page.locator("#authenticated")).toBeVisible();
        expect(await clicks(page)).toBe(1);
        const status = async () =>
          (await send(options, { version: 1, type: "login.probe.status" })) as {
            attempts: { state: string; document: { frameId: number } }[];
            documents: { frameId: number }[];
          };
        // The page shows `#authenticated` before the attempt records its result. The
        // advertisement frame announces itself too, without an attempt of its own.
        await expect
          .poll(async () => {
            const { attempts, documents } = await status();
            return { attempts, adFrame: documents.some((entry) => entry.frameId > 0) };
          })
          .toMatchObject({
            attempts: [{ state: "authenticated", document: { frameId: 0 } }],
            adFrame: true,
          });
      });
    } finally {
      await fixture.close();
    }
  });

  test("a page that shows a CAPTCHA gets the password but leaves the login button to the person (ADR 0029)", async () => {
    const fixture = await startLoginFixture();
    try {
      await withLoginExtension(async (context, _worker, id) => {
        // The CAPTCHA widget's frame is served here; no request leaves the test browser.
        await context.route("https://www.google.com/recaptcha/**", (route) =>
          route.fulfill({
            status: 200,
            contentType: "text/html; charset=utf-8",
            body: '<!doctype html><html lang="en"><title>Synthetic CAPTCHA</title></html>',
          }),
        );
        const options = await context.newPage();
        await configure(options, id, fixture.origin);
        const page = await context.newPage();
        await page.goto(`${fixture.origin}/single?captcha`);
        const status = async () =>
          (await send(options, { version: 1, type: "login.probe.status" })) as {
            attempts: { state: string; submissions: number }[];
          };
        await expect
          .poll(async () => (await status()).attempts)
          .toMatchObject([{ state: "awaiting-result", submissions: 1 }]);
        await expect(page.locator("#password")).not.toHaveValue("");
        // Cover several reconciliation checks before the negative assertions.
        await checkedAgain(options, 6);
        expect(await clicks(page)).toBe(0);
        await expect(page.locator("#authenticated")).toHaveCount(0);
        expect((await status()).attempts).toMatchObject([{ state: "awaiting-result" }]);
        // The person solves the CAPTCHA and presses the button; the held click observes it.
        await page.locator("#login").click();
        await expect(page.locator("#authenticated")).toBeVisible();
        await expect
          .poll(async () => (await status()).attempts)
          .toMatchObject([{ state: "authenticated", submissions: 1 }]);
        expect(await clicks(page)).toBe(1);
      });
    } finally {
      await fixture.close();
    }
  });
}
