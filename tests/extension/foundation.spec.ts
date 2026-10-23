import {
  test,
  expect,
  chromium,
  type BrowserContext,
  type Page,
  type Worker,
} from "@playwright/test";
import { AxeBuilder } from "@axe-core/playwright";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PATEAT_EXTENSION_ID, type SettingsResponse } from "../../packages/contracts/src/index";
import { ACTION_ICON_PATHS } from "../../apps/extension/src/connections/action-icon";
import { PROBE_PASSKEY } from "../../apps/extension/src/passkeys/probe";
import { sendToBackground } from "./background-message";

const repository = fileURLToPath(new URL("../../", import.meta.url));
const extensionDirectory = resolve(repository, "apps/extension/.output/chrome-mv3");
const probeDirectory = resolve(repository, "apps/extension/.output/chrome-mv3-probe");

type TestChrome = {
  tabs: {
    create: (options: { url: string; active: boolean }) => Promise<{ id: number }>;
    get: (id: number) => Promise<{ url?: string }>;
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

/** Vault-wide policy lists start collapsed on the options page. */
async function expand(page: Page, connection: string, ...summaries: string[]): Promise<void> {
  const group = page.getByRole("group", { name: connection, exact: true });
  for (const summary of summaries) {
    // Nested disclosures open in order: an item's summary is hidden until its list opens.
    // oxlint-disable-next-line no-await-in-loop
    await group.locator("summary", { hasText: summary }).click();
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

test("built options and popup preserve light, dark and browser-setting colors", async () => {
  await withExtension(extensionDirectory, async (context, _worker, id) => {
    const page = await context.newPage();
    for (const scheme of ["light", "dark"] as const) {
      // oxlint-disable-next-line no-await-in-loop
      await page.emulateMedia({ colorScheme: scheme });
      for (const entrypoint of ["options.html", "popup.html"]) {
        // oxlint-disable-next-line no-await-in-loop
        await page.goto(`chrome-extension://${id}/${entrypoint}`);
        for (const theme of ["system", "light", "dark"] as const) {
          // The page's startup module applies the stored choice before rendering.
          // oxlint-disable-next-line no-await-in-loop
          await page.evaluate((choice) => localStorage.setItem("pateat.theme", choice), theme);
          // oxlint-disable-next-line no-await-in-loop
          await page.reload();
          const dark = theme === "dark" || (theme === "system" && scheme === "dark");
          // oxlint-disable-next-line no-await-in-loop
          await expect(page.locator("html")).toHaveCSS(
            "background-color",
            dark ? "rgb(14, 19, 22)" : "rgb(241, 245, 249)",
          );
          // oxlint-disable-next-line no-await-in-loop
          await expect(page.locator("html")).toHaveCSS(
            "color",
            dark ? "rgb(228, 235, 240)" : "rgb(30, 41, 59)",
          );
        }
      }
    }
  });
});

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
  // The toolbar icon opens the current-site popup (ADR 0021).
  expect(manifest.action).toMatchObject({ default_popup: "popup.html", default_title: "Pateat" });
  // The worker switches to the unlocked icon once a vault can unlock automatically.
  expect(manifest.action.default_icon).toEqual({
    16: "icon-locked/16.png",
    32: "icon-locked/32.png",
  });
  // Owner-approved install-time access (ADR 0009, HTTP since ADR 0050; passkeys stay on
  // HTTPS and `http://localhost`); the login script also runs in frames, which need the tab's page admitted too (ADR 0017). The MAIN-world scripts are
  // the ADR 0007 passkey bridge and, wherever the login script runs, the click on
  // `javascript:` links.
  expect(
    [...manifest.content_scripts].sort((a: { js: string[] }, b: { js: string[] }) =>
      a.js[0]!.localeCompare(b.js[0]!),
    ),
  ).toEqual([
    {
      matches: ["http://*/*", "https://*/*"],
      run_at: "document_start",
      all_frames: true,
      world: "MAIN",
      js: ["content-scripts/login-main.js"],
    },
    {
      matches: ["http://*/*", "https://*/*"],
      run_at: "document_idle",
      all_frames: true,
      js: ["content-scripts/login.js"],
    },
    {
      matches: ["http://localhost/*", "https://*/*"],
      run_at: "document_start",
      js: ["content-scripts/passkey-isolated.js"],
    },
    {
      matches: ["http://localhost/*", "https://*/*"],
      run_at: "document_start",
      world: "MAIN",
      js: ["content-scripts/passkey-main.js"],
    },
  ]);
  expect(manifest.permissions).toEqual(["storage", "offscreen", "alarms"]);
  expect(manifest.host_permissions).toEqual(["https://*/*", "http://*/*"]);
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
  expect(probeManifest.permissions).toEqual(["storage", "offscreen", "alarms"]);
  expect(probeManifest.host_permissions).toEqual(["https://*/*", "http://127.0.0.1/*"]);
  expect(probeManifest.optional_host_permissions).toBeUndefined();
  // WebAuthn rejects IP-address origins, so only the passkey probe scripts use localhost.
  // The production login and passkey scripts are shared with the probe build, on HTTPS
  // only there: its own login script covers loopback HTTP.
  for (const script of probeManifest.content_scripts as Array<{ matches: string[]; js: string[] }>)
    expect(script.matches).toEqual(
      /^content-scripts\/(?:login|login-main|passkey-main|passkey-isolated)\.js$/u.test(
        script.js.join(),
      )
        ? ["https://*/*"]
        : script.js.some((file) => /\/passkey-probe-(?:main|isolated)\.js$/u.test(file))
          ? ["http://localhost/*"]
          : ["http://127.0.0.1/*"],
    );
});

test("production and probe notices identify the bundled SDK's exact corresponding source", async () => {
  const lock = await readFile(resolve(repository, "bun.lock"), "utf8");
  const version = /"@bitwarden\/sdk-internal": \["@bitwarden\/sdk-internal@([^"]+)"/u.exec(
    lock,
  )?.[1];
  expect(version).toBeTruthy();
  const installed = dirname(
    createRequire(resolve(repository, "packages/bitwarden/package.json")).resolve(
      "@bitwarden/sdk-internal/package.json",
    ),
  );
  const installedPackage = JSON.parse(await readFile(resolve(installed, "package.json"), "utf8"));
  expect(installedPackage.version).toBe(version);
  const revision = (await readFile(resolve(installed, "VERSION"), "utf8")).trim();
  expect(revision).toMatch(/^[0-9a-f]{40}$/u);
  await Promise.all(
    [extensionDirectory, probeDirectory].map(async (directory) => {
      const [legal, notices, license] = await Promise.all([
        readFile(resolve(directory, "legal.html"), "utf8"),
        readFile(resolve(directory, "THIRD-PARTY-NOTICES.md"), "utf8"),
        readFile(resolve(directory, "LICENSE-GPL-3.0.txt"), "utf8"),
      ]);
      expect(license).toContain("GNU GENERAL PUBLIC LICENSE");
      expect(legal).toContain(`@bitwarden/sdk-internal ${version}`);
      expect(notices).toContain(`@bitwarden/sdk-internal@${version}`);
      for (const record of [legal, notices]) {
        expect(record).toContain(revision);
        expect(record).not.toContain("__PATEAT_BITWARDEN_SDK_");
        expect(record).toContain(
          `https://github.com/bitwarden/sdk-internal/archive/${revision}.tar.gz`,
        );
        expect(record).toContain(
          `https://github.com/bitwarden/sdk-internal/blob/${revision}/crates/bitwarden-wasm-internal/README.md`,
        );
        // Every SDK source link must identify the installed revision, including license links.
        const sourceLinks = [
          ...record.matchAll(
            /https:\/\/github\.com\/bitwarden\/sdk-internal\/(?:blob|archive)\/([^/"\s)]+)/gu,
          ),
        ];
        expect(sourceLinks.length).toBeGreaterThanOrEqual(2);
        for (const [, source] of sourceLinks)
          expect(source?.replace(/\.tar\.gz$/u, "")).toBe(revision);
      }
    }),
  );
});

test("probe options support keyboard policy validation and pass accessibility checks", async () => {
  await withExtension(probeDirectory, async (context, _worker, id) => {
    // The probe build keeps its path-derived ID and never shares production storage.
    expect(id).not.toBe(PATEAT_EXTENSION_ID);
    const page = await context.newPage();
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.goto(`chrome-extension://${id}/options.html`);
    await expect(page.locator("#settings-status")).toContainText("Saved settings loaded");
    const initial = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
      .analyze();
    expect(initial.violations).toEqual([]);

    await page.locator("#site-origin").fill("https://invalid.example/path");
    await page.locator("#add-site").click();
    await expect(page.locator("#site-origin")).toHaveAttribute("aria-invalid", "true");
    await expect(page.locator("#site-origin")).toBeFocused();
    await expect(page.getByRole("alert")).toBeVisible();
    await page.locator("#site-origin").fill("keyboard.example");
    await page.locator("#add-site").click();
    await expect(page.locator("#site-list")).toContainText("keyboard.example");
    await expect(page.locator("#site-origin")).toHaveValue("");
    await expect(page.locator("#site-origin")).toBeFocused();
    await page.getByRole("button", { name: "Allow keyboard.example", exact: true }).click();
    await expect(page.locator("#site-origin")).toBeFocused();

    await page
      .getByLabel("Demo personal vault: Items for Pateat", { exact: true })
      .selectOption("selected");
    await expand(page, "Demo personal vault", "Included groups and items");
    await page.getByLabel("Demo personal vault: Include group Everyday", { exact: true }).check();
    await page.locator("#site-origin").fill("https://bank.example");
    await page
      .locator("#default-account")
      .selectOption(JSON.stringify(["demo-personal", "primary"]));
    await page.locator("#site-origin").fill("https://bank.example/path");
    await page.locator("#site-origin").press("Enter");
    await expect(page.locator("#site-origin")).toHaveAttribute("aria-invalid", "true");
    await expect(page.locator("#site-origin")).toBeFocused();
    // Axe skips closed disclosures, so open the exclusions before scanning.
    await expand(page, "Demo personal vault", "Excluded items and fields", "Demo primary account");
    const invalid = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
      .analyze();
    expect(invalid.violations).toEqual([]);
    await page.locator("#site-origin").fill("https://bank.example");
    // The matching accounts are listed again for the corrected origin before it is added.
    await expect(page.locator("#default-account-note")).toContainText(
      /\d+ items? match(?:es)? this origin\./u,
    );
    await page.locator("#site-origin").press("Enter");
    await expect(page.locator("#site-list")).toContainText("https://bank.example");
    await expect(page.locator("#site-origin")).toBeFocused();
    expect(pageErrors).toEqual([]);
  });
});

test("options reloaded at a section link still read settings and the service", async () => {
  await withExtension(probeDirectory, async (context, _worker, id) => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${id}/options.html`);
    await expect(page.locator("#settings-status")).toContainText("Saved settings loaded");
    await page.getByRole("link", { name: "Sync service", exact: true }).click();
    await expect(page).toHaveURL(/options\.html#sync$/u);
    // Chrome now reports the page's URL to the worker with `#sync`.
    await page.reload();
    await expect(page.locator("#settings-status")).toContainText("Saved settings loaded");
    await expect(page.locator("#bitwarden-setup-status")).toHaveText(
      "Connections loaded. Add a vault or sign in again below.",
    );
    await expect(page.getByLabel("Service address", { exact: true })).toBeVisible();
    await expect(page.getByText("Pateat did not answer", { exact: false })).toHaveCount(0);
  });
});

test("packaged toolbar icons for both vault lock states load in Chrome", async () => {
  await withExtension(extensionDirectory, async (context, _worker, id) => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${id}/options.html`);
    const results = await page.evaluate(
      async (sets) => {
        const action = (
          globalThis as unknown as {
            chrome: { action: { setIcon: (details: { path: unknown }) => Promise<void> } };
          }
        ).chrome.action;
        return Promise.all(
          sets.map((path) =>
            action.setIcon({ path }).then(
              () => "loaded",
              (error: Error) => error.message,
            ),
          ),
        );
      },
      [ACTION_ICON_PATHS.unlocked, ACTION_ICON_PATHS.locked, { 16: "/icon-missing/16.png" }],
    );
    expect(results.slice(0, 2)).toEqual(["loaded", "loaded"]);
    // A missing file is rejected, so the loads above prove the packaged PNG files exist.
    expect(results[2]).not.toBe("loaded");
  });
});

test("the toolbar popup edits the active tab's site through the settings store", async () => {
  await withExtension(extensionDirectory, async (context, _worker, id) => {
    await context.route("https://bank.example/**", (route) =>
      route.fulfill({ contentType: "text/html", body: "<title>Bank</title><p>Bank</p>" }),
    );
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${id}/popup.html`);
    // Opened as a tab, the active tab is the popup's own extension page, not a website.
    await expect(popup.locator("#popup-unsupported")).toBeVisible();
    // Chrome shrinks text on extension pages to 75%; the shared stylesheet keeps the body at
    // 1rem, and the popup's text is 15px rather than 12px.
    const rootSize = await popup.evaluate(
      () => getComputedStyle(document.documentElement).fontSize,
    );
    await expect(popup.locator("body")).toHaveCSS("font-size", rootSize);
    await expect(popup.locator("#popup-unsupported")).toHaveCSS("font-size", "15px");
    const send = (page: Page, message: Record<string, unknown> & { type: string }) =>
      sendToBackground(page, message).then(
        (response) => response ?? "unanswered",
        () => "unanswered",
      );
    const get = (page: Page) => send(page, { version: 1, type: "settings.get" });
    const initial = await get(popup);
    expect(initial).toMatchObject({ ok: true, snapshot: { revision: 0 } });
    // Other extension pages still cannot read, save or search settings.
    const diagnostics = await context.newPage();
    await diagnostics.goto(`chrome-extension://${id}/diagnostics.html`);
    expect(await get(diagnostics)).toBe("unanswered");
    const { settings } = (initial as Extract<SettingsResponse, { ok: true }>).snapshot;
    expect(
      await send(diagnostics, {
        version: 1,
        type: "settings.save",
        expectedRevision: 0,
        settings: {
          ...settings,
          excludedSites: [{ hostname: "x.example", includeSubdomains: false }],
        },
      }),
    ).toBe("unanswered");
    expect(
      await send(diagnostics, {
        version: 1,
        type: "settings.site-accounts",
        origin: "https://bank.example",
        settings,
      }),
    ).toBe("unanswered");
    // Nor ask which accounts a refused login could use.
    expect(await send(diagnostics, { version: 1, type: "login.choice.get", tabId: 0 })).toBe(
      "unanswered",
    );
    await diagnostics.close();
    expect(await get(popup)).toMatchObject({ snapshot: { revision: 0 } });

    // A popup reads the active tab of its window; here it stays an inactive tab.
    const bank = await popup.evaluate(
      (url) =>
        (globalThis as unknown as { chrome: TestChrome }).chrome.tabs.create({ url, active: true }),
      "https://bank.example/login",
    );
    // A tab's `url` appears once its page commits.
    await expect
      .poll(() =>
        popup.evaluate(
          async (tabId) =>
            (await (globalThis as unknown as { chrome: TestChrome }).chrome.tabs.get(tabId)).url,
          bank.id,
        ),
      )
      .toBe("https://bank.example/login");
    const opened = context.waitForEvent("page", (page) => page.url().endsWith("/popup.html"));
    await popup.evaluate(
      (url) =>
        (globalThis as unknown as { chrome: TestChrome }).chrome.tabs.create({
          url,
          active: false,
        }),
      `chrome-extension://${id}/popup.html`,
    );
    const site = await opened;
    await expect(site.locator("#popup-origin")).toHaveText("bank.example");
    await expect(site.locator("#popup-accounts-note")).toContainText("No vault item matches");
    // No login in the tab waits for a choice, so none is offered.
    expect(await send(site, { version: 1, type: "login.choice.get", tabId: bank.id })).toEqual({
      ok: false,
      reason: "no-choice",
    });
    await expect(site.locator("#popup-choice-heading")).toHaveCount(0);
    const toggle = site.getByRole("switch", { name: "Pateat on this site" });
    await expect(toggle).toBeChecked();
    await toggle.click();
    await expect(toggle).not.toBeChecked();
    await expect(site.locator("#popup-site-status")).toHaveText(
      "Pateat does not log in or answer passkey requests on this site.",
    );
    expect(await get(site)).toMatchObject({
      ok: true,
      snapshot: {
        revision: 1,
        settings: { excludedSites: [{ hostname: "bank.example", includeSubdomains: false }] },
      },
    });
  });
});

