import { chromium, type BrowserContext, type Worker } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repository = fileURLToPath(new URL("../../", import.meta.url));
const probeDirectory = resolve(repository, "apps/extension/.output/chrome-mv3-probe");

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
