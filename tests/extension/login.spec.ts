import { test, expect, type Page, type Worker } from "@playwright/test";
import type { LoginAttemptMetadata, SettingsResponse } from "../../packages/contracts/src/index";
import { withStoppedLoginWorker, withLoginExtension } from "./login-fixture";
import { startLoginFixture } from "./login-server";

type ProbeChrome = {
  runtime: { sendMessage: (message: unknown) => Promise<unknown> };
  tabs: { create: (options: { url: string; active: boolean }) => Promise<{ id: number }> };
  storage: {
    local: {
      get: (key: string) => Promise<Record<string, unknown>>;
      set: (values: Record<string, unknown>) => Promise<void>;
    };
  };
};

async function send(page: Page, message: unknown): Promise<unknown> {
  return page.evaluate(async (request) => {
    const chrome = (globalThis as unknown as { chrome: ProbeChrome }).chrome;
    return await chrome.runtime.sendMessage(request);
  }, message);
}

async function configure(options: Page, extensionId: string, origin: string, selectAccount = true) {
  await options.goto(`chrome-extension://${extensionId}/options.html`);
  await expect(options.locator("#settings-status")).toContainText("Saved settings loaded");
  expect(await send(options, { version: 1, type: "login.probe.configure", origin })).toMatchObject({
    ok: true,
  });
  const response = (await send(options, { version: 1, type: "settings.get" })) as SettingsResponse;
  if (!response.ok) throw new Error("Synthetic settings unavailable");
  const settings = response.snapshot.settings;
  settings.siteDefaults = selectAccount
    ? [{ origin, connectionId: "demo-personal", itemId: "primary" }]
    : [];
  const saved = (await send(options, {
    version: 1,
    type: "settings.save",
    expectedRevision: response.snapshot.revision,
    settings,
  })) as SettingsResponse;
  expect(saved.ok).toBe(true);
}

async function inactiveTab(worker: Worker, url: string) {
  return worker.evaluate(async (targetUrl) => {
    const chrome = (globalThis as unknown as { chrome: ProbeChrome }).chrome;
    return await chrome.tabs.create({ url: targetUrl, active: false });
  }, url);
}

async function clicks(page: Page) {
  return page.evaluate(() => Number(sessionStorage.getItem("submitClicks") || 0));
}

async function control(
  options: Page,
  checkpoint: "before-delivery" | "before-ack" | "intent-write-failure",
) {
  expect(
    await send(options, {
      version: 1,
      type: "login.probe.control",
      action: "arm",
      checkpoint,
    }),
  ).toMatchObject({ ok: true });
}

async function mutations(page: Page) {
  return page.evaluate(
    () => (globalThis as unknown as { syntheticMutations: number }).syntheticMutations,
  );
}

async function observeInputEffects(
  page: Page,
  fixture: Awaited<ReturnType<typeof startLoginFixture>>,
  runId: string,
  count: number,
) {
  // A restored unknown outcome can be published before async reconciliation starts.
  // Cover its full three-second observation budget before making negative assertions.
  const until = Date.now() + 4000;
  /* eslint-disable no-await-in-loop */
  while (Date.now() < until) {
    expect(fixture.evidence(runId)).toEqual({
      posts: count,
      inputPosts: count,
      clickPosts: 0,
      allMatched: true,
    });
    expect(await mutations(page)).toBe(count);
    await new Promise<void>((finish) => setTimeout(finish, 50));
  }
  /* eslint-enable no-await-in-loop */
}

async function expectInputOutcome(
  options: Page,
  result: "authenticated" | "credential-rejected" | "unknown-submit",
) {
  await expect
    .poll(async () => await send(options, { version: 1, type: "login.probe.status" }))
    .toMatchObject({
      attempts: [
        {
          state:
            result === "authenticated"
              ? "authenticated"
              : result === "credential-rejected"
                ? "blocked"
                : "reconciling",
          outcome: result,
          operationKind: "fill",
          submissions: 1,
        },
      ],
    });
}

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
            { state: "submit-intent", mutationIntent: true, operationKind: "fill", submissions: 1 },
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

