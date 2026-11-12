import type { LoginCaseContext } from "./context";

export function registerCodes({
  test,
  expect,
  logs,
  withLoginExtension,
  startLoginFixture,
  send,
  configure,
  checkedAgain,
  SHORT_STEP_WAIT_MS,
  clicks,
  codeEvidence,
}: Pick<
  LoginCaseContext,
  | "test"
  | "expect"
  | "logs"
  | "withLoginExtension"
  | "startLoginFixture"
  | "send"
  | "configure"
  | "checkedAgain"
  | "SHORT_STEP_WAIT_MS"
  | "clicks"
  | "codeEvidence"
>): void {
  test("fills the TOTP code on the code page and clicks Verify once (ADR 0027)", async () => {
    const fixture = await startLoginFixture();
    try {
      await withLoginExtension(async (context, _worker, id) => {
        const options = await context.newPage();
        await configure(options, id, fixture.origin, true, undefined, true);
        const status = async () =>
          JSON.stringify(await send(options, { version: 1, type: "login.probe.status" }));
        const page = await context.newPage();
        await page.goto(`${fixture.origin}/totp`);
        await expect(page.locator("#authenticated")).toBeVisible();
        await expect.poll(status).toContain('"authenticated"');
        // The code is typed once, one input event per digit.
        expect(await codeEvidence(page)).toEqual({
          codeInputs: 6,
          verifyClicks: 1,
          autoSubmits: 0,
          codeMatched: "true",
        });
        expect(await clicks(page)).toBe(1);
        const text = await status();
        expect(text).toContain('"recipeId":"demo-totp"');
        expect(text).toContain('"handlers":[{"index":0,"start":2}]');
        expect(text).not.toContain("012345");
        expect(text).not.toContain("Pateat-synthetic-only!");
      });
    } finally {
      await fixture.close();
    }
  });

  test("a code page shown again after Verify ends as a challenge without a second code (ADR 0027)", async () => {
    const fixture = await startLoginFixture();
    try {
      await withLoginExtension(async (context, _worker, id) => {
        const options = await context.newPage();
        await configure(options, id, fixture.origin, true, undefined, true);
        const status = async () =>
          JSON.stringify(await send(options, { version: 1, type: "login.probe.status" }));
        const page = await context.newPage();
        await page.goto(`${fixture.origin}/totp?wrong`);
        await expect.poll(status).toContain('"challenge"');
        await expect(page.locator("#code")).toHaveValue("");
        // The code is typed once, one input event per digit.
        expect(await codeEvidence(page)).toEqual({
          codeInputs: 6,
          verifyClicks: 1,
          autoSubmits: 0,
          codeMatched: "true",
        });
      });
    } finally {
      await fixture.close();
    }
  });

  test("an item without a TOTP secret leaves the code page to the person (ADR 0027)", async () => {
    const fixture = await startLoginFixture();
    try {
      await withLoginExtension(async (context, _worker, id) => {
        const options = await context.newPage();
        await configure(options, id, fixture.origin);
        const status = async () =>
          JSON.stringify(await send(options, { version: 1, type: "login.probe.status" }));
        const page = await context.newPage();
        await page.goto(`${fixture.origin}/totp`);
        await expect.poll(status).toContain('"challenge"');
        await expect(page.locator("#code")).toHaveValue("");
        expect(await codeEvidence(page)).toEqual({
          codeInputs: 0,
          verifyClicks: 0,
          autoSubmits: 0,
          codeMatched: null,
        });
        expect(await status()).toContain('"handlers":[]');
      });
    } finally {
      await fixture.close();
    }
  });

  for (const [mode, query, verifyClicks, autoSubmits] of [
    ["gets one Verify click", "split", 1, 0],
    ["that submits on its last digit gets no click", "split&auto", 0, 1],
    ["whose Verify is disabled until the code is in gets one click", "split&ui=disabled", 1, 0],
    [
      "whose Verify is disabled only while the code is partial gets one click",
      "split&ui=partial",
      1,
      0,
    ],
    // Notion's inputs declare no `maxlength` (ADR 0027 amendment of 2026-11-04).
    ["whose inputs declare no maxlength gets one click", "split&ui=unmarked", 1, 0],
  ] as const) {
    test(`a code split into one input per digit is typed one digit per input and ${mode} (ADR 0027)`, async () => {
      const fixture = await startLoginFixture();
      try {
        await withLoginExtension(async (context, _worker, id) => {
          const options = await context.newPage();
          await configure(options, id, fixture.origin, true, undefined, true);
          const status = async () =>
            JSON.stringify(await send(options, { version: 1, type: "login.probe.status" }));
          const page = await context.newPage();
          await page.goto(`${fixture.origin}/totp?${query}`);
          // The password fill waits for the page to settle before its account check.
          await expect(page.locator("#authenticated")).toBeVisible({ timeout: 10_000 });
          await expect.poll(status).toContain('"authenticated"');
          // One input event per digit; the page joins the six inputs into the code.
          expect(await codeEvidence(page)).toEqual({
            codeInputs: 6,
            verifyClicks,
            autoSubmits,
            codeMatched: "true",
          });
          expect(await status()).not.toContain("012345");
        });
      } finally {
        await fixture.close();
      }
    });
  }

  for (const [mode, query] of [
    ["a split code that signs in with a new document", ""],
    ["a split code that signs in within the same document", "?spa=status"],
    ["one code input", "?single"],
  ] as const) {
    test(`a code page without Verify gets the code typed as its submission and no click: ${mode} (#916)`, async () => {
      const fixture = await startLoginFixture();
      try {
        await withLoginExtension(async (context, _worker, id) => {
          const options = await context.newPage();
          await configure(options, id, fixture.origin, true, undefined, true);
          const status = async () =>
            JSON.stringify(await send(options, { version: 1, type: "login.probe.status" }));
          const page = await context.newPage();
          await page.goto(`${fixture.origin}/totp-typed${query}`);
          await expect(page.locator("#authenticated")).toBeVisible({ timeout: 10_000 });
          await expect.poll(status).toContain('"authenticated"');
          // The page submits the code on its last character; nothing is clicked.
          expect(await codeEvidence(page)).toEqual({
            codeInputs: 6,
            verifyClicks: 0,
            autoSubmits: 1,
            codeMatched: "true",
          });
          const text = await status();
          expect(text).toContain('"recipeId":"demo-totp-typed"');
          expect(text).toContain('"handlers":[{"index":0,"start":2}]');
          expect(text).not.toContain("012345");
        });
      } finally {
        await fixture.close();
      }
    });
  }

  test("a code page without Verify that keeps a digit out refuses the code (#916)", async () => {
    const fixture = await startLoginFixture();
    try {
      await withLoginExtension(async (context, worker, id) => {
        const options = await context.newPage();
        await configure(options, id, fixture.origin, true, undefined, true);
        const status = async () =>
          JSON.stringify(await send(options, { version: 1, type: "login.probe.status" }));
        const page = await context.newPage();
        await page.goto(`${fixture.origin}/totp-typed?single&ui=drop`);
        await expect.poll(status).toContain('"outcome":"fill-rejected"');
        await expect
          .poll(() => logs(worker, "login.attempt"))
          .toContainEqual(
            expect.objectContaining({
              state: "blocked",
              outcome: "fill-rejected",
              cause: "typed-refused",
              fieldIndex: 0,
            }),
          );
        // Five of the six characters went in and the page never submitted them.
        expect(await codeEvidence(page)).toEqual({
          codeInputs: 5,
          verifyClicks: 0,
          autoSubmits: 0,
          codeMatched: null,
        });
        expect(await status()).not.toContain("012345");
      });
    } finally {
      await fixture.close();
    }
  });

  for (const [mode, query, cause, codeInputs] of [
    [
      "an input the page changes after the first digit",
      "split&ui=mutate",
      '"outcome":"cancelled"',
      1,
    ],
    ["seven one-digit inputs for a six-digit code", "split&ui=seven", "value-mismatch", 0],
  ] as const) {
    test(`a split code stops without a Verify click on ${mode} (ADR 0027)`, async () => {
      const fixture = await startLoginFixture();
      try {
        await withLoginExtension(async (context, _worker, id) => {
          const options = await context.newPage();
          await configure(options, id, fixture.origin, true, undefined, true);
          const status = async () =>
            JSON.stringify(await send(options, { version: 1, type: "login.probe.status" }));
          const page = await context.newPage();
          await page.goto(`${fixture.origin}/totp?${query}`);
          await expect.poll(status).toContain(cause);
          expect(await codeEvidence(page)).toEqual({
            codeInputs,
            verifyClicks: 0,
            autoSubmits: 0,
            codeMatched: null,
          });
          // The digits typed before the change stop there.
          expect(await page.locator("#code-2").inputValue()).toBe("");
          await expect(page.locator("#authenticated")).toHaveCount(0);
          expect(await status()).not.toContain("012345");
        });
      } finally {
        await fixture.close();
      }
    });
  }

  for (const [mode, query] of [
    ["a Verify button disabled until the code is in", "ui=disabled"],
    ["a Verify button rendered again on every digit", "ui=rerender"],
    ["a digit counter in a live region", "ui=counter"],
  ] as const)
    test(`an ordinary code page gets the code and one Verify click: ${mode} (ADR 0027)`, async () => {
      const fixture = await startLoginFixture();
      try {
        await withLoginExtension(async (context, _worker, id) => {
          const options = await context.newPage();
          await configure(options, id, fixture.origin, true, undefined, true);
          const status = async () =>
            JSON.stringify(await send(options, { version: 1, type: "login.probe.status" }));
          const page = await context.newPage();
          await page.goto(`${fixture.origin}/totp?${query}`);
          await expect(page.locator("#authenticated")).toBeVisible();
          await expect.poll(status).toContain('"authenticated"');
          expect(await codeEvidence(page)).toEqual({
            codeInputs: 6,
            verifyClicks: 1,
            autoSubmits: 0,
            codeMatched: "true",
          });
        });
      } finally {
        await fixture.close();
      }
    });

  for (const [result, query] of [
    ["signs in", "ui=disauto"],
    ["is held when the code is wrong", "ui=disauto&wrong"],
    ["signs in after enabling Verify for a moment", "ui=flicker"],
    ["is held when the code is wrong after enabling Verify for a moment", "ui=flicker&wrong"],
  ] as const)
    test(`a code page that checks the code itself with Verify kept disabled is never clicked: ${result} (ADR 0027)`, async () => {
      const fixture = await startLoginFixture();
      try {
        await withLoginExtension(async (context, _worker, id) => {
          const options = await context.newPage();
          const wrong = query.endsWith("wrong");
          await configure(
            options,
            id,
            fixture.origin,
            true,
            undefined,
            true,
            wrong ? SHORT_STEP_WAIT_MS : undefined,
          );
          const status = async () =>
            JSON.stringify(await send(options, { version: 1, type: "login.probe.status" }));
          const page = await context.newPage();
          await page.goto(`${fixture.origin}/totp?${query}`);
          if (wrong) {
            // The page enables Verify again for another code. The login holds the page for
            // the person and never clicks it, past the click step's own wait: it checks the
            // held page at most twice a round, half a second apart, so these checks span
            // more rounds than that wait has.
            await expect(page.locator("#verify")).toBeEnabled();
            await expect.poll(status).toContain('"state":"reconciling"');
            await checkedAgain(options, 2 * Math.ceil(SHORT_STEP_WAIT_MS / 500) + 4);
            expect(await status()).toContain('"state":"reconciling"');
          } else {
            await expect(page.locator("#authenticated")).toBeVisible();
            await expect.poll(status).toContain('"authenticated"');
          }
          expect(await codeEvidence(page)).toEqual({
            codeInputs: 6,
            verifyClicks: 0,
            autoSubmits: 1,
            codeMatched: "true",
          });
        });
      } finally {
        await fixture.close();
      }
    });

  for (const [mode, query] of [
    ["a new document after a slow verification", "auto&slow"],
    ["a status message and a disabled button in the same document", "auto&spa=status"],
    ["a code input emptied while it verifies", "auto&spa=clear"],
    ["a form rendered again as verifying", "auto&spa=replace"],
  ] as const)
    test(`a code page that verifies its own submission for over a second is never clicked: ${mode} (ADR 0027)`, async () => {
      const fixture = await startLoginFixture();
      try {
        await withLoginExtension(async (context, _worker, id) => {
          const options = await context.newPage();
          await configure(options, id, fixture.origin, true, undefined, true);
          const status = async () =>
            JSON.stringify(await send(options, { version: 1, type: "login.probe.status" }));
          const page = await context.newPage();
          await page.goto(`${fixture.origin}/totp?${query}`);
          await expect(page.locator("#authenticated")).toBeVisible();
          await expect.poll(status).toContain('"authenticated"');
          expect(await codeEvidence(page)).toEqual({
            codeInputs: 6,
            verifyClicks: 0,
            autoSubmits: 1,
            codeMatched: "true",
          });
        });
      } finally {
        await fixture.close();
      }
    });
}