test("installed production offers manual setup with an empty real catalog and rejects extra request fields", async () => {
  await withExtension(extensionDirectory, async (context, _worker, id) => {
    // Chrome derives the committed ID from the manifest key (ADR 0020).
    expect(id).toBe(PATEAT_EXTENSION_ID);
    const page = await context.newPage();
    await page.goto(`chrome-extension://${id}/options.html`);
    await expect(page.getByRole("heading", { name: "Settings", exact: true })).toBeVisible();
    await expect(page.locator("#bitwarden-setup-status")).toHaveText(
      "Connections loaded. Add a vault or sign in again below.",
    );
    await expect(page.locator("#diagnostics-link")).toHaveAttribute("href", "diagnostics.html");
    const saved = (await sendToBackground(page, {
      version: 1,
      type: "settings.get",
    })) as SettingsResponse;
    expect(saved.ok).toBe(true);
    if (!saved.ok) throw new Error("Production settings unavailable");
    expect(saved.catalog.connections).toEqual([]);
    expect(saved.snapshot.settings.connections).toEqual([]);
    const extra = await sendToBackground(page, { version: 1, type: "settings.get", extra: true });
    expect(extra).toMatchObject({ ok: false });
    expect(
      await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze(),
    ).toMatchObject({ violations: [] });
    expect(
      await sendToBackground(page, { version: 1, type: "diagnostics.status" }).then(
        (response) => response !== undefined,
        () => false,
      ),
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
        await page.getByLabel("Demo work vault: Use this vault", { exact: true }).uncheck();
        await page
          .getByLabel("Demo personal vault: Items for Pateat", { exact: true })
          .selectOption("selected");
        await expand(
          page,
          "Demo personal vault",
          "Included groups and items",
          "Excluded items and fields",
          "Demo primary account",
        );
        await page
          .getByLabel("Demo personal vault: Include group Everyday", { exact: true })
          .check();
        await page
          .getByLabel("Demo personal vault: Exclude Password from Demo primary account", {
            exact: true,
          })
          .check();
        await page.locator("#site-origin").fill("excluded.example");
        await page.locator("#site-subdomains").check();
        await page.locator("#add-site").click();
        await page.locator("#site-origin").fill("https://bank.example");
        await page
          .locator("#default-account")
          .selectOption(JSON.stringify(["demo-personal", "primary"]));
        // Each change is saved as it is made.
        await page.locator("#add-default").click();
        await expect(page.locator("#settings-status")).toContainText("Settings saved");
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
          page.getByLabel("Demo work vault: Use this vault", { exact: true }),
        ).not.toBeChecked();
        await expect(
          page.getByLabel("Demo personal vault: Items for Pateat", { exact: true }),
        ).toHaveValue("selected");
        await expand(
          page,
          "Demo personal vault",
          "Included groups and items",
          "Excluded items and fields",
          "Demo primary account",
        );
        await expect(
          page.getByLabel("Demo personal vault: Include group Everyday", { exact: true }),
        ).toBeChecked();
        await expect(
          page.getByLabel("Demo personal vault: Exclude Password from Demo primary account", {
            exact: true,
          }),
        ).toBeChecked();
        const response = (await sendToBackground(page, {
          version: 1,
          type: "settings.get",
        })) as SettingsResponse;
        expect(response.ok).toBe(true);
        if (!response.ok) throw new Error("Settings unavailable after restart");
        // Each change was saved as it was made; edits during a save share the next one.
        expect(response.snapshot.revision).toBeGreaterThanOrEqual(1);
        expect(response.snapshot.settings.excludedSites).toEqual([
          { hostname: "excluded.example", includeSubdomains: true },
        ]);
        expect(response.snapshot.settings.siteDefaults).toEqual([
          {
            origin: "https://bank.example",
            provider: "dummy",
            userId: "demo-personal-account",
            itemId: "primary",
            itemName: "Demo primary account",
            accountName: "Demo personal vault",
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
    await first.locator("#site-origin").fill("protected.example");
    await first.locator("#add-site").click();
    await expect(first.locator("#settings-status")).toContainText("Settings saved");
    await second.locator("#site-origin").fill("draft.example");
    await second.locator("#add-site").click();
    await expect(second.locator("#settings-status")).toContainText("Reload");
    await expect(second.locator("#site-list")).toContainText("draft.example");
    await second.locator("#reload-settings").click();
    await expect(second.locator("#site-list")).toContainText("protected.example");
    await expect(second.locator("#site-list")).not.toContainText("draft.example");
  });
});
