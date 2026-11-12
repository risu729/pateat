import type { LoginCaseContext } from "./context";

export function registerMethodChoice({
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
}: Pick<
  LoginCaseContext,
  | "test"
  | "expect"
  | "logs"
  | "withLoginExtension"
  | "startLoginFixture"
  | "send"
  | "configure"
  | "stateLogs"
  | "SHORT_STEP_WAIT_MS"
  | "choiceEvidence"
>): void {
  for (const [name, query, chooseClicks] of [
    ["presses Password on the page that asks how to verify", "", 1],
    ["leaves the button alone when the site skips that page", "?skip", 0],
  ] as const)
    test(`${name}, then types the password (ADR 0048)`, async () => {
      const fixture = await startLoginFixture();
      try {
        await withLoginExtension(async (context, _worker, id) => {
          const options = await context.newPage();
          await configure(options, id, fixture.origin);
          const page = await context.newPage();
          await page.goto(`${fixture.origin}/method-choice${query}`);
          await expect(page.locator("#authenticated")).toBeVisible({ timeout: 15_000 });
          expect(await choiceEvidence(page)).toEqual({
            identityClicks: 1,
            chooseClicks,
            mobileClicks: 0,
            submitClicks: 1,
            identityMatched: "true",
            passwordMatched: "true",
          });
          await expect
            .poll(async () =>
              JSON.stringify(await send(options, { version: 1, type: "login.probe.status" })),
            )
            .toContain('"authenticated"');
          const status = JSON.stringify(
            await send(options, { version: 1, type: "login.probe.status" }),
          );
          expect(status).toContain('"recipeId":"demo-method-choice"');
          expect(status).toContain(
            chooseClicks ? '"handlers":[{"index":0,"start":2}]' : '"handlers":[]',
          );
          expect(status).not.toContain("Pateat-synthetic-only!");
        });
      } finally {
        await fixture.close();
      }
    });

  test("presses the Select whose accessible name names the password, never the other (ADR 0048 amendment of 2026-10-19)", async () => {
    const fixture = await startLoginFixture();
    try {
      await withLoginExtension(async (context, _worker, id) => {
        const options = await context.newPage();
        await configure(options, id, fixture.origin);
        const page = await context.newPage();
        await page.goto(`${fixture.origin}/method-choice-named`);
        await expect(page.locator("#authenticated")).toBeVisible({ timeout: 15_000 });
        expect(await choiceEvidence(page)).toEqual({
          identityClicks: 1,
          chooseClicks: 1,
          mobileClicks: 0,
          submitClicks: 1,
          identityMatched: "true",
          passwordMatched: "true",
        });
        await expect
          .poll(async () =>
            JSON.stringify(await send(options, { version: 1, type: "login.probe.status" })),
          )
          .toContain('"authenticated"');
        const status = JSON.stringify(
          await send(options, { version: 1, type: "login.probe.status" }),
        );
        expect(status).toContain('"recipeId":"demo-method-choice-named"');
        expect(status).toContain('"handlers":[{"index":0,"start":2}]');
        expect(status).not.toContain("Pateat-synthetic-only!");
      });
    } finally {
      await fixture.close();
    }
  });

  test("never presses a learned button whose text does not name the password (ADR 0048)", async () => {
    test.setTimeout(60_000);
    const fixture = await startLoginFixture();
    try {
      await withLoginExtension(async (context, _worker, id) => {
        const options = await context.newPage();
        await configure(options, id, fixture.origin, true, undefined, false, SHORT_STEP_WAIT_MS);
        const page = await context.newPage();
        await page.goto(`${fixture.origin}/method-choice?forgot`);
        await expect(page.locator("#choice")).toBeVisible({ timeout: 15_000 });
        // Past the advance's wait, whose end settles its result as unknown, nothing more is
        // pressed.
        await expect
          .poll(async () => await send(options, { version: 1, type: "login.probe.status" }))
          .toMatchObject({ attempts: [{ stepIndex: 1, handlers: [], outcome: "unknown-submit" }] });
        expect(await choiceEvidence(page)).toMatchObject({
          identityClicks: 1,
          chooseClicks: 0,
          mobileClicks: 0,
          submitClicks: 0,
        });
        await expect(page.locator("#password")).toBeHidden();
      });
    } finally {
      await fixture.close();
    }
  });

  test("an identifier-first page that shows the password form from the start never continues after Next (ADR 0013)", async () => {
    const fixture = await startLoginFixture();
    try {
      await withLoginExtension(async (context, worker, id) => {
        const options = await context.newPage();
        await configure(options, id, fixture.origin, true, undefined, false, SHORT_STEP_WAIT_MS);
        const page = await context.newPage();
        await page.goto(`${fixture.origin}/identifier-first?shown`);
        // Nothing confirms the advance, so after its wait its result is unknown.
        await expect
          .poll(async () => await send(options, { version: 1, type: "login.probe.status" }), {
            timeout: 20_000,
          })
          .toMatchObject({ attempts: [{ outcome: "unknown-submit", stepIndex: 1 }] });
        // The settled result, logged last, ends the advance's checks of the page.
        await expect
          .poll(async () => await logs(worker, "login.attempt"))
          .toContainEqual(expect.objectContaining({ outcome: "unknown-submit", settled: true }));
        expect(
          await page.evaluate(() => ({
            identityClicks: Number(sessionStorage.getItem("identityClicks") || 0),
            submitClicks: Number(sessionStorage.getItem("submitClicks") || 0),
            password: (document.getElementById("password") as HTMLInputElement).value,
          })),
        ).toEqual({ identityClicks: 1, submitClicks: 0, password: "" });
        // The log says why, as codes: the password input was ready before Next (ADR 0019).
        await expect
          .poll(async () => await stateLogs(worker))
          .toContainEqual(
            expect.objectContaining({
              reshownMiss: "not-submit",
              advanceBefore: "unique",
              advanceAfter: "unique",
              advanceWhy: "ok",
              advancePath: "same",
            }),
          );
      });
    } finally {
      await fixture.close();
    }
  });

  test("never shows or fills the password form after an unknown-account error on an identifier-first form (ADR 0013)", async () => {
    const fixture = await startLoginFixture();
    try {
      await withLoginExtension(async (context, worker, id) => {
        const options = await context.newPage();
        await configure(options, id, fixture.origin, true, undefined, false, SHORT_STEP_WAIT_MS);
        const page = await context.newPage();
        await page.goto(`${fixture.origin}/identifier-first?unknown=1`);
        await expect(page.locator("#account-error")).toBeVisible({ timeout: 15_000 });
        // The advance is never confirmed; it ends as unknown after its wait.
        await expect
          .poll(async () => await send(options, { version: 1, type: "login.probe.status" }), {
            timeout: 20_000,
          })
          .toMatchObject({
            attempts: [
              {
                recipeId: "demo-identifier-first",
                state: "reconciling",
                outcome: "unknown-submit",
                stepIndex: 1,
                submissions: 1,
              },
            ],
          });
        // Past the result wait, whose settled result is logged last, nothing is clicked or
        // filled again.
        await expect
          .poll(async () => await logs(worker, "login.attempt"))
          .toContainEqual(expect.objectContaining({ outcome: "unknown-submit", settled: true }));
        expect(
          await page.evaluate(() => ({
            identityClicks: Number(sessionStorage.getItem("identityClicks") || 0),
            submitClicks: Number(sessionStorage.getItem("submitClicks") || 0),
            identityMatched: sessionStorage.getItem("identityMatched"),
            password: (document.getElementById("password") as HTMLInputElement).value,
          })),
        ).toEqual({ identityClicks: 1, submitClicks: 0, identityMatched: "true", password: "" });
        await expect(page.locator("#password-form")).toBeHidden();
        await expect(page.locator("#authenticated")).toHaveCount(0);
        expect(
          JSON.stringify(await send(options, { version: 1, type: "login.probe.status" })),
        ).not.toContain("Pateat-synthetic-only!");
      });
    } finally {
      await fixture.close();
    }
  });

  test("signs in with the start page's passkey button for a discoverable passkey (ADR 0027)", async () => {
    const fixture = await startLoginFixture();
    try {
      await withLoginExtension(async (context, _worker, id) => {
        const options = await context.newPage();
        await configure(options, id, fixture.origin, true, "discoverable");
        const status = async () =>
          JSON.stringify(await send(options, { version: 1, type: "login.probe.status" }));
        const page = await context.newPage();
        await page.goto(`${fixture.origin}/passkey`);
        await expect(page.locator("#authenticated")).toBeVisible();
        await expect.poll(status).toContain('"authenticated"');
        const evidence = await page.evaluate(() => ({
          passkeyClicks: Number(sessionStorage.getItem("passkeyClicks") || 0),
          submitClicks: Number(sessionStorage.getItem("submitClicks") || 0),
        }));
        expect(evidence).toEqual({ passkeyClicks: 1, submitClicks: 0 });
        const text = await status();
        expect(text).toContain('"recipeId":"demo-passkey"');
        expect(text).toContain('"route":"passkey"');
        expect(text).not.toContain('"variant"');
        expect(text).not.toContain("Pateat-synthetic-only!");
      });
    } finally {
      await fixture.close();
    }
  });

  test("a passkey sign-in that leaves the button on a new page ends as a challenge (ADR 0027)", async () => {
    const fixture = await startLoginFixture();
    try {
      await withLoginExtension(async (context, _worker, id) => {
        const options = await context.newPage();
        await configure(options, id, fixture.origin, true, "discoverable");
        const status = async () =>
          JSON.stringify(await send(options, { version: 1, type: "login.probe.status" }));
        const page = await context.newPage();
        await page.goto(`${fixture.origin}/passkey?stay`);
        await expect.poll(status).toContain('"challenge"');
        // The password is never typed after the passkey route ends.
        await expect(page.locator("#password")).toHaveValue("");
        const evidence = await page.evaluate(() => ({
          passkeyClicks: Number(sessionStorage.getItem("passkeyClicks") || 0),
          submitClicks: Number(sessionStorage.getItem("submitClicks") || 0),
        }));
        expect(evidence).toEqual({ passkeyClicks: 1, submitClicks: 0 });
        expect(await status()).toContain('"route":"passkey"');
      });
    } finally {
      await fixture.close();
    }
  });

  test("a passkey that is only a second factor signs in with the password (ADR 0027)", async () => {
    const fixture = await startLoginFixture();
    try {
      await withLoginExtension(async (context, _worker, id) => {
        const options = await context.newPage();
        await configure(options, id, fixture.origin, true, "second-factor");
        const page = await context.newPage();
        await page.goto(`${fixture.origin}/passkey`);
        await expect(page.locator("#authenticated")).toBeVisible();
        const evidence = await page.evaluate(() => ({
          passkeyClicks: Number(sessionStorage.getItem("passkeyClicks") || 0),
          submitClicks: Number(sessionStorage.getItem("submitClicks") || 0),
          passwordMatched: sessionStorage.getItem("passwordMatched"),
        }));
        expect(evidence).toEqual({ passkeyClicks: 0, submitClicks: 1, passwordMatched: "true" });
        const status = JSON.stringify(
          await send(options, { version: 1, type: "login.probe.status" }),
        );
        expect(status).toContain('"route":"password"');
      });
    } finally {
      await fixture.close();
    }
  });
}
