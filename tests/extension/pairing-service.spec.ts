import { chromium, expect, test, type BrowserContext, type Page } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PATEAT_EXTENSION_ID } from "../../packages/contracts/src/index";
import { ACCESS_COOKIE, startSyncService, type SyncService } from "./sync-service";

// Direct pairing (ADR 0020) in bundled Chromium against the built Worker behind a
// loopback stand-in for Cloudflare Access. Synthetic identity, cookie and keys only;
// this proves bundled Chromium behavior, not installed Chrome or the deployed service.
// The stand-in does not model Access's own 401, denial page or cookie validation; the
// transport unit tests' synthetic responses cover those.

const repository = fileURLToPath(new URL("../../", import.meta.url));
const extensionDirectory = resolve(repository, "apps/extension/.output/chrome-mv3");
const EXTENSION_ORIGIN = `chrome-extension://${PATEAT_EXTENSION_ID}`;

async function withProduction(run: (context: BrowserContext, options: Page) => Promise<void>) {
  const profile = await mkdtemp(resolve(tmpdir(), "pateat-pairing-test-"));
  let context: BrowserContext | undefined;
  try {
    context = await chromium.launchPersistentContext(profile, {
      channel: "chromium",
      headless: true,
      args: [
        `--disable-extensions-except=${extensionDirectory}`,
        `--load-extension=${extensionDirectory}`,
        // The loopback service's certificate is self-signed.
        "--ignore-certificate-errors",
      ],
    });
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
    // The manifest key pins the ID that the built Worker lists in PAIRING_EXTENSION_IDS.
    expect(new URL(worker.url()).hostname).toBe(PATEAT_EXTENSION_ID);
    const options = await context.newPage();
    await options.goto(`${EXTENSION_ORIGIN}/options.html`);
    await run(context, options);
  } finally {
    await context?.close();
    await rm(profile, { recursive: true, force: true });
  }
}

function signIn(context: BrowserContext, service: SyncService) {
  const { hostname } = new URL(service.origin);
  return context.addCookies([
    {
      ...ACCESS_COOKIE,
      domain: hostname,
      path: "/",
      secure: true,
      httpOnly: true,
      // Cloudflare Access leaves its application cookie at SameSite=None by default.
      sameSite: "None",
    },
  ]);
}

/** Requests the options page itself sent to the service; pairing must not be one. */
function pageRequests(options: Page, service: SyncService) {
  const urls: string[] = [];
  options.on("request", (request) => {
    if (request.url().startsWith(service.origin)) urls.push(request.url());
  });
  return urls;
}

async function pair(options: Page, service: SyncService) {
  await options.getByLabel("Service address", { exact: true }).fill(service.origin);
  await options.getByLabel("Device name", { exact: true }).fill("Synthetic paired device");
  await options.getByRole("button", { name: "Pair this device", exact: true }).click();
}

/**
 * Shows the settings page again. Headless Chromium does not reliably fire `focus` when a
 * page is brought to the front, so the event a real window switch fires is sent here.
 */
async function returnTo(options: Page) {
  await options.bringToFront();
  const visibility = await options.evaluate(() => {
    window.dispatchEvent(new Event("focus"));
    return document.visibilityState;
  });
  // The retry runs only for a visible page; say so if that guard is what blocked it.
  expect(visibility).toBe("visible");
}

const managePages = (service: SyncService) =>
  service.requests.filter((request) => request.path === "/manage");
const pairRequests = (service: SyncService) =>
  service.requests.filter((request) => request.method === "POST" && request.path === "/pair");

test("pairs in one click from the background with the browser's session", async () => {
  const service = await startSyncService({ access: true });
  try {
    await withProduction(async (context, options) => {
      await signIn(context, service);
      const sent = pageRequests(options, service);
      await pair(options, service);
      await expect(options.getByText("This device is paired.", { exact: true })).toBeVisible();
      await expect(options.getByText(/Synthetic paired device.*is paired with/)).toBeVisible();

      const created = (await service.devices()).filter(
        (device) => device.label === "Synthetic paired device",
      );
      expect(created).toEqual([
        { id: expect.any(String), label: "Synthetic paired device", revoked_at: null },
      ]);
      // One request, from the extension's origin, carrying the session cookie.
      expect(pairRequests(service)).toEqual([
        {
          method: "POST",
          path: "/pair",
          origin: EXTENSION_ORIGIN,
          cookie: `${ACCESS_COOKIE.name}=${ACCESS_COOKIE.value}`,
        },
      ]);
      // The background sent it: the settings page made no request to the service.
      expect(sent).toEqual([]);
      // The first sync runs with the new credential and sends no cookies.
      await expect
        .poll(() => service.requests.filter((request) => request.path.startsWith("/v1/")).length)
        .toBeGreaterThan(0);
      for (const request of service.requests.filter((entry) => entry.path.startsWith("/v1/")))
        expect(request.cookie).toBeNull();
      await expect(options.getByText(/Recipes and settings last synced at/)).toBeVisible({
        timeout: 15_000,
      });
    });
  } finally {
    await service.close();
  }
});

test("opens the sign-in page once when signed out and pairs on Try again", async () => {
  const service = await startSyncService({ access: true });
  try {
    await withProduction(async (context, options) => {
      const opened = context.waitForEvent("page");
      await pair(options, service);
      const signInPage = await opened;
      await expect(options.getByText(/in the new tab, then come back here/)).toBeVisible();
      await signInPage.waitForURL(`${service.origin}/cdn-cgi/access/login`);
      // The settings page opened the service's own /manage page, which Access redirected.
      expect(managePages(service)).toEqual([
        { method: "GET", path: "/manage", origin: null, cookie: null },
      ]);
      const before = await service.devices();
      // The stand-in redirected the pairing request; no device was created.
      expect(pairRequests(service)).toEqual([
        { method: "POST", path: "/pair", origin: EXTENSION_ORIGIN, cookie: null },
      ]);

      // Coming back before signing in retries once, which still needs a sign-in and
      // opens no second tab.
      await returnTo(options);
      await expect(options.getByText(/open the sign-in page, then come back here/)).toBeVisible();
      expect(pairRequests(service)).toHaveLength(2);
      expect(await service.devices()).toEqual(before);

      await signIn(context, service);
      await options.getByRole("button", { name: "Try again", exact: true }).click();
      await expect(options.getByText("This device is paired.", { exact: true })).toBeVisible();
      expect(pairRequests(service)).toHaveLength(3);
      const after = await service.devices();
      expect(after).toHaveLength(before.length + 1);
      expect(after.at(-1)).toMatchObject({ label: "Synthetic paired device", revoked_at: null });
      // Still one sign-in tab: retrying opened no other.
      expect(managePages(service)).toHaveLength(1);
      expect(context.pages().filter((page) => page.url().startsWith(service.origin))).toEqual([
        signInPage,
      ]);
    });
  } finally {
    await service.close();
  }
});

test("retries once when the settings page is shown again after signing in", async () => {
  const service = await startSyncService({ access: true });
  try {
    await withProduction(async (context, options) => {
      const opened = context.waitForEvent("page");
      await pair(options, service);
      const signInPage = await opened;
      await expect(options.getByText(/in the new tab, then come back here/)).toBeVisible();
      await signIn(context, service);
      await signInPage.bringToFront();
      await returnTo(options);
      await expect(options.getByText("This device is paired.", { exact: true })).toBeVisible();
      expect(pairRequests(service)).toHaveLength(2);
    });
  } finally {
    await service.close();
  }
});
