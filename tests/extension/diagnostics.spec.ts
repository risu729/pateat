import { AxeBuilder } from "@axe-core/playwright";
import { chromium, expect, test, type Page } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { v1Email } from "../../packages/bitwarden/src/__fixtures__/crypto";
import { beginInput, setupProbe, setupRequest } from "./connection-fixture";
import { withVaultProfile } from "./vault-fixture";

const repository = fileURLToPath(new URL("../../", import.meta.url));
const extensionDirectory = resolve(repository, "apps/extension/.output/chrome-mv3");

async function preview(page: Page): Promise<string> {
  await page.getByRole("button", { name: "Copy for bug report" }).click();
  const text = page.locator("#report-preview");
  await expect(text).toBeVisible();
  return (await text.textContent()) ?? "";
}

test("production diagnostics show the build, checks and a value-free bug report", async () => {
  const profile = await mkdtemp(resolve(tmpdir(), "pateat-diagnostics-test-"));
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
    const id = new URL(worker.url()).hostname;
    const page = await context.newPage();
    await page.goto(`chrome-extension://${id}/diagnostics.html`);
    await expect(page.getByRole("heading", { name: "Diagnostics", exact: true })).toBeVisible();
    await expect(page.locator("#diagnostics-version")).toHaveText(
      /^0\.1\.0 \(([0-9a-f]{7}|development), production\)$/u,
    );
    await expect(page.locator("#diagnostics-browser")).toHaveText(/^(Chrome|Chromium) \d+\./u);
    await expect(page.locator("#diagnostics-sdk")).toHaveText(/^0\.2\.0-main\.\d+$/u);
    await expect(page.locator("#diagnostics-checks")).toContainText(
      "https://*/* site access granted",
    );
    await expect(page.locator("#diagnostics-checks")).toContainText("Pateat service not paired");
    await expect(page.locator("#diagnostics-service")).toHaveText("not-configured");
    const report = await preview(page);
    expect(report).toMatch(
      /^Pateat 0\.1\.0 \(([0-9a-f]{7}|development), production, development\)\n/u,
    );
    expect(report).toContain("Permissions: storage, offscreen, https://*/*");
    expect(report).toContain("Pateat service: not-configured");
    expect(
      await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze(),
    ).toMatchObject({ violations: [] });
  } finally {
    await context.close();
    await rm(profile, { recursive: true, force: true });
  }
});

test("a connection appears under a stable pseudonym and its KDF stays out of the report", async () => {
  await withVaultProfile(async (open) => {
    const first = await open();
    await setupProbe(first.page, { action: "configure", variant: "unchanged" });
    const options = await first.context.newPage();
    await options.goto(`chrome-extension://${first.extensionId}/options.html`);
    const accepted = await setupRequest(options, { type: "connection.begin", input: beginInput() });
    if (!accepted.ok || accepted.kind !== "ready") throw new Error("Synthetic setup failed");

    const page = await first.context.newPage();
    await page.goto(`chrome-extension://${first.extensionId}/diagnostics.html`);
    const connection = page.getByRole("definition").filter({ hasText: /^bitwarden:[0-9a-f]{6}$/u });
    await expect(connection).toHaveCount(1);
    const pseudonym = (await connection.textContent()) ?? "";
    await expect(page.locator("#diagnostics-checks")).toContainText(
      `${pseudonym} vault cache ready`,
    );
    await expect(page.getByText(/^PBKDF2-SHA256 \d+$|^Argon2id /u)).toBeVisible();
    const report = await preview(page);
    expect(report).toContain(`${pseudonym}: cloud-us · ready · auto-unlock enabled`);
    expect(report).toMatch(/1 items \(login 1, TOTP \d, passkey \d\) \+ \d unsupported/u);
    for (const absent of [
      v1Email,
      "Synthetic vault",
      accepted.connectionId,
      accepted.snapshotId,
      "PBKDF2",
      "Argon2",
    ])
      expect(report).not.toContain(absent);
    const shown = await page.content();
    for (const absent of [v1Email, "Synthetic vault", accepted.connectionId, accepted.snapshotId])
      expect(shown).not.toContain(absent);

    // Only the exact diagnostics page may ask for the summary.
    expect(
      await options
        .evaluate(async () => {
          const scope = globalThis as unknown as {
            chrome: { runtime: { sendMessage(value: unknown): Promise<unknown> } };
          };
          try {
            return (
              (await scope.chrome.runtime.sendMessage({
                version: 1,
                type: "diagnostics.status",
              })) !== undefined
            );
          } catch {
            return false;
          }
        })
        .catch(() => false),
    ).toBe(false);

    // The pseudonym key persists, so the same connection keeps its name after a restart.
    const reopened = await open();
    const again = await reopened.context.newPage();
    await again.goto(`chrome-extension://${reopened.extensionId}/diagnostics.html`);
    await expect(
      again.getByRole("definition").filter({ hasText: /^bitwarden:[0-9a-f]{6}$/u }),
    ).toHaveText(pseudonym);
  });
});
