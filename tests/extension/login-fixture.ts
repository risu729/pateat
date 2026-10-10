import { chromium, expect, type BrowserContext, type Page, type Worker } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repository = fileURLToPath(new URL("../../", import.meta.url));
const probeDirectory = resolve(repository, "apps/extension/.output/chrome-mv3-probe");

async function withinRestartBudget<T>(pending: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Synthetic worker restart timed out")), 5000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function withStoppedLoginWorker(
  context: BrowserContext,
  worker: Worker,
  controller: Page,
  run: (expectRestarted: () => Promise<void>) => Promise<void>,
): Promise<void> {
  const incarnation = await withinRestartBudget(
    worker.evaluate(() => {
      const state = globalThis as unknown as { pateatSyntheticWorkerIncarnation?: string };
      state.pateatSyntheticWorkerIncarnation = crypto.randomUUID();
      return state.pateatSyntheticWorkerIncarnation;
    }),
  );
  const debuggerSession = await context.newCDPSession(controller);
  let versionId: string | undefined;
  let stopRequested = false;
  let stopped = false;
  let restarted = false;
  const observeVersion = (event: {
    versions: { versionId: string; scriptURL: string; runningStatus: string }[];
  }) => {
    for (const version of event.versions) {
      if (version.scriptURL !== worker.url()) continue;
      if (!versionId && version.runningStatus === "running") versionId = version.versionId;
      if (version.versionId !== versionId || !stopRequested) continue;
      if (version.runningStatus === "stopped") stopped = true;
      if (stopped && version.runningStatus === "running") restarted = true;
    }
  };
  debuggerSession.on("ServiceWorker.workerVersionUpdated", observeVersion);
  try {
    await debuggerSession.send("ServiceWorker.enable");
    await expect.poll(() => versionId, { timeout: 5000 }).toBeDefined();
    // MV3 idle suspension preserves the CDP target and Playwright Worker object.
    // Observe the exact version's stopped -> running events, including rapid restarts.
    stopRequested = true;
    await debuggerSession.send("ServiceWorker.stopWorker", { versionId: versionId! });
    await expect.poll(() => stopped, { timeout: 5000 }).toBe(true);
    await run(async () => {
      await expect.poll(() => restarted, { timeout: 5000 }).toBe(true);
      // Playwright 1.64 rebinds this handle to the new execution context.
      // A fresh nonce proves that execution globals were discarded despite target reuse.
      const evidence = await withinRestartBudget(
        worker.evaluate(() => {
          const state = globalThis as unknown as { pateatSyntheticWorkerIncarnation?: string };
          const previous = state.pateatSyntheticWorkerIncarnation;
          state.pateatSyntheticWorkerIncarnation = crypto.randomUUID();
          return { previous, current: state.pateatSyntheticWorkerIncarnation };
        }),
      );
      expect(evidence.previous).toBeUndefined();
      expect(evidence.current).not.toBe(incarnation);
    });
  } finally {
    debuggerSession.off("ServiceWorker.workerVersionUpdated", observeVersion);
    await debuggerSession.detach();
  }
}

export async function withLoginExtension(
  run: (context: BrowserContext, worker: Worker, extensionId: string) => Promise<void>,
): Promise<void> {
  const profile = await mkdtemp(resolve(tmpdir(), "pateat-login-test-"));
  let context: BrowserContext | undefined;
  try {
    context = await chromium.launchPersistentContext(profile, {
      channel: "chromium",
      headless: true,
      args: [`--disable-extensions-except=${probeDirectory}`, `--load-extension=${probeDirectory}`],
    });
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
    await run(context, worker, new URL(worker.url()).hostname);
  } finally {
    await context?.close();
    await rm(profile, { recursive: true, force: true });
  }
}
