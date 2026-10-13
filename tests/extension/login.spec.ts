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

async function configure(
  options: Page,
  extensionId: string,
  origin: string,
  selectAccount = true,
  passkey?: "discoverable" | "second-factor",
  totp = false,
) {
  await options.goto(`chrome-extension://${extensionId}/options.html`);
  await expect(options.locator("#settings-status")).toContainText("Saved settings loaded");
  expect(
    await send(options, {
      version: 1,
      type: "login.probe.configure",
      origin,
      ...(passkey ? { passkey } : {}),
      ...(totp ? { totp: true } : {}),
    }),
  ).toMatchObject({ ok: true });
  const response = (await send(options, { version: 1, type: "settings.get" })) as SettingsResponse;
  if (!response.ok) throw new Error("Synthetic settings unavailable");
  const settings = response.snapshot.settings;
  settings.siteDefaults = selectAccount
    ? [{ origin, provider: "dummy", userId: "demo-personal-account", itemId: "primary" }]
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

async function expectWatchingWithoutAttempt(options: Page) {
  await expect
    .poll(async () => await send(options, { version: 1, type: "login.probe.status" }))
    .toMatchObject({ attempts: [], documents: [{ state: "watching" }] });
  // Cover several watch checks before the negative assertions.
  await options.waitForTimeout(1000);
  expect(await send(options, { version: 1, type: "login.probe.status" })).toMatchObject({
    attempts: [],
    documents: [{ state: "watching" }],
  });
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
      const storageKey = "pateat.login-attempts.v4";
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

test("an identifier-first page that shows the password form from the start never continues after Next (ADR 0013)", async () => {
  const fixture = await startLoginFixture();
  try {
    await withLoginExtension(async (context, _worker, id) => {
      const options = await context.newPage();
      await configure(options, id, fixture.origin);
      const page = await context.newPage();
      await page.goto(`${fixture.origin}/identifier-first?shown`);
      // Nothing confirms the advance, so after ten seconds its result is unknown.
      await expect
        .poll(async () => await send(options, { version: 1, type: "login.probe.status" }), {
          timeout: 20_000,
        })
        .toMatchObject({ attempts: [{ outcome: "unknown-submit", stepIndex: 1 }] });
      // Cover several more checks before the negative assertions.
      await page.waitForTimeout(1000);
      expect(
        await page.evaluate(() => ({
          identityClicks: Number(sessionStorage.getItem("identityClicks") || 0),
          submitClicks: Number(sessionStorage.getItem("submitClicks") || 0),
          password: (document.getElementById("password") as HTMLInputElement).value,
        })),
      ).toEqual({ identityClicks: 1, submitClicks: 0, password: "" });
    });
  } finally {
    await fixture.close();
  }
});

test("never shows or fills the password form after an unknown-account error on an identifier-first form (ADR 0013)", async () => {
  const fixture = await startLoginFixture();
  try {
    await withLoginExtension(async (context, _worker, id) => {
      const options = await context.newPage();
      await configure(options, id, fixture.origin);
      const page = await context.newPage();
      await page.goto(`${fixture.origin}/identifier-first?unknown=1`);
      await expect(page.locator("#account-error")).toBeVisible({ timeout: 15_000 });
      // The advance is never confirmed; it ends as unknown after its 10-second wait.
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
      // Past the result wait, nothing is clicked or filled again.
      await page.waitForTimeout(2000);
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

/** What the synthetic code page recorded: counts and whether the code matched, never the code. */
async function codeEvidence(page: Page) {
  return page.evaluate(() => ({
    codeInputs: Number(sessionStorage.getItem("codeInputs") || 0),
    verifyClicks: Number(sessionStorage.getItem("verifyClicks") || 0),
    autoSubmits: Number(sessionStorage.getItem("autoSubmits") || 0),
    codeMatched: sessionStorage.getItem("codeMatched"),
  }));
}

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
      expect(await codeEvidence(page)).toEqual({
        codeInputs: 1,
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
      expect(await codeEvidence(page)).toEqual({
        codeInputs: 1,
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
        await expect(page.locator("#authenticated")).toBeVisible();
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
          codeInputs: 1,
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
        await configure(options, id, fixture.origin, true, undefined, true);
        const status = async () =>
          JSON.stringify(await send(options, { version: 1, type: "login.probe.status" }));
        const page = await context.newPage();
        await page.goto(`${fixture.origin}/totp?${query}`);
        if (query.endsWith("wrong")) {
          // The page enables Verify again for another code. The login holds the page for
          // the person and never clicks it, past the click step's own 10-second wait.
          await expect(page.locator("#verify")).toBeEnabled();
          await expect.poll(status).toContain('"state":"reconciling"');
          await page.waitForTimeout(11_000);
          expect(await status()).toContain('"state":"reconciling"');
        } else {
          await expect(page.locator("#authenticated")).toBeVisible();
          await expect.poll(status).toContain('"authenticated"');
        }
        expect(await codeEvidence(page)).toEqual({
          codeInputs: 1,
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
          codeInputs: 1,
          verifyClicks: 0,
          autoSubmits: 1,
          codeMatched: "true",
        });
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
      // A switch that would submit a form is never clicked.
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
  // The duplicate's click step waits ten seconds, then twice more on its retries.
  test.setTimeout(90_000);
  const fixture = await startLoginFixture();
  try {
    await withLoginExtension(async (context, _worker, id) => {
      const options = await context.newPage();
      await configure(options, id, fixture.origin);
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
      // An ambiguous click target is waited on like a missing one, for up to 10 s, and the
      // step is tried twice more before the attempt stops.
      await expect.poll(status, { timeout: 45_000 }).toContain("retry-limit");
      // The fill step ran, so the attempt stopped at the ambiguous click.
      await expect(duplicate.locator("#password")).not.toHaveValue("");
      expect(await clicks(duplicate)).toBe(0);
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
    await withLoginExtension(async (context, _worker, id) => {
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
      for (const rejection of ["alert", "invalid", "custom"]) {
        const page = await context.newPage();
        await page.goto(`${fixture.origin}/single?reject-fill=${rejection}`);
        await expect.poll(status).toContain("fill-rejected");
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

test("a step whose element never appears stops after two retries of ten seconds without a click", async () => {
  // The first wait and each of its two retries waits ten seconds for the button.
  test.setTimeout(60_000);
  const fixture = await startLoginFixture();
  try {
    await withLoginExtension(async (context, _worker, id) => {
      const options = await context.newPage();
      await configure(options, id, fixture.origin);
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
      expect(Date.now() - started).toBeGreaterThanOrEqual(29_500);
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
      expect(await frame?.evaluate(() => Number(sessionStorage.getItem("submitClicks") || 0))).toBe(
        1,
      );
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
      await page.waitForTimeout(3000);
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
