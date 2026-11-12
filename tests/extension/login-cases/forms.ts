import type { LoginCaseContext } from "./context";
import type { Page } from "@playwright/test";

export function registerForms({
  test,
  expect,
  logs,
  withLoginExtension,
  startLoginFixture,
  send,
  configure,
  SHORT_STEP_WAIT_MS,
  clicks,
  expectWatchingWithoutAttempt,
}: Pick<
  LoginCaseContext,
  | "test"
  | "expect"
  | "logs"
  | "withLoginExtension"
  | "startLoginFixture"
  | "send"
  | "configure"
  | "SHORT_STEP_WAIT_MS"
  | "clicks"
  | "expectWatchingWithoutAttempt"
>): void {
  test("abstains without a saved account and does not try another eligible item", async () => {
    const fixture = await startLoginFixture();
    try {
      await withLoginExtension(async (context, _worker, id) => {
        const options = await context.newPage();
        await configure(options, id, fixture.origin, false);
        const page = await context.newPage();
        await page.goto(`${fixture.origin}/single`);
        await expect
          .poll(async () =>
            JSON.stringify(await send(options, { version: 1, type: "login.probe.status" })),
          )
          .toContain("default-not-set");
        // A fill or retry after the abstain would come within a second.
        await page.waitForTimeout(1000);
        await expect(page.locator("#password")).toHaveValue("");
        expect(await clicks(page)).toBe(0);
        const status = await send(options, { version: 1, type: "login.probe.status" });
        expect(JSON.stringify(status)).not.toContain('"authenticated"');
      });
    } finally {
      await fixture.close();
    }
  });

  test("a page showing another account is not filled, and its account switch is clicked once", async () => {
    const fixture = await startLoginFixture();
    try {
      await withLoginExtension(async (context, _worker, id) => {
        const options = await context.newPage();
        await configure(options, id, fixture.origin);
        const status = async () =>
          JSON.stringify(await send(options, { version: 1, type: "login.probe.status" }));
        // The demo account's username is 00001234. Without a switch control, a page
        // showing another account is left alone; one showing it is filled.
        const other = await context.newPage();
        await other.goto(`${fixture.origin}/single?shown=****9999`);
        await expect.poll(status).toContain("wrong-account");
        await expect(other.locator("#password")).toHaveValue("");
        expect(await clicks(other)).toBe(0);
        await other.close();
        await expect.poll(status).not.toContain("wrong-account");
        // An account shown only after the fields, once the page has loaded it, stops it too.
        const late = await context.newPage();
        await late.goto(`${fixture.origin}/single?shown-late=****9999`);
        await expect.poll(status).toContain("wrong-account");
        await expect(late.locator("#account")).toHaveText("Signed in as ****9999");
        await expect(late.locator("#password")).toHaveValue("");
        expect(await clicks(late)).toBe(0);
        await late.close();
        await expect.poll(status).not.toContain("wrong-account");
        // The password goes in at once and is checked before the click: a late account that
        // is the item's logs in.
        const lateSame = await context.newPage();
        await lateSame.goto(`${fixture.origin}/single?shown-late=****1234`);
        await expect(lateSame.locator("#authenticated")).toBeVisible();
        expect(await clicks(lateSame)).toBe(1);
        await lateSame.close();
        await expect.poll(status).not.toContain("authenticated");
        const same = await context.newPage();
        await same.goto(`${fixture.origin}/single?shown=****1234`);
        await expect(same.locator("#authenticated")).toBeVisible();
        expect(await clicks(same)).toBe(1);
        await same.close();
        await expect.poll(status).not.toContain("authenticated");
        // The switch link leads to a page showing the demo account.
        const page = await context.newPage();
        await page.goto(`${fixture.origin}/single?shown=****9999&switch=****1234`);
        await expect(page.locator("#authenticated")).toBeVisible();
        expect(new URL(page.url()).searchParams.get("shown")).toBe("****1234");
        expect(await clicks(page)).toBe(1);
        await page.close();
        await expect.poll(status).not.toContain("authenticated");
        // A page that still shows another account after the switch is not switched again.
        const loop = await context.newPage();
        let loads = 0;
        loop.on("load", () => {
          loads += 1;
        });
        await loop.goto(`${fixture.origin}/single?shown=****9999&switch=****9999`);
        await expect.poll(status).toContain('"outcome":"wrong-account"');
        expect(loads).toBe(2);
        await expect(loop.locator("#password")).toHaveValue("");
        expect(await clicks(loop)).toBe(0);
        await loop.close();
        await expect.poll(status).not.toContain("wrong-account");
        // Without the recipe's switch, the page's own control for another account is
        // clicked: here an element with only a pointer cursor.
        const pointer = await context.newPage();
        await pointer.goto(
          `${fixture.origin}/delayed-result?shown=****9999&switch-pointer=****1234`,
        );
        await expect(pointer.locator("#authenticated")).toBeVisible({ timeout: 10_000 });
        expect(new URL(pointer.url()).searchParams.get("shown")).toBe("****1234");
        await pointer.close();
        await expect.poll(status).not.toContain("authenticated");
        // One whose next page is slow to load is clicked once, and that page logs in.
        const slow = await context.newPage();
        await slow.goto(
          `${fixture.origin}/delayed-result?shown=****9999&switch-pointer=****1234&switch-slow`,
        );
        await expect(slow.locator("#authenticated")).toBeVisible({ timeout: 15_000 });
        expect(new URL(slow.url()).searchParams.get("shown")).toBe("****1234");
        await slow.close();
        await expect.poll(status).not.toContain("authenticated");
        // One that shows the other account in place, as a single-page app, continues there.
        const inPlace = await context.newPage();
        let inPlaceLoads = 0;
        inPlace.on("load", () => {
          inPlaceLoads += 1;
        });
        await inPlace.goto(
          `${fixture.origin}/delayed-result?shown=****9999&switch-pointer=****1234&switch-in-place`,
        );
        await expect(inPlace.locator("#authenticated")).toBeVisible({ timeout: 10_000 });
        await expect(inPlace.locator("#shown")).toHaveText("Signed in as ****1234");
        expect(inPlaceLoads).toBe(1);
        await inPlace.close();
        await expect.poll(status).not.toContain("authenticated");
        // A switch that would submit a form with a shown field is never clicked.
        const submit = await context.newPage();
        let submitLoads = 0;
        submit.on("load", () => {
          submitLoads += 1;
        });
        await submit.goto(`${fixture.origin}/single?shown=****9999&switch=****1234&switch-submit`);
        await expect.poll(status).toContain('"outcome":"wrong-account"');
        expect(submitLoads).toBe(1);
        expect(new URL(submit.url()).searchParams.get("shown")).toBe("****9999");
      });
    } finally {
      await fixture.close();
    }
  });

  test("clicks a submit button or image button named by its text, and refuses a duplicate", async () => {
    // The duplicate's click step waits out its step wait, then twice more on its retries.
    test.setTimeout(90_000);
    const fixture = await startLoginFixture();
    try {
      await withLoginExtension(async (context, _worker, id) => {
        const options = await context.newPage();
        await configure(options, id, fixture.origin, true, undefined, false, SHORT_STEP_WAIT_MS);
        const status = async () =>
          JSON.stringify(await send(options, { version: 1, type: "login.probe.status" }));
        const authenticates = async (variant: string) => {
          const page = await context.newPage();
          await page.goto(`${fixture.origin}/text-submit?button=${variant}`);
          await expect(page.locator("#authenticated")).toBeVisible();
          expect(await clicks(page)).toBe(1);
          await page.close();
        };
        await authenticates("text");
        await authenticates("image");
        const duplicate = await context.newPage();
        await duplicate.goto(`${fixture.origin}/text-submit?button=duplicate`);
        // An ambiguous click target is waited on like a missing one, for the whole step wait,
        // and the step is tried twice more before the attempt stops.
        await expect.poll(status, { timeout: 45_000 }).toContain("retry-limit");
        // The fill step ran, so the attempt stopped at the ambiguous click.
        await expect(duplicate.locator("#password")).not.toHaveValue("");
        expect(await clicks(duplicate)).toBe(0);
      });
    } finally {
      await fixture.close();
    }
  });

  test("submits a form without a button by Enter in its last field, never through a button it showed (ADR 0064)", async () => {
    const fixture = await startLoginFixture();
    try {
      await withLoginExtension(async (context, _worker, id) => {
        const options = await context.newPage();
        await configure(options, id, fixture.origin);
        const count = (page: Page, key: string) =>
          page.evaluate((name) => Number(sessionStorage.getItem(name) || 0), key);
        // Without a submit button the form is submitted with `requestSubmit()`; with one that
        // appeared as the password went in, that button is clicked, as Enter does.
        /* eslint-disable no-await-in-loop */
        for (const [query, buttonClicks] of [
          ["", 0],
          ["?late", 1],
        ] as const) {
          const page = await context.newPage();
          await page.goto(`${fixture.origin}/enter-submit${query}`);
          await expect(page.locator("#authenticated")).toBeVisible();
          expect(await clicks(page)).toBe(1);
          expect(await count(page, "buttonClicks")).toBe(buttonClicks);
          await page.close();
        }
        // A "Sign up" submit button or image input shown before the fill is never pressed,
        // nor the form sent: the step fails as a click that finds no target does.
        for (const query of ["?shown", "?image"]) {
          const shown = await context.newPage();
          await shown.goto(`${fixture.origin}/enter-submit${query}`);
          await expect
            .poll(async () => await send(options, { version: 1, type: "login.probe.status" }))
            .toMatchObject({
              attempts: [{ recipeId: "demo-enter-submit", outcome: "structural-mismatch" }],
            });
          await expect(shown.locator("#password")).not.toHaveValue("");
          expect(await clicks(shown)).toBe(0);
          expect(await count(shown, "signUpClicks")).toBe(0);
          await shown.close();
          // Closing the tab releases its record before the next page starts.
          await expect
            .poll(async () => await send(options, { version: 1, type: "login.probe.status" }))
            .toMatchObject({ attempts: [] });
        }
        /* eslint-enable no-await-in-loop */
      });
    } finally {
      await fixture.close();
    }
  });

  test("waits for delayed same-page success and rejection without resubmitting", async () => {
    const fixture = await startLoginFixture();
    try {
      await withLoginExtension(async (context, _worker, id) => {
        const options = await context.newPage();
        await configure(options, id, fixture.origin);
        // Each result case must close its origin owner before the next login starts.
        /* eslint-disable no-await-in-loop */
        for (const outcome of ["authenticated", "credential-rejected"] as const) {
          const page = await context.newPage();
          await page.goto(
            `${fixture.origin}/delayed-result${outcome === "credential-rejected" ? "?reject=1" : ""}`,
          );
          await expect(
            page.locator(outcome === "authenticated" ? "#authenticated" : "#rejected"),
          ).toBeVisible();
          await expect
            .poll(async () =>
              JSON.stringify(await send(options, { version: 1, type: "login.probe.status" })),
            )
            .toContain(
              outcome === "credential-rejected" ? '"asks":["rejected"]' : `"outcome":"${outcome}"`,
            );
          // A released rejection must not log in again in its page: its announcement after
          // the release was refused while the tab asks.
          if (outcome === "credential-rejected")
            await expect
              .poll(async () => await send(options, { version: 1, type: "login.probe.status" }))
              .toMatchObject({ documents: [{ state: "denied", reason: "account-asked" }] });
          expect(await clicks(page)).toBe(1);
          await page.close();
          // Closing the tab ends its record and its ask, so the next page logs in afresh.
          await expect
            .poll(async () => {
              const status = (await send(options, { version: 1, type: "login.probe.status" })) as {
                attempts: unknown[];
                asks: unknown[];
              };
              return status.attempts.length + status.asks.length;
            })
            .toBe(0);
        }
        /* eslint-enable no-await-in-loop */
      });
    } finally {
      await fixture.close();
    }
  });

  test("ambiguous first-step fields never start an attempt, fill or submission", async () => {
    const fixture = await startLoginFixture();
    try {
      await withLoginExtension(async (context, _worker, id) => {
        const options = await context.newPage();
        await configure(options, id, fixture.origin);
        const page = await context.newPage();
        await page.goto(`${fixture.origin}/ambiguous`);
        await expectWatchingWithoutAttempt(options);
        expect(
          await page
            .locator('input[name="password"]')
            .evaluateAll((fields) => fields.map((field) => (field as HTMLInputElement).value)),
        ).toEqual(["", ""]);
        expect(await clicks(page)).toBe(0);
      });
    } finally {
      await fixture.close();
    }
  });

  test("a password fills only a password input and one step stays inside one form", async () => {
    const fixture = await startLoginFixture();
    try {
      await withLoginExtension(async (context, _worker, id) => {
        const options = await context.newPage();
        await configure(options, id, fixture.origin);
        const status = async () =>
          JSON.stringify(await send(options, { version: 1, type: "login.probe.status" }));
        const text = await context.newPage();
        await text.goto(`${fixture.origin}/single?password-input=text`);
        await expect.poll(status).toContain("retry-limit");
        await expect(text.locator("#password")).toHaveValue("");
        expect(await clicks(text)).toBe(0);
        await text.close();
        await expect.poll(status).not.toContain("retry-limit");
        const split = await context.newPage();
        await split.goto(`${fixture.origin}/identity?split-forms`);
        await expect.poll(status).toContain("retry-limit");
        await expect(split.locator("#branch")).toHaveValue("");
        await expect(split.locator("#account")).toHaveValue("");
        expect(
          await split.evaluate(() => Number(sessionStorage.getItem("identityClicks") || 0)),
        ).toBe(0);
        await split.close();
        await expect.poll(status).not.toContain("retry-limit");
        const mixed = await context.newPage();
        await mixed.goto(`${fixture.origin}/identity?account-form`);
        await expect.poll(status).toContain("retry-limit");
        await expect(mixed.locator("#branch")).toHaveValue("");
        await mixed.close();
        await expect.poll(status).not.toContain("retry-limit");
        // A page handler that moves the next input into another form stops the remaining writes.
        const moved = await context.newPage();
        await moved.goto(`${fixture.origin}/identity?move-on-fill`);
        await expect.poll(status).toContain("cancelled");
        await expect(moved.locator("#branch")).toHaveValue("007");
        await expect(moved.locator("#account")).toHaveValue("");
        expect(
          await moved.evaluate(() => Number(sessionStorage.getItem("identityClicks") || 0)),
        ).toBe(0);
        await moved.close();
        await expect.poll(status).not.toContain("cancelled");
        // Two of the step's locators name one input: nothing is filled or submitted, since
        // the second value would replace the first.
        const shared = await context.newPage();
        await shared.goto(`${fixture.origin}/shared-input`);
        await expect.poll(status).toContain("retry-limit");
        await expect(shared.locator("#account")).toHaveValue("");
        expect(await clicks(shared)).toBe(0);
        await shared.close();
        await expect.poll(status).not.toContain("retry-limit");
        const declared = await context.newPage();
        await declared.goto(`${fixture.origin}/single?password-input=text-current-password`);
        await expect(declared.locator("#authenticated")).toBeVisible();
        expect(await clicks(declared)).toBe(1);
      });
    } finally {
      await fixture.close();
    }
  });

  test("values the page would not accept are never submitted", async () => {
    const fixture = await startLoginFixture();
    try {
      await withLoginExtension(async (context, worker, id) => {
        const options = await context.newPage();
        await configure(options, id, fixture.origin);
        const status = async () =>
          JSON.stringify(await send(options, { version: 1, type: "login.probe.status" }));
        // The synthetic password is longer than the input allows: nothing is filled.
        const short = await context.newPage();
        await short.goto(`${fixture.origin}/single?maxlength=8`);
        await expect.poll(status).toContain("value-mismatch");
        await expect(short.locator("#password")).toHaveValue("");
        expect(await clicks(short)).toBe(0);
        await short.close();
        await expect.poll(status).not.toContain("value-mismatch");
        // The page's own handlers reject the filled value: the login button is never clicked.
        // One tab at a time, since the origin's attempt holds its tab until it closes.
        /* eslint-disable no-await-in-loop */
        for (const [rejection, cause, fieldIndex] of [
          ["alert", "alert-shown", undefined],
          ["invalid", "aria-invalid", 0],
          ["custom", "input-custom-error", 0],
        ] as const) {
          const page = await context.newPage();
          await page.goto(`${fixture.origin}/single?reject-fill=${rejection}`);
          await expect.poll(status).toContain("fill-rejected");
          await expect
            .poll(async () => {
              const rejected = (await logs(worker, "login.attempt")).find(
                (entry) => entry["outcome"] === "fill-rejected" && entry["cause"] === cause,
              );
              return rejected && [rejected["cause"], rejected["fieldIndex"]];
            })
            .toEqual([cause, fieldIndex]);
          // Cover the click the attempt would have made next.
          await page.waitForTimeout(500);
          expect(await clicks(page)).toBe(0);
          await page.close();
          await expect.poll(status).not.toContain("fill-rejected");
        }
        /* eslint-enable no-await-in-loop */
        // The page clears the field and shows another password field: the form is not sent.
        const switched = await context.newPage();
        await switched.goto(`${fixture.origin}/single?reject-fill=switch-form`);
        await expect.poll(status).toContain("structural-mismatch");
        await expect(switched.locator("#security")).toBeVisible();
        await switched.waitForTimeout(500);
        expect(await clicks(switched)).toBe(0);
        await switched.close();
        await expect.poll(status).not.toContain("structural-mismatch");
        // A message the page already showed, rendered again on input, is not a rejection.
        const shown = await context.newPage();
        await shown.goto(`${fixture.origin}/single?reject-fill=shown`);
        await expect(shown.locator("#authenticated")).toBeVisible();
        expect(await clicks(shown)).toBe(1);
      });
    } finally {
      await fixture.close();
    }
  });

  test("values never go into or submit a form bound for another origin", async () => {
    const fixture = await startLoginFixture();
    try {
      await withLoginExtension(async (context, _worker, id) => {
        const options = await context.newPage();
        await configure(options, id, fixture.origin);
        const status = async () => await send(options, { version: 1, type: "login.probe.status" });
        // The password's form posts to another site: the fill is refused on every retry, so
        // nothing is filled or clicked.
        const fill = await context.newPage();
        await fill.goto(`${fixture.origin}/single?form=off-origin`);
        await expect.poll(status).toMatchObject({
          attempts: [{ operationKind: "fill", outcome: "retry-limit", submissions: 0 }],
        });
        await expect(fill.locator("#password")).toHaveValue("");
        expect(await clicks(fill)).toBe(0);
        await fill.close();
        await expect.poll(status).toMatchObject({ attempts: [] });
        // The password is outside any form, but the submit button's formaction names another
        // origin: the fill proceeds and the click is refused.
        const submit = await context.newPage();
        await submit.goto(`${fixture.origin}/single?form=submit-off-origin`);
        await expect.poll(status).toMatchObject({
          attempts: [{ operationKind: "click", outcome: "structural-mismatch" }],
        });
        await expect(submit.locator("#password")).not.toHaveValue("");
        // Cover the time a click's handler would take to count it.
        await submit.waitForTimeout(500);
        expect(await clicks(submit)).toBe(0);
        expect(submit.url()).toBe(`${fixture.origin}/single?form=submit-off-origin`);
        await submit.close();
        await expect.poll(status).toMatchObject({ attempts: [] });
        // A form that submits to its own page is filled and submitted.
        const same = await context.newPage();
        await same.goto(`${fixture.origin}/single?form=same-origin`);
        await expect(same.locator("#authenticated")).toBeVisible();
        expect(await clicks(same)).toBe(1);
        await same.close();
        // A form whose action is a javascript: URL sends the values nowhere, so it is filled
        // and submitted too.
        const script = await context.newPage();
        await script.goto(`${fixture.origin}/single?form=script`);
        await expect(script.locator("#authenticated")).toBeVisible();
        expect(await clicks(script)).toBe(1);
        await script.close();
        // A button outside any form submits nothing, so its click proceeds.
        const outside = await context.newPage();
        await outside.goto(`${fixture.origin}/single`);
        await expect(outside.locator("#authenticated")).toBeVisible();
        expect(await clicks(outside)).toBe(1);
      });
    } finally {
      await fixture.close();
    }
  });
}
