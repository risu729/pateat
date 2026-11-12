import type { LoginCaseContext } from "./context";

export function registerPrimaryLogin({
  test,
  expect,
  withLoginExtension,
  startLoginFixture,
  send,
  configure,
  inactiveTab,
  clicks,
}: Pick<
  LoginCaseContext,
  | "test"
  | "expect"
  | "withLoginExtension"
  | "startLoginFixture"
  | "send"
  | "configure"
  | "inactiveTab"
  | "clicks"
>): void {
  test("executes branch, account and password across documents in an inactive tab", async () => {
    const fixture = await startLoginFixture();
    try {
      await withLoginExtension(async (context, worker, id) => {
        const options = await context.newPage();
        await configure(options, id, fixture.origin);
        await options.bringToFront();
        const pageCreated = context.waitForEvent("page");
        const tab = await inactiveTab(worker, `${fixture.origin}/identity`);
        const page = await pageCreated;
        await expect(page.locator("#authenticated")).toBeVisible();
        const evidence = await page.evaluate(() => ({
          identity: JSON.parse(sessionStorage.getItem("identity") || "null"),
          identityClicks: Number(sessionStorage.getItem("identityClicks") || 0),
          submitClicks: Number(sessionStorage.getItem("submitClicks") || 0),
          passwordMatched: sessionStorage.getItem("passwordMatched"),
          extensionFrames: [...document.querySelectorAll("iframe")].filter((frame) =>
            frame.src.startsWith("chrome-extension://"),
          ).length,
        }));
        expect(evidence.identity).toEqual(["007", "00001234"]);
        expect(evidence.passwordMatched).toBe("true");
        expect(evidence.identityClicks).toBe(1);
        expect(evidence.submitClicks).toBe(1);
        expect(evidence.extensionFrames).toBe(0);
        await expect
          .poll(async () =>
            JSON.stringify(await send(options, { version: 1, type: "login.probe.status" })),
          )
          .toContain('"authenticated"');
        const status = await send(options, { version: 1, type: "login.probe.status" });
        expect(JSON.stringify(status)).not.toContain("Pateat-synthetic-only!");
        expect(JSON.stringify(status)).not.toContain("00001234");
        expect(JSON.stringify(status)).toContain('"authenticated"');
        expect(JSON.stringify(status)).toContain(`"tabId":${tab.id}`);
      });
    } finally {
      await fixture.close();
    }
  });

  test("fills the second identifier set when the account maps only that one (ADR 0027)", async () => {
    const fixture = await startLoginFixture();
    try {
      await withLoginExtension(async (context, _worker, id) => {
        const options = await context.newPage();
        await configure(options, id, fixture.origin);
        const page = await context.newPage();
        await page.goto(`${fixture.origin}/variants`);
        await expect(page.locator("#authenticated")).toBeVisible();
        const evidence = await page.evaluate(() => ({
          identity: JSON.parse(sessionStorage.getItem("identity") || "null"),
          contractFilled: sessionStorage.getItem("contractFilled"),
          submitClicks: Number(sessionStorage.getItem("submitClicks") || 0),
          passwordMatched: sessionStorage.getItem("passwordMatched"),
        }));
        expect(evidence).toEqual({
          identity: ["007", "00001234"],
          contractFilled: "false",
          submitClicks: 1,
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
        expect(status).toContain('"recipeId":"demo-variants"');
        expect(status).toContain('"variant":1');
        expect(status).not.toContain("Pateat-synthetic-only!");
      });
    } finally {
      await fixture.close();
    }
  });

  test("types a read-only password on the page's shuffled software keyboard, one press per character (ADR 0067)", async () => {
    const fixture = await startLoginFixture();
    try {
      await withLoginExtension(async (context, _worker, id) => {
        const options = await context.newPage();
        await configure(options, id, fixture.origin);
        const page = await context.newPage();
        await page.goto(`${fixture.origin}/keypad`);
        await expect(page.locator("#authenticated")).toBeVisible();
        const evidence = await page.evaluate(() => ({
          presses: Number(sessionStorage.getItem("keypadPresses")),
          foreignWrites: Number(sessionStorage.getItem("foreignWrites")),
          submitClicks: Number(sessionStorage.getItem("submitClicks") || 0),
          passwordMatched: sessionStorage.getItem("passwordMatched"),
        }));
        expect(evidence).toEqual({
          presses: [..."Pateat-synthetic-only!"].length,
          foreignWrites: 0,
          submitClicks: 1,
          passwordMatched: "true",
        });
        await expect(page.locator("#password")).toHaveValue("●".repeat(22));
        await expect
          .poll(async () =>
            JSON.stringify(await send(options, { version: 1, type: "login.probe.status" })),
          )
          .toContain('"authenticated"');
        const status = JSON.stringify(
          await send(options, { version: 1, type: "login.probe.status" }),
        );
        expect(status).toContain('"recipeId":"demo-keypad"');
        expect(status).not.toContain("Pateat-synthetic-only!");
      });
    } finally {
      await fixture.close();
    }
  });

  test("types on a software keyboard without an id, named by its position from the input (ADR 0067)", async () => {
    const fixture = await startLoginFixture();
    try {
      await withLoginExtension(async (context, _worker, id) => {
        const options = await context.newPage();
        await configure(options, id, fixture.origin);
        const page = await context.newPage();
        await page.goto(`${fixture.origin}/keypad-position`);
        await expect(page.locator("#authenticated")).toBeVisible();
        expect(
          await page.evaluate(() => ({
            presses: Number(sessionStorage.getItem("keypadPresses")),
            submitClicks: Number(sessionStorage.getItem("submitClicks") || 0),
            passwordMatched: sessionStorage.getItem("passwordMatched"),
          })),
        ).toEqual({
          presses: [..."Pateat-synthetic-only!"].length,
          submitClicks: 1,
          passwordMatched: "true",
        });
      });
    } finally {
      await fixture.close();
    }
  });

  test("a software keyboard that does not fit the value gets no press and no submission (ADR 0067)", async () => {
    const fixture = await startLoginFixture();
    try {
      await withLoginExtension(async (context, _worker, id) => {
        const options = await context.newPage();
        await configure(options, id, fixture.origin);
        // Debug logging records why each step stopped.
        const diagnostics = await context.newPage();
        await diagnostics.goto(`chrome-extension://${id}/diagnostics.html`);
        expect(
          await send(diagnostics, { version: 1, type: "diagnostics.logs.debug", enabled: true }),
        ).toMatchObject({ ok: true });
        const status = async () =>
          JSON.stringify(await send(options, { version: 1, type: "login.probe.status" }));
        // An open keypad without a key for "!", and an input shorter than the value, are
        // refused before anything is pressed; a keypad that opens on the field's press is
        // checked once open, after that press. One tab at a time, since the origin's attempt
        // holds its tab until it closes.
        /* eslint-disable no-await-in-loop */
        for (const [query, outcome] of [
          ["?missing=!&open=1", "value-mismatch"],
          ["?maxlength=8", "value-mismatch"],
          ["?missing=!", "structural-mismatch"],
        ] as const) {
          const page = await context.newPage();
          await page.goto(`${fixture.origin}/keypad${query}`);
          await expect.poll(status).toContain(`"outcome":"${outcome}"`);
          // Cover the click the attempt would have made next.
          await page.waitForTimeout(500);
          expect(
            await page.evaluate(() => Number(sessionStorage.getItem("keypadPresses"))),
            query,
          ).toBe(0);
          await expect(page.locator("#password")).toHaveValue("");
          expect(await clicks(page), query).toBe(0);
          await page.close();
          await expect.poll(status).not.toContain(`"outcome":"${outcome}"`);
        }
        /* eslint-enable no-await-in-loop */
        // The log names the missing key, never which one.
        const exported = JSON.stringify(
          await send(diagnostics, {
            version: 1,
            type: "diagnostics.logs.export",
            includeSites: false,
          }),
        );
        expect(exported).toContain("keypad-key-missing");
        expect(exported).not.toContain("Pateat-synthetic-only!");
      });
    } finally {
      await fixture.close();
    }
  });

  test("a software keyboard that submits by itself partway is never typed on again (ADR 0067)", async () => {
    const fixture = await startLoginFixture();
    try {
      await withLoginExtension(async (context, _worker, id) => {
        const options = await context.newPage();
        await configure(options, id, fixture.origin);
        const page = await context.newPage();
        await page.goto(`${fixture.origin}/keypad?submit-at=4`);
        await expect(page.locator("#rejected")).toBeVisible();
        // The page took the form away after the fourth press: its own submission counts as
        // the step's click, as a code that submits itself does (ADR 0027), and the shown
        // rejection settles the login as rejected, never typed again (ADR 0021 D). The
        // rejection is read in the click's 3-second observation, after which the attempt is
        // released, so the poll allows more than the default 5 seconds.
        await expect
          .poll(async () => await send(options, { version: 1, type: "login.probe.status" }), {
            timeout: 15_000,
          })
          .toMatchObject({ attempts: [], asks: ["rejected"] });
        // Cover several announcements: the page is never typed on or submitted again.
        await page.waitForTimeout(1500);
        expect(
          await page.evaluate(() => ({
            presses: Number(sessionStorage.getItem("keypadPresses")),
            submitClicks: Number(sessionStorage.getItem("submitClicks") || 0),
          })),
        ).toEqual({ presses: 4, submitClicks: 1 });
      });
    } finally {
      await fixture.close();
    }
  });

  test("a software keyboard that submits the right PIN by itself at its last press signs in with no click (ADR 0067)", async () => {
    const fixture = await startLoginFixture();
    try {
      await withLoginExtension(async (context, _worker, id) => {
        const options = await context.newPage();
        await configure(options, id, fixture.origin);
        const page = await context.newPage();
        const length = [..."Pateat-synthetic-only!"].length;
        await page.goto(`${fixture.origin}/keypad?submit-at=${length}`);
        await expect(page.locator("#authenticated")).toBeVisible();
        await expect
          .poll(
            async () =>
              JSON.stringify(await send(options, { version: 1, type: "login.probe.status" })),
            { timeout: 15_000 },
          )
          .toContain('"authenticated"');
        expect(await send(options, { version: 1, type: "login.probe.status" })).toMatchObject({
          attempts: [{ state: "authenticated", submissions: 1 }],
        });
        await page.waitForTimeout(1500);
        // The page's own submission is the only one: Pateat clicked nothing.
        expect(
          await page.evaluate(() => ({
            presses: Number(sessionStorage.getItem("keypadPresses")),
            submitClicks: Number(sessionStorage.getItem("submitClicks") || 0),
            passwordMatched: sessionStorage.getItem("passwordMatched"),
          })),
        ).toEqual({ presses: length, submitClicks: 1, passwordMatched: "true" });
      });
    } finally {
      await fixture.close();
    }
  });

  test("a software keyboard that stops showing its presses partway gets no more presses, and the person is told to reload (ADR 0067)", async () => {
    const fixture = await startLoginFixture();
    try {
      await withLoginExtension(async (context, _worker, id) => {
        const options = await context.newPage();
        await configure(options, id, fixture.origin);
        const diagnostics = await context.newPage();
        await diagnostics.goto(`chrome-extension://${id}/diagnostics.html`);
        expect(
          await send(diagnostics, { version: 1, type: "diagnostics.logs.debug", enabled: true }),
        ).toMatchObject({ ok: true });
        const page = await context.newPage();
        await page.goto(`${fixture.origin}/keypad?keep-after=3`);
        // The fourth press left the input unchanged, so the step stopped there.
        await expect
          .poll(async () => await send(options, { version: 1, type: "login.probe.status" }))
          .toMatchObject({ attempts: [{ state: "blocked", outcome: "fill-rejected" }] });
        // Cover the click the attempt would have made next: nothing more is pressed, and the
        // three characters it showed stay for the person to clear by reloading.
        await page.waitForTimeout(1500);
        expect(
          await page.evaluate(() => ({
            presses: Number(sessionStorage.getItem("keypadPresses")),
            submitClicks: Number(sessionStorage.getItem("submitClicks") || 0),
          })),
        ).toEqual({ presses: 4, submitClicks: 0 });
        await expect(page.locator("#password")).toHaveValue("●●●");
        // The popup reads the stop's cause, which tells the person to reload the page.
        const exported = JSON.stringify(
          await send(diagnostics, {
            version: 1,
            type: "diagnostics.logs.export",
            includeSites: false,
          }),
        );
        expect(exported).toContain("keypad-pressed");
        expect(exported).not.toContain("Pateat-synthetic-only!");
        // The reloaded page is left to the person: the stopped login is resumed, never
        // started again (ADR 0022).
        await page.reload();
        await page.waitForTimeout(1500);
        expect(await page.evaluate(() => Number(sessionStorage.getItem("keypadPresses")))).toBe(0);
        await expect(page.locator("#password")).toHaveValue("");
      });
    } finally {
      await fixture.close();
    }
  });

  test("a software keyboard login the page answers only by marking the input invalid is rejected (ADR 0067, ADR 0029)", async () => {
    const fixture = await startLoginFixture();
    try {
      await withLoginExtension(async (context, _worker, id) => {
        const options = await context.newPage();
        await configure(options, id, fixture.origin);
        const page = await context.newPage();
        await page.goto(`${fixture.origin}/keypad?reject=invalid`);
        await expect(page.locator("#password")).toHaveAttribute("aria-invalid", "true");
        // The read-only input Pateat typed on counts as the step's sign-in input (F1), so the
        // login is released as rejected and is not typed again (ADR 0021 D). With no
        // rejection marker shown, that waits for the click's 3-second observation budget and
        // a second reading a second later (ADR 0029): about 5 seconds, measured 3.9 to 4.9,
        // so the default 5-second poll only just met it.
        await expect
          .poll(async () => await send(options, { version: 1, type: "login.probe.status" }), {
            timeout: 15_000,
          })
          .toMatchObject({ attempts: [], asks: ["rejected"] });
        await page.waitForTimeout(1500);
        expect(
          await page.evaluate(() => ({
            presses: Number(sessionStorage.getItem("keypadPresses")),
            submitClicks: Number(sessionStorage.getItem("submitClicks") || 0),
          })),
        ).toEqual({ presses: [..."Pateat-synthetic-only!"].length, submitClicks: 1 });
      });
    } finally {
      await fixture.close();
    }
  });

  for (const [name, query] of [
    ["in place", ""],
    ["after a pushState URL change", "?push=1"],
  ] as const)
    test(`continues an identifier-first form whose password form shows ${name} (ADR 0013)`, async () => {
      const fixture = await startLoginFixture();
      try {
        await withLoginExtension(async (context, _worker, id) => {
          const options = await context.newPage();
          await configure(options, id, fixture.origin);
          const page = await context.newPage();
          await page.goto(`${fixture.origin}/identifier-first${query}`);
          await expect(page.locator("#authenticated")).toBeVisible({ timeout: 15_000 });
          expect(
            await page.evaluate(() => ({
              identityClicks: Number(sessionStorage.getItem("identityClicks") || 0),
              submitClicks: Number(sessionStorage.getItem("submitClicks") || 0),
              identityMatched: sessionStorage.getItem("identityMatched"),
              passwordMatched: sessionStorage.getItem("passwordMatched"),
            })),
          ).toEqual({
            identityClicks: 1,
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
          expect(status).toContain('"recipeId":"demo-identifier-first"');
          expect(status).not.toContain("Pateat-synthetic-only!");
        });
      } finally {
        await fixture.close();
      }
    });

  test("continues an identifier-first form that swaps its views in place and keeps a hidden password input for the browser (ADR 0013)", async () => {
    const fixture = await startLoginFixture();
    try {
      await withLoginExtension(async (context, _worker, id) => {
        const options = await context.newPage();
        await configure(options, id, fixture.origin);
        const page = await context.newPage();
        await page.goto(`${fixture.origin}/identifier-swap`);
        // One Next and one Sign in on the same button; the kept password input was never
        // taken for the password view.
        await expect(page.locator("#authenticated")).toBeVisible({ timeout: 15_000 });
        expect(
          await page.evaluate(() => ({
            identityClicks: Number(sessionStorage.getItem("identityClicks") || 0),
            submitClicks: Number(sessionStorage.getItem("submitClicks") || 0),
            lookupClicks: Number(sessionStorage.getItem("lookupClicks") || 0),
            identityMatched: sessionStorage.getItem("identityMatched"),
            passwordMatched: sessionStorage.getItem("passwordMatched"),
          })),
        ).toEqual({
          identityClicks: 1,
          submitClicks: 1,
          lookupClicks: 0,
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
        expect(status).toContain('"recipeId":"demo-identifier-swap"');
        expect(status).not.toContain("Pateat-synthetic-only!");
      });
    } finally {
      await fixture.close();
    }
  });
}
