import { chromium, expect, test, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PATEAT_EXTENSION_ID } from "../../packages/contracts/src/index";
import { readTwoStepCode } from "../vaultwarden/mailpit";
import {
  addImportedPasskeyLogin,
  addLogin,
  authenticatorCode,
  enableAuthenticator,
  enableEmailTwoStep,
  registerAccount,
  type SeededAccount,
} from "../vaultwarden/seed";
import { startVaultwarden, type VaultwardenServer } from "../vaultwarden/server";
import { settingsRequest } from "./connection-fixture";

// The production build signs in to the latest Vaultwarden release (ADR 0059) in Docker over
// `http://localhost`, through the settings page as a person would. Synthetic accounts and
// items only; this proves bundled Chromium and Vaultwarden, not the official server.

const repository = fileURLToPath(new URL("../../", import.meta.url));
const extensionDirectory = resolve(repository, "apps/extension/.output/chrome-mv3");

let server: VaultwardenServer;
test.beforeAll(async () => {
  test.setTimeout(240_000);
  server = await startVaultwarden();
});
test.afterAll(() => server?.stop());
// Each sign-in derives PBKDF2 600000 in the page's worker and in the seeder. The tests share
// one server, so they stay in one shard instead of each starting its own.
test.describe.configure({ mode: "default", timeout: 120_000 });

const password = `synthetic-${randomUUID()}`;
const sitePassword = `synthetic-site-${randomUUID()}`;
const passkeyPassword = `synthetic-passkey-${randomUUID()}`;

function seedAccount() {
  return registerAccount(server.baseUrl, { email: `${randomUUID()}@example.test`, password });
}

async function withOptions(run: (options: Page) => Promise<void>) {
  const profile = await mkdtemp(resolve(tmpdir(), "pateat-vaultwarden-test-"));
  const context = await chromium.launchPersistentContext(profile, {
    channel: "chromium",
    headless: true,
    args: [
      `--disable-extensions-except=${extensionDirectory}`,
      `--load-extension=${extensionDirectory}`,
    ],
  });
  try {
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
    expect(new URL(worker.url()).hostname).toBe(PATEAT_EXTENSION_ID);
    const options = await context.newPage();
    await options.goto(`chrome-extension://${PATEAT_EXTENSION_ID}/options.html`);
    await expect(
      options.getByText("Connections loaded. Add a vault or sign in again below.", { exact: true }),
    ).toBeVisible();
    await run(options);
  } finally {
    await context.close();
    await rm(profile, { recursive: true, force: true });
  }
}

async function connect(options: Page, account: SeededAccount, typed = password) {
  await options.getByLabel("Name", { exact: true }).fill("Synthetic Vaultwarden");
  await options.getByLabel("Email", { exact: true }).fill(account.email);
  await options.getByLabel("Master password", { exact: true }).fill(typed);
  await options.getByRole("combobox", { name: "Server", exact: true }).selectOption("self-hosted");
  await options
    .getByLabel("Server address", { exact: true })
    .fill(`http://localhost:${server.port}`);
  await options.getByRole("button", { name: "Connect Bitwarden", exact: true }).click();
}

async function verify(options: Page, code: string) {
  await options.getByLabel("Verification code", { exact: true }).fill(code);
  await options.getByRole("button", { name: "Verify code", exact: true }).click();
}

const ready = "Vault verified and local cache accepted. Check automatic-unlock status below.";

test("signs in over http://localhost and lists every item, an imported passkey's included", async () => {
  const account = await seedAccount();
  await addLogin(account, {
    name: "Synthetic loopback site",
    username: "synthetic-user",
    password: sitePassword,
    uris: [{ uri: "http://localhost:3847/login" }],
  });
  // Stored as the official CLI's `bw import` writes it, with `"response": null` in the passkey.
  await addImportedPasskeyLogin(account, {
    name: "Synthetic imported passkey",
    username: "synthetic-passkey-user",
    password: passkeyPassword,
    uri: "https://passkey.example.test/",
    rpId: "passkey.example.test",
  });
  await withOptions(async (options) => {
    await connect(options, account);
    await expect(options.getByText(ready, { exact: true })).toBeVisible({ timeout: 60_000 });
    const saved = await settingsRequest(options);
    expect(saved.catalog.connections).toHaveLength(1);
    expect(saved.catalog.connections[0]!.items.map((item) => item.label).toSorted()).toEqual([
      "Synthetic imported passkey",
      "Synthetic loopback site",
    ]);
  });
});

test("shows a wrong master password as a rejected sign-in", async () => {
  const account = await seedAccount();
  await withOptions(async (options) => {
    await connect(options, account, `wrong-${randomUUID()}`);
    await expect(
      options.getByText(
        "The provider rejected this sign-in. Review the account and password before starting again.",
        { exact: true },
      ),
    ).toBeVisible({ timeout: 60_000 });
  });
});

test("signs in with an authenticator code", async () => {
  const account = await seedAccount();
  const { secret } = await enableAuthenticator(account);
  await withOptions(async (options) => {
    await connect(options, account);
    await expect(options.getByLabel("Verification code", { exact: true })).toBeVisible({
      timeout: 60_000,
    });
    // Enabling used the current step; Vaultwarden takes the next one as clock drift.
    await verify(options, authenticatorCode(secret, Date.now() + 30_000));
    await expect(options.getByText(ready, { exact: true })).toBeVisible({ timeout: 60_000 });
  });
});

test("emails a two-step code on its own and signs in with it, then resends", async () => {
  const account = await seedAccount();
  await enableEmailTwoStep(account, server.mailpitUrl);
  await withOptions(async (options) => {
    await connect(options, account);
    await expect(
      options.getByText("The server sent a verification code to the account's two-step email.", {
        exact: true,
      }),
    ).toBeVisible({ timeout: 60_000 });
    const first = await readTwoStepCode(server.mailpitUrl, account.email);
    await options.getByRole("button", { name: "Resend code", exact: true }).click();
    const second = await readTwoStepCode(server.mailpitUrl, account.email);
    expect(second).toMatch(/^\d{6}$/);
    // Vaultwarden keeps only the latest code.
    expect(second).not.toBe(first);
    await verify(options, second);
    await expect(options.getByText(ready, { exact: true })).toBeVisible({ timeout: 60_000 });
  });
});