test("a missing input target fails before any mutation or POST", async () => {
  const fixture = await startLoginFixture();
  try {
    await withLoginExtension(async (context, _worker, id) => {
      const options = await context.newPage();
      await configure(options, id, fixture.origin);
      const runId = fixture.createRun();
      const page = await context.newPage();
      await page.goto(`${fixture.origin}/input-submit?runId=${runId}&missing=1`);
      await expect
        .poll(async () => await send(options, { version: 1, type: "login.probe.status" }))
        .toMatchObject({
          attempts: [{ state: "retryable", outcome: "structural-mismatch", submissions: 0 }],
        });
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
        .toMatch(/cancelled|structural-mismatch/);
      await expect(page.locator("#decoy")).toHaveValue("");
      await expect(page.locator("#account")).toHaveValue("");
      expect(await page.evaluate(() => Number(sessionStorage.getItem("identityClicks") || 0))).toBe(
        0,
      );
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
      const storageKey = "pateat.login-attempts.v1";
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

test("abstains without a saved account and does not try another eligible item", async () => {
  const fixture = await startLoginFixture();
  try {
    await withLoginExtension(async (context, _worker, id) => {
      const options = await context.newPage();
      await configure(options, id, fixture.origin, false);
      const page = await context.newPage();
      await page.goto(`${fixture.origin}/single`);
      await expect(page.locator("#password")).toHaveValue("");
      await expect
        .poll(async () =>
          JSON.stringify(await send(options, { version: 1, type: "login.probe.status" })),
        )
        .toContain("default-not-set");
      expect(await clicks(page)).toBe(0);
      const status = await send(options, { version: 1, type: "login.probe.status" });
      expect(JSON.stringify(status)).not.toContain('"authenticated"');
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
          .toContain(`"outcome":"${outcome}"`);
        expect(await clicks(page)).toBe(1);
        await page.close();
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
      }
      /* eslint-enable no-await-in-loop */
    });
  } finally {
    await fixture.close();
  }
});

test("ambiguous fields stop without filling either candidate or submitting", async () => {
  const fixture = await startLoginFixture();
  try {
    await withLoginExtension(async (context, _worker, id) => {
      const options = await context.newPage();
      await configure(options, id, fixture.origin);
      const page = await context.newPage();
      await page.goto(`${fixture.origin}/ambiguous`);
      await expect
        .poll(async () =>
          JSON.stringify(await send(options, { version: 1, type: "login.probe.status" })),
        )
        .toContain("structural-mismatch");
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
        .toContain("credential-rejected");
      expect(await clicks(rejected)).toBe(1);
      await rejected.close();
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
      await expect.poll(() => clicks(unknown)).toBe(1);
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
      await expect
        .poll(async () =>
          JSON.stringify(await send(options, { version: 1, type: "login.probe.status" })),
        )
        .toContain("unknown-submit");
      const after = (await send(options, { version: 1, type: "login.probe.status" })) as {
        attempts: { document: { documentId: string } }[];
      };
      expect(after.attempts[0]!.document.documentId).not.toBe(originalDocument);
      await expect(page.locator("#password")).toHaveValue("");
      expect(await clicks(page)).toBe(0);
    });
  } finally {
    await fixture.close();
  }
});

test("a competing tab cannot race the existing owner of the same site session", async () => {
  const fixture = await startLoginFixture();
  try {
    await withLoginExtension(async (context, _worker, id) => {
      const options = await context.newPage();
      await configure(options, id, fixture.origin);
      const first = await context.newPage();
      await first.goto(`${fixture.origin}/single`);
      await expect(first.locator("#authenticated")).toBeVisible();
      const second = await context.newPage();
      await second.goto(`${fixture.origin}/single`);
      await expect
        .poll(async () =>
          JSON.stringify(await send(options, { version: 1, type: "login.probe.status" })),
        )
        .toContain("origin-busy");
      expect(await clicks(first)).toBe(1);
      expect(await clicks(second)).toBe(0);
      await expect(second.locator("#password")).toHaveValue("");
      const response = (await send(options, { version: 1, type: "login.probe.status" })) as {
        attempts: { id: string; document: { tabId: number }; state: string }[];
      };
      const authenticated = response.attempts.filter(
        (attempt) => attempt.state === "authenticated",
      );
      expect(authenticated).toHaveLength(1);
    });
  } finally {
    await fixture.close();
  }
});
