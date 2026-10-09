import { test, expect, chromium, type BrowserContext, type Worker } from "@playwright/test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repository = fileURLToPath(new URL("../../", import.meta.url));
const extensionDirectory = resolve(repository, "apps/extension/.output/chrome-mv3");
const probeDirectory = resolve(repository, "apps/extension/.output/chrome-mv3-probe");

type TestChrome = {
  runtime: {
    id: string;
    sendMessage: (message: unknown) => Promise<unknown>;
  };
  tabs: {
    create: (options: { url: string; active: boolean }) => Promise<{ id: number }>;
  };
};

async function withExtension(
  directory: string,
  run: (context: BrowserContext, worker: Worker, extensionId: string) => Promise<void>,
): Promise<void> {
  const profile = await mkdtemp(resolve(tmpdir(), "pateat-browser-test-"));
  let context: BrowserContext | undefined;
  try {
    context = await chromium.launchPersistentContext(profile, {
      channel: "chromium",
      headless: true,
      args: [`--disable-extensions-except=${directory}`, `--load-extension=${directory}`],
    });
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
    const extensionId = new URL(worker.url()).hostname;
    await run(context, worker, extensionId);
  } finally {
    await context?.close();
    await rm(profile, { recursive: true, force: true });
  }
}

const fixtureHtml = `<!doctype html>
<html><head><script>
window.probeInstalledBeforeFirstScript = window.__pateatDocumentStartProbe === true;
window.nativeGetBefore = navigator.credentials.get;
window.probeId = crypto.randomUUID();
window.addEventListener('message', (event) => {
  if (event.source === window && event.origin === location.origin &&
      event.data?.type === 'pateat.test.result' && event.data.id === window.probeId) {
    window.probeResult = event.data;
  }
});
window.postMessage({type: 'pateat.test.start', id: window.probeId}, location.origin);
</script></head><body><h1>Synthetic document-start fixture</h1></body></html>`;

async function startFixture(): Promise<{ server: Server; url: string }> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(fixtureHtml);
  });
  await new Promise<void>((resolveListening, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListening);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No fixture port assigned");
  return { server, url: `http://127.0.0.1:${address.port}/fixture` };
}

test("production package has no site scripts or broad permissions", async () => {
  const manifest = JSON.parse(await readFile(resolve(extensionDirectory, "manifest.json"), "utf8"));
  expect(manifest.manifest_version).toBe(3);
  expect(manifest.options_ui).toMatchObject({ page: "options.html", open_in_tab: true });
  expect(manifest.content_scripts ?? []).toEqual([]);
  expect(manifest.permissions ?? []).toEqual([]);
  expect(manifest.host_permissions ?? []).toEqual([]);
  expect(manifest.web_accessible_resources ?? []).toEqual([]);
  const background = await readFile(
    resolve(extensionDirectory, manifest.background.service_worker),
    "utf8",
  );
  expect(background).not.toContain("pateat.test.document");
});

test("installed foundation reports truthful status and rejects extra request fields", async () => {
  await withExtension(extensionDirectory, async (context, _worker, id) => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${id}/options.html`);
    await expect(page.getByRole("heading", { name: "Settings", exact: true })).toBeVisible();
    await expect(page.getByRole("status")).toHaveText("Extension ready · Foundation only");
    await expect(page.locator("#vault-status")).toHaveText("Not connected");
    await expect(page.locator("#service-status")).toHaveText("Not configured");
    await expect(page.locator("#login-status")).toHaveText("Not implemented");
    await page.getByRole("button", { name: "Refresh status" }).click();
    await expect(page.getByRole("status")).toHaveText("Extension ready · Foundation only");
    expect(
      await page.evaluate(async () => {
        const chrome = (globalThis as unknown as { chrome: TestChrome }).chrome;
        try {
          return (
            (await chrome.runtime.sendMessage({
              version: 1,
              type: "runtime.status.get",
              grant: "vault.read",
            })) !== undefined
          );
        } catch {
          return false;
        }
      }),
    ).toBe(false);
  });
});

test("document-start bridge runs in an inactive tab and binds identity across navigation", async () => {
  const { server, url } = await startFixture();
  try {
    await withExtension(probeDirectory, async (context, worker, id) => {
      const foreground = await context.newPage();
      await foreground.goto(`chrome-extension://${id}/options.html`);
      await foreground.bringToFront();
      const newPage = context.waitForEvent("page");
      const tab = await worker.evaluate(async (targetUrl) => {
        const chrome = (globalThis as unknown as { chrome: TestChrome }).chrome;
        return await chrome.tabs.create({ url: targetUrl, active: false });
      }, url);
      const page = await newPage;
      await page.waitForFunction(() =>
        Boolean((window as unknown as { probeResult?: unknown }).probeResult),
      );
      const result = await page.evaluate(() => {
        const state = window as unknown as {
          probeInstalledBeforeFirstScript: boolean;
          probeResult: {
            stateAtInstall: string;
            nativeGetUnchanged: boolean;
            statusRequestAccepted: boolean;
            identity: { tabId: number; frameId: number; documentId: string; active: boolean };
          };
          nativeGetBefore: unknown;
        };
        return {
          beforeFirstScript: state.probeInstalledBeforeFirstScript,
          result: state.probeResult,
          nativeGetUnchanged: navigator.credentials.get === state.nativeGetBefore,
          iframes: document.querySelectorAll("iframe").length,
        };
      });
      expect(result.beforeFirstScript).toBe(true);
      expect(result.result.stateAtInstall).toBe("loading");
      expect(result.result.nativeGetUnchanged).toBe(true);
      expect(result.nativeGetUnchanged).toBe(true);
      expect(result.result.statusRequestAccepted).toBe(false);
      expect(result.result.identity).toMatchObject({ tabId: tab.id, frameId: 0, active: false });
      expect(result.result.identity.documentId).toEqual(expect.any(String));
      expect(result.result.identity.documentId.length).toBeGreaterThan(0);
      expect(result.iframes).toBe(0);

      await page.goto(`${url}?navigation=2`);
      await page.waitForFunction(() =>
        Boolean((window as unknown as { probeResult?: unknown }).probeResult),
      );
      const nextIdentity = await page.evaluate(
        () =>
          (
            window as unknown as {
              probeResult: { identity: { tabId: number; documentId: string } };
            }
          ).probeResult.identity,
      );
      expect(nextIdentity.tabId).toBe(tab.id);
      expect(nextIdentity.documentId).not.toBe(result.result.identity.documentId);
    });
  } finally {
    await new Promise<void>((done, reject) =>
      server.close((error) => (error ? reject(error) : done())),
    );
  }
});
