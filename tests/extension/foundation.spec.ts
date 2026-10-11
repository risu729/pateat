import { test, expect, chromium, type BrowserContext, type Worker } from "@playwright/test";
import { AxeBuilder } from "@axe-core/playwright";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { SettingsResponse } from "../../packages/contracts/src/index";
import { PROBE_PASSKEY } from "../../apps/extension/src/passkeys/probe";

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
  profileDirectory?: string,
): Promise<void> {
  const profile = profileDirectory ?? (await mkdtemp(resolve(tmpdir(), "pateat-browser-test-")));
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
    if (!profileDirectory) await rm(profile, { recursive: true, force: true });
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

test("production package permits local storage, the crypto host and the HTTPS login and passkey scripts", async () => {
  const manifest = JSON.parse(await readFile(resolve(extensionDirectory, "manifest.json"), "utf8"));
  expect(manifest.manifest_version).toBe(3);
  expect(manifest.options_ui).toMatchObject({ page: "options.html", open_in_tab: true });
  expect(manifest.icons).toEqual({
    16: "icon/16.png",
    32: "icon/32.png",
    48: "icon/48.png",
    128: "icon/128.png",
  });
  // Owner-approved install-time HTTPS access (ADR 0009): top-level only. The ADR 0007
  // passkey bridge is the only MAIN-world script.
  expect(
    [...manifest.content_scripts].sort((a: { js: string[] }, b: { js: string[] }) =>
      a.js[0]!.localeCompare(b.js[0]!),
    ),
  ).toEqual([
    { matches: ["https://*/*"], run_at: "document_idle", js: ["content-scripts/login.js"] },
    {
      matches: ["https://*/*"],
      run_at: "document_start",
      js: ["content-scripts/passkey-isolated.js"],
    },
    {
      matches: ["https://*/*"],
      run_at: "document_start",
      world: "MAIN",
      js: ["content-scripts/passkey-main.js"],
    },
  ]);
  expect(manifest.permissions).toEqual(["storage", "offscreen"]);
  expect(manifest.host_permissions).toEqual(["https://*/*"]);
  // Chrome omits an optional entry the required hosts already cover, with a warning.
  expect(manifest.optional_host_permissions).toBeUndefined();
  expect(manifest.web_accessible_resources ?? []).toEqual([]);
  const background = await readFile(
    resolve(extensionDirectory, manifest.background.service_worker),
    "utf8",
  );
  expect(background).not.toContain("pateat.test.document");
  expect(background).not.toContain(PROBE_PASSKEY.credentialPrivateKey);
  const notices = await readFile(resolve(extensionDirectory, "THIRD-PARTY-NOTICES.md"), "utf8");
  expect(notices).toContain("Copyright (c) 2023 shadcn");
  expect(notices).toContain("MIT License");
  const probeManifest = JSON.parse(
    await readFile(resolve(probeDirectory, "manifest.json"), "utf8"),
  );
  // URL rechecks and worker reconnect require host access in addition to script
  // matches. Loopback HTTP belongs only to the synthetic build.
  expect(probeManifest.permissions).toEqual(["storage", "offscreen"]);
  expect(probeManifest.host_permissions).toEqual(["https://*/*", "http://127.0.0.1/*"]);
  expect(probeManifest.optional_host_permissions).toBeUndefined();
  // WebAuthn rejects IP-address origins, so only the passkey probe scripts use localhost.
  // The production HTTPS login and passkey scripts are shared with the probe build.
  for (const script of probeManifest.content_scripts as Array<{ matches: string[]; js: string[] }>)
    expect(script.matches).toEqual(
      /^content-scripts\/(?:login|passkey-main|passkey-isolated)\.js$/u.test(script.js.join())
        ? ["https://*/*"]
        : script.js.some((file) => /\/passkey-probe-(?:main|isolated)\.js$/u.test(file))
          ? ["http://localhost/*"]
          : ["http://127.0.0.1/*"],
    );
});

test("probe options support keyboard policy validation and pass accessibility checks", async () => {
  await withExtension(probeDirectory, async (context, _worker, id) => {
    const page = await context.newPage();
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.goto(`chrome-extension://${id}/options.html`);
    await expect(page.locator("#settings-status")).toContainText("Saved settings loaded");
    const initial = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
      .analyze();
    expect(initial.violations).toEqual([]);

    await page.locator("#site-hostname").fill("https://invalid.example/path");
    await page.locator("#site-hostname").press("Enter");
    await expect(page.locator("#site-hostname")).toHaveAttribute("aria-invalid", "true");
    await expect(page.locator("#site-hostname")).toBeFocused();
    await expect(page.getByRole("alert")).toBeVisible();
    await page.locator("#site-hostname").fill("keyboard.example");
    await page.locator("#site-hostname").press("Enter");
    await expect(page.locator("#excluded-sites")).toContainText("keyboard.example");
    await expect(page.locator("#site-hostname")).toHaveValue("");
    await expect(page.locator("#site-hostname")).toBeFocused();
    await page.getByRole("button", { name: /Remove.*keyboard.example/i }).click();
    await expect(page.locator("#site-hostname")).toBeFocused();

    await page
      .getByLabel("Demo personal vault: Item access", { exact: true })
      .selectOption("selected");
    await page.getByLabel("Demo personal vault: Include group Everyday", { exact: true }).check();
    await page.locator("#default-origin").fill("https://bank.example/path");
    await page
      .locator("#default-account")
      .selectOption(JSON.stringify(["demo-personal", "primary"]));
    await page.locator("#default-origin").press("Enter");
    await expect(page.locator("#default-origin")).toHaveAttribute("aria-invalid", "true");
    await expect(page.locator("#default-origin")).toBeFocused();
    const invalid = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
      .analyze();
    expect(invalid.violations).toEqual([]);
    await page.locator("#default-origin").fill("https://bank.example");
    await page.locator("#default-origin").press("Enter");
    await expect(page.locator("#site-defaults")).toContainText("https://bank.example");
    await expect(page.locator("#default-origin")).toBeFocused();
    expect(pageErrors).toEqual([]);
  });
});

test("installed production offers manual setup with an empty real catalog and rejects extra request fields", async () => {
  await withExtension(extensionDirectory, async (context, _worker, id) => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${id}/options.html`);
    await expect(page.getByRole("heading", { name: "Settings", exact: true })).toBeVisible();
    await expect(page.locator("#runtime-status")).toHaveText(
      "Extension ready · Automatic login unavailable",
    );
    await expect(page.locator("#vault-status")).toHaveCount(0);
    await expect(page.locator("#bitwarden-setup-status")).toHaveText(
      "Connections loaded. Add a vault or sign in again below.",
    );
    await expect(page.locator("#service-status")).toHaveText("Not configured");
    await expect(page.locator("#login-status")).toHaveText("Not implemented");
    await page.getByRole("button", { name: "Refresh status" }).click();
    await expect(page.locator("#runtime-status")).toHaveText(
      "Extension ready · Automatic login unavailable",
    );
    const saved = await page.evaluate(async () => {
      const chrome = (globalThis as unknown as { chrome: TestChrome }).chrome;
      return (await chrome.runtime.sendMessage({
        version: 1,
        type: "settings.get",
      })) as SettingsResponse;
    });
    expect(saved.ok).toBe(true);
    if (!saved.ok) throw new Error("Production settings unavailable");
    expect(saved.catalog.connections).toEqual([]);
    expect(saved.snapshot.settings.connections).toEqual([]);
    expect(
      await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze(),
    ).toMatchObject({ violations: [] });
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
      await expect(foreground.locator("#settings-status")).toContainText("Saved settings loaded");
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
            settingsRequestAccepted: boolean;
            storageReadAccepted: boolean;
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
      expect(result.result.settingsRequestAccepted).toBe(false);
      expect(result.result.storageReadAccepted).toBe(false);
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

test("local policies and account defaults survive a browser restart", async () => {
  const profile = await mkdtemp(resolve(tmpdir(), "pateat-settings-test-"));
  try {
    await withExtension(
      probeDirectory,
      async (context, _worker, id) => {
        const page = await context.newPage();
        await page.goto(`chrome-extension://${id}/options.html`);
        await expect(page.locator("#settings-status")).toContainText("Saved settings loaded");
        await page.getByLabel("Demo work vault: Enabled", { exact: true }).uncheck();
        await page
          .getByLabel("Demo personal vault: Item access", { exact: true })
          .selectOption("selected");
        await page
          .getByLabel("Demo personal vault: Include group Everyday", { exact: true })
          .check();
        await page
          .getByLabel("Demo personal vault: Exclude Password from Demo primary account", {
            exact: true,
          })
          .check();
        await page.locator("#site-hostname").fill("excluded.example");
        await page.locator("#site-subdomains").check();
        await page.locator("#add-site").click();
        await page.locator("#default-origin").fill("https://bank.example");
        await page
          .locator("#default-account")
          .selectOption(JSON.stringify(["demo-personal", "primary"]));
        await page.locator("#add-default").click();
        await page.locator("#save-settings").click();
        await expect(page.locator("#settings-status")).toContainText("saved locally");
      },
      profile,
    );
    await withExtension(
      probeDirectory,
      async (context, _worker, id) => {
        const page = await context.newPage();
        await page.goto(`chrome-extension://${id}/options.html`);
        await expect(page.locator("#settings-status")).toContainText("Saved settings loaded");
        await expect(
          page.getByLabel("Demo work vault: Enabled", { exact: true }),
        ).not.toBeChecked();
        await expect(
          page.getByLabel("Demo personal vault: Item access", { exact: true }),
        ).toHaveValue("selected");
        await expect(
          page.getByLabel("Demo personal vault: Include group Everyday", { exact: true }),
        ).toBeChecked();
        await expect(
          page.getByLabel("Demo personal vault: Exclude Password from Demo primary account", {
            exact: true,
          }),
        ).toBeChecked();
        const response = await page.evaluate(async () => {
          const chrome = (globalThis as unknown as { chrome: TestChrome }).chrome;
          return (await chrome.runtime.sendMessage({
            version: 1,
            type: "settings.get",
          })) as SettingsResponse;
        });
        expect(response.ok).toBe(true);
        if (!response.ok) throw new Error("Settings unavailable after restart");
        expect(response.snapshot.revision).toBe(1);
        expect(response.snapshot.settings.excludedSites).toEqual([
          { hostname: "excluded.example", includeSubdomains: true },
        ]);
        expect(response.snapshot.settings.siteDefaults).toEqual([
          {
            origin: "https://bank.example",
            provider: "dummy",
            userId: "demo-personal-account",
            itemId: "primary",
          },
        ]);
      },
      profile,
    );
  } finally {
    await rm(profile, { recursive: true, force: true });
  }
});

test("a stale settings page preserves its draft and cannot overwrite newer policy", async () => {
  await withExtension(extensionDirectory, async (context, _worker, id) => {
    const first = await context.newPage();
    const second = await context.newPage();
    await Promise.all(
      [first, second].map(async (page) => {
        await page.goto(`chrome-extension://${id}/options.html`);
        await expect(page.locator("#settings-status")).toContainText("Saved settings loaded");
      }),
    );
    await first.locator("#site-hostname").fill("protected.example");
    await first.locator("#add-site").click();
    await first.locator("#save-settings").click();
    await expect(first.locator("#settings-status")).toContainText("saved locally");
    await second.locator("#site-hostname").fill("draft.example");
    await second.locator("#add-site").click();
    await second.locator("#save-settings").click();
    await expect(second.locator("#settings-status")).toContainText("Reload");
    await expect(second.locator("#excluded-sites")).toContainText("draft.example");
    await second.locator("#reload-settings").click();
    await expect(second.locator("#excluded-sites")).toContainText("protected.example");
    await expect(second.locator("#excluded-sites")).not.toContainText("draft.example");
  });
});
