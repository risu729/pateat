import type { LoginCaseContext, ProbeChrome } from "./context";
import type { LoginAttemptMetadata } from "../../../packages/contracts/src/index";

export function registerInputEffects({
  test,
  expect,
  withStoppedLoginWorker,
  withLoginExtension,
  startLoginFixture,
  send,
  configure,
  clicks,
  control,
  mutations,
  observeInputEffects,
  expectWatchingWithoutAttempt,
  expectInputOutcome,
}: Pick<
  LoginCaseContext,
  | "test"
  | "expect"
  | "withStoppedLoginWorker"
  | "withLoginExtension"
  | "startLoginFixture"
  | "send"
  | "configure"
  | "clicks"
  | "control"
  | "mutations"
  | "observeInputEffects"
  | "expectWatchingWithoutAttempt"
  | "expectInputOutcome"
>): void {
  for (const event of ["input", "change"] as const) {
    test(`${event} submission sends one validated POST without a fallback click`, async () => {
      const fixture = await startLoginFixture();
      try {
        await withLoginExtension(async (context, _worker, id) => {
          const options = await context.newPage();
          await configure(options, id, fixture.origin);
          const runId = fixture.createRun();
          const page = await context.newPage();
          await page.goto(`${fixture.origin}/${event}-submit?runId=${runId}`);
          await expectInputOutcome(options, "authenticated");
          expect(fixture.evidence(runId)).toEqual({
            posts: 1,
            inputPosts: 1,
            clickPosts: 0,
            allMatched: true,
          });
          expect(await mutations(page)).toBe(1);
          await expect(page.locator("#authenticated")).toBeVisible();
        });
      } finally {
        await fixture.close();
      }
    });
  }

  for (const outcome of ["credential-rejected", "unknown"] as const) {
    test(`an input ${outcome} result never causes a refill or fallback click`, async () => {
      const fixture = await startLoginFixture();
      try {
        await withLoginExtension(async (context, _worker, id) => {
          const options = await context.newPage();
          await configure(options, id, fixture.origin);
          const runId = fixture.createRun(outcome);
          const page = await context.newPage();
          await page.goto(`${fixture.origin}/input-submit?runId=${runId}`);
          await expect(page.locator("#effect-status")).toHaveText("POST result received");
          await expectInputOutcome(options, outcome === "unknown" ? "unknown-submit" : outcome);
          expect(fixture.evidence(runId)).toEqual({
            posts: 1,
            inputPosts: 1,
            clickPosts: 0,
            allMatched: true,
          });
          expect(await mutations(page)).toBe(1);
          await expect(page.locator("#authenticated")).toHaveCount(0);
        });
      } finally {
        await fixture.close();
      }
    });
  }

  test("a delayed input response authenticates without another submission", async () => {
    const fixture = await startLoginFixture();
    try {
      await withLoginExtension(async (context, _worker, id) => {
        const options = await context.newPage();
        await configure(options, id, fixture.origin);
        const runId = fixture.createRun("authenticated", true);
        const page = await context.newPage();
        await page.goto(`${fixture.origin}/input-submit?runId=${runId}`);
        await expect.poll(() => fixture.evidence(runId).posts).toBe(1);
        await expect(page.locator("#effect-status")).toHaveText("No POST observed");
        fixture.releaseResult(runId);
        await expectInputOutcome(options, "authenticated");
        expect(fixture.evidence(runId)).toEqual({
          posts: 1,
          inputPosts: 1,
          clickPosts: 0,
          allMatched: true,
        });
        expect(await mutations(page)).toBe(1);
      });
    } finally {
      await fixture.close();
    }
  });

  test("input advancement and the later password click each send one validated POST", async () => {
    const fixture = await startLoginFixture();
    try {
      await withLoginExtension(async (context, _worker, id) => {
        const options = await context.newPage();
        await configure(options, id, fixture.origin);
        const runId = fixture.createRun();
        const page = await context.newPage();
        await page.goto(`${fixture.origin}/input-advance?runId=${runId}`);
        await expect(page.locator("#authenticated")).toBeVisible();
        await expect
          .poll(() => fixture.evidence(runId))
          .toEqual({ posts: 2, inputPosts: 1, clickPosts: 1, allMatched: true });
        expect(await send(options, { version: 1, type: "login.probe.status" })).toMatchObject({
          attempts: [{ submissions: 2 }],
        });
      });
    } finally {
      await fixture.close();
    }
  });

  test("an uncertain preparation fill retains its marker after restart without clicking next", async () => {
    const fixture = await startLoginFixture();
    try {
      await withLoginExtension(async (context, worker, id) => {
        const options = await context.newPage();
        await configure(options, id, fixture.origin);
        await control(options, "before-ack");
        const runId = fixture.createRun("unknown");
        const page = await context.newPage();
        await page.goto(`${fixture.origin}/identity?runId=${runId}`);
        await expect
          .poll(async () => await send(options, { version: 1, type: "login.probe.status" }))
          .toMatchObject({
            checkpoint: "before-ack",
            attempts: [
              {
                state: "executing",
                operationKind: "fill",
                operationEffect: "prepare",
                mutationIntent: true,
                submissions: 0,
              },
            ],
          });
        await page.evaluate(() => {
          (document.getElementById("branch") as HTMLInputElement).value =
            "synthetic-preparation-marker";
        });
        await withStoppedLoginWorker(context, worker, options, async (expectRestarted) => {
          await expect
            .poll(async () => await send(options, { version: 1, type: "login.probe.status" }))
            .toMatchObject({
              attempts: [
                {
                  state: "reconciling",
                  outcome: "unknown-submit",
                  operationKind: "fill",
                  operationEffect: "prepare",
                  submissions: 0,
                },
              ],
            });
          await expectRestarted();
          const until = Date.now() + 4000;
          /* eslint-disable no-await-in-loop */
          while (Date.now() < until) {
            expect(fixture.evidence(runId).posts).toBe(0);
            await expect(page.locator("#branch")).toHaveValue("synthetic-preparation-marker");
            expect(
              await page.evaluate(() => Number(sessionStorage.getItem("identityClicks") || 0)),
            ).toBe(0);
            await new Promise<void>((finish) => setTimeout(finish, 50));
          }
          /* eslint-enable no-await-in-loop */
          await expect(page).toHaveURL(`${fixture.origin}/identity?runId=${runId}`);
        });
      });
    } finally {
      await fixture.close();
    }
  });

  test("interruption after durable input intent but before delivery cannot replay the fill", async () => {
    const fixture = await startLoginFixture();
    try {
      await withLoginExtension(async (context, worker, id) => {
        const options = await context.newPage();
        await configure(options, id, fixture.origin);
        await control(options, "before-delivery");
        const runId = fixture.createRun("unknown");
        const page = await context.newPage();
        await page.goto(`${fixture.origin}/input-submit?runId=${runId}`);
        await expect
          .poll(async () => await send(options, { version: 1, type: "login.probe.status" }))
          .toMatchObject({
            checkpoint: "before-delivery",
            attempts: [
              {
                state: "submit-intent",
                mutationIntent: true,
                operationKind: "fill",
                submissions: 1,
              },
            ],
          });
        expect(fixture.evidence(runId).posts).toBe(0);
        expect(await mutations(page)).toBe(0);
        await withStoppedLoginWorker(context, worker, options, async (expectRestarted) => {
          await expectInputOutcome(options, "unknown-submit");
          await expectRestarted();
          await observeInputEffects(page, fixture, runId, 0);
          expect(fixture.evidence(runId).posts).toBe(0);
          expect(await mutations(page)).toBe(0);
          await expect(page.locator("#password")).toHaveValue("");
        });
      });
    } finally {
      await fixture.close();
    }
  });

  for (const outcome of ["authenticated", "credential-rejected", "unknown"] as const) {
    test(`a lost input acknowledgment recovers ${outcome} without another POST`, async () => {
      const fixture = await startLoginFixture();
      try {
        await withLoginExtension(async (context, worker, id) => {
          const options = await context.newPage();
          await configure(options, id, fixture.origin);
          await control(options, "before-ack");
          const runId = fixture.createRun(outcome, true);
          const page = await context.newPage();
          await page.goto(`${fixture.origin}/input-submit?runId=${runId}`);
          await expect.poll(() => fixture.evidence(runId).posts).toBe(1);
          await expect
            .poll(async () => await send(options, { version: 1, type: "login.probe.status" }))
            .toMatchObject({
              checkpoint: "before-ack",
              attempts: [
                {
                  state: "submit-intent",
                  mutationIntent: true,
                  operationKind: "fill",
                  submissions: 1,
                },
              ],
            });
          await page.evaluate(() => {
            (document.getElementById("password") as HTMLInputElement).value =
              "synthetic-after-effect-marker";
          });
          await withStoppedLoginWorker(context, worker, options, async (expectRestarted) => {
            await expect
              .poll(async () => await send(options, { version: 1, type: "login.probe.status" }))
              .toMatchObject({
                attempts: [{ state: "reconciling", operationKind: "fill", submissions: 1 }],
              });
            await expectRestarted();
            fixture.releaseResult(runId);
            await expectInputOutcome(options, outcome === "unknown" ? "unknown-submit" : outcome);
            if (outcome === "unknown") await observeInputEffects(page, fixture, runId, 1);
            expect(fixture.evidence(runId)).toEqual({
              posts: 1,
              inputPosts: 1,
              clickPosts: 0,
              allMatched: true,
            });
            expect(await mutations(page)).toBe(1);
            await expect(page.locator("#password")).toHaveValue("synthetic-after-effect-marker");
          });
        });
      } finally {
        await fixture.close();
      }
    });
  }

  test("a missing first-step input never starts an attempt, mutation or POST", async () => {
    const fixture = await startLoginFixture();
    try {
      await withLoginExtension(async (context, _worker, id) => {
        const options = await context.newPage();
        await configure(options, id, fixture.origin);
        const runId = fixture.createRun();
        const page = await context.newPage();
        await page.goto(`${fixture.origin}/input-submit?runId=${runId}&missing=1`);
        await expectWatchingWithoutAttempt(options);
        expect(fixture.evidence(runId).posts).toBe(0);
        expect(await mutations(page)).toBe(0);
        await expect(page.locator("input")).toHaveValue("");
      });
    } finally {
      await fixture.close();
    }
  });

  test("an input intent journal failure prevents delivery and mutation", async () => {
    const fixture = await startLoginFixture();
    try {
      await withLoginExtension(async (context, _worker, id) => {
        const options = await context.newPage();
        await configure(options, id, fixture.origin);
        await control(options, "intent-write-failure");
        const runId = fixture.createRun();
        const page = await context.newPage();
        await page.goto(`${fixture.origin}/input-submit?runId=${runId}`);
        await expect
          .poll(async () => await send(options, { version: 1, type: "login.probe.status" }))
          .toMatchObject({
            attempts: [{ state: "reconciling" }],
          });
        expect(fixture.evidence(runId).posts).toBe(0);
        expect(await mutations(page)).toBe(0);
        await expect(page.locator("#password")).toHaveValue("");
      });
    } finally {
      await fixture.close();
    }
  });

  test("a synchronous field replacement cannot redirect the remaining values", async () => {
    const fixture = await startLoginFixture();
    try {
      await withLoginExtension(async (context, _worker, id) => {
        const options = await context.newPage();
        await configure(options, id, fixture.origin);
        const page = await context.newPage();
        await page.goto(`${fixture.origin}/identity?replace-on-fill=1`);
        await expect(page.locator("#decoy")).toBeVisible();
        await expect
          .poll(async () =>
            JSON.stringify(await send(options, { version: 1, type: "login.probe.status" })),
          )
          .toMatch(/cancelled|retry-limit/);
        await expect(page.locator("#decoy")).toHaveValue("");
        await expect(page.locator("#account")).toHaveValue("");
        expect(
          await page.evaluate(() => Number(sessionStorage.getItem("identityClicks") || 0)),
        ).toBe(0);
      });
    } finally {
      await fixture.close();
    }
  });

  test("worker startup prunes persisted ownership for a closed tab", async () => {
    const fixture = await startLoginFixture();
    try {
      await withLoginExtension(async (context, worker, id) => {
        const options = await context.newPage();
        await configure(options, id, fixture.origin);
        const owner = await context.newPage();
        await owner.goto(`${fixture.origin}/single`);
        await expect(owner.locator("#authenticated")).toBeVisible();
        await expect
          .poll(async () => await send(options, { version: 1, type: "login.probe.status" }))
          .toMatchObject({ attempts: [{ state: "authenticated" }] });
        const before = (await send(options, { version: 1, type: "login.probe.status" })) as {
          attempts: LoginAttemptMetadata[];
        };
        const journal = before.attempts[0]!;
        await owner.close();
        const storageKey = "pateat.login-attempts.v5";
        await expect
          .poll(
            async () =>
              await options.evaluate(async (key) => {
                const chrome = (globalThis as unknown as { chrome: ProbeChrome }).chrome;
                return (await chrome.storage.local.get(key))[key];
              }, storageKey),
          )
          .toEqual([]);
        // Simulate a missed close event by restoring only the real synthetic
        // metadata journal after its target tab and durable owner have been removed.
        await options.evaluate(
          async ({ key, metadata }) => {
            const chrome = (globalThis as unknown as { chrome: ProbeChrome }).chrome;
            await chrome.storage.local.set({ [key]: [metadata] });
          },
          { key: storageKey, metadata: journal },
        );
        expect(
          await options.evaluate(async (key) => {
            const chrome = (globalThis as unknown as { chrome: ProbeChrome }).chrome;
            return (await chrome.storage.local.get(key))[key];
          }, storageKey),
        ).toEqual([journal]);
        await withStoppedLoginWorker(context, worker, options, async (expectRestarted) => {
          await expect
            .poll(
              async () =>
                (
                  (await send(options, { version: 1, type: "login.probe.status" })) as {
                    attempts: unknown[];
                  }
                ).attempts.length,
            )
            .toBe(0);
          await expectRestarted();
          expect(
            await options.evaluate(async (key) => {
              const chrome = (globalThis as unknown as { chrome: ProbeChrome }).chrome;
              return (await chrome.storage.local.get(key))[key];
            }, storageKey),
          ).toEqual([]);
          const next = await context.newPage();
          await next.goto(`${fixture.origin}/single`);
          await expect(next.locator("#authenticated")).toBeVisible();
          expect(await clicks(next)).toBe(1);
        });
      });
    } finally {
      await fixture.close();
    }
  });

  test("a pending submission stays in reconciliation after worker restart without another fill or click", async () => {
    const fixture = await startLoginFixture();
    try {
      await withLoginExtension(async (context, worker, id) => {
        const options = await context.newPage();
        await configure(options, id, fixture.origin);
        const runId = fixture.createRun("unknown");
        const page = await context.newPage();
        await page.goto(`${fixture.origin}/unknown?runId=${runId}`);
        await expect.poll(() => clicks(page)).toBe(1);
        await expect.poll(() => fixture.evidence(runId).posts).toBe(1);
        await expect
          .poll(
            async () =>
              (
                (await send(options, { version: 1, type: "login.probe.status" })) as {
                  attempts: LoginAttemptMetadata[];
                }
              ).attempts[0],
          )
          .toMatchObject({
            state: "reconciling",
            outcome: "unknown-submit",
            submissions: 1,
          });
        const before = (await send(options, { version: 1, type: "login.probe.status" })) as {
          attempts: LoginAttemptMetadata[];
        };
        const journal = before.attempts[0]!;
        // An unchanged marker after restart also detects an accidental replay of fill.
        await page.locator("#password").fill("synthetic-after-submit-marker");
        await withStoppedLoginWorker(context, worker, options, async (expectRestarted) => {
          // The trusted status request wakes the worker; startup reconnects the existing content script.
          await expect
            .poll(async () => await send(options, { version: 1, type: "login.probe.status" }))
            .toMatchObject({
              attempts: [
                {
                  id: journal.id,
                  state: "reconciling",
                  outcome: "unknown-submit",
                  submissions: 1,
                  stepIndex: journal.stepIndex,
                  operationId: journal.operationId,
                  document: journal.document,
                },
              ],
              documents: [{ documentId: journal.document.documentId }],
            });
          await expectRestarted();
          // Reconnection publishes document identity before drive starts. Observe beyond
          // the coordinator's 3-second result budget so late replay cannot pass this test.
          const observeUntil = Date.now() + 4000;
          /* eslint-disable no-await-in-loop */
          while (Date.now() < observeUntil) {
            const evidence = await page.evaluate(() => ({
              clicks: Number(sessionStorage.getItem("submitClicks") || 0),
              value: (document.getElementById("password") as HTMLInputElement).value,
            }));
            expect(evidence).toEqual({ clicks: 1, value: "synthetic-after-submit-marker" });
            expect(fixture.evidence(runId)).toEqual({
              posts: 1,
              inputPosts: 0,
              clickPosts: 1,
              allMatched: true,
            });
            await new Promise<void>((resolveObservation) => setTimeout(resolveObservation, 50));
          }
          /* eslint-enable no-await-in-loop */
          await expect(page.locator("#password")).toHaveValue("synthetic-after-submit-marker");
          expect(await clicks(page)).toBe(1);
          expect(await send(options, { version: 1, type: "login.probe.status" })).toMatchObject({
            attempts: [
              { id: journal.id, state: "reconciling", outcome: "unknown-submit", submissions: 1 },
            ],
          });
          await expect(page.locator("#authenticated")).toHaveCount(0);
        });
      });
    } finally {
      await fixture.close();
    }
  });
}
