import { AxeBuilder } from "@axe-core/playwright";
import { chromium, expect, test, type Page } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { v1Email } from "../../packages/bitwarden/src/__fixtures__/crypto";
import { sendToBackground } from "./background-message";
import { beginInput, setupProbe, setupRequest } from "./connection-fixture";
import { withVaultProfile } from "./vault-fixture";

const repository = fileURLToPath(new URL("../../", import.meta.url));
const extensionDirectory = resolve(repository, "apps/extension/.output/chrome-mv3");

async function logs(page: Page): Promise<string> {
  await page.getByRole("button", { name: "Download logs" }).click();
  const text = page.locator("#logs-preview");
  await expect(text).toBeVisible();
  return (await text.textContent()) ?? "";
}

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
      /^0\.1\.0 \(([0-9a-f]{7}|development)\) production build$/u,
    );
    await expect(page.locator("#diagnostics-browser")).toHaveText(/^(Chrome|Chromium) \d+\./u);
    await expect(page.locator("#diagnostics-sdk")).toHaveText(/^0\.2\.0-main\.\d+$/u);
    await expect(page.locator("#diagnostics-checks")).toContainText(
      "https://*/* and http://*/* site access granted",
    );
    await expect(page.locator("#diagnostics-checks")).toContainText("Pateat service not paired");
    await expect(page.locator("#diagnostics-service")).toHaveText("not-configured");
    const report = await preview(page);
    expect(report).toMatch(
      /^Pateat 0\.1\.0 \(([0-9a-f]{7}|development)\) · production build · unpacked install \(development\)\n/u,
    );
    expect(report).toContain("Permissions: alarms, storage, offscreen, https://*/*");
    expect(report).toContain("Pateat service: not-configured");
    expect(report).toMatch(
      /\nLogs: \d+ entr(?:y|ies) \(\d+ KB\), 0 errors, \d+ warnings? in 24 h\n/u,
    );

    // Debug logging, the exact saved text, and clearing.
    await page.getByRole("button", { name: "Turn on debug logging", exact: true }).click();
    await expect(page.locator("#logs-status")).toHaveText(
      "Debug logging is on until you turn it off.",
    );
    // Site addresses and recipe IDs are included until the person hides them.
    const included = await logs(page);
    expect(JSON.parse(included.split("\n")[0] ?? "")).toMatchObject({ sites: "included" });
    await page.getByRole("checkbox", { name: "Hide site addresses and recipe IDs" }).check();
    await expect(page.locator("#logs-preview")).toContainText('"sites":"replaced"');
    const saved = (await page.locator("#logs-preview").textContent()) ?? "";
    const [header, ...lines] = saved.trimEnd().split("\n");
    expect(JSON.parse(header ?? "")).toMatchObject({ pateat: "0.1.0", sites: "replaced" });
    expect(lines.map((line) => (JSON.parse(line) as { event: string }).event)).toContain(
      "log.debug",
    );
    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: "Save file" }).click();
    expect((await download).suggestedFilename()).toMatch(/^pateat-logs-\d{8}-\d{4}\.jsonl$/u);
    // The same text, whole, goes to the clipboard. The clipboard cannot be read back from an
    // extension origin here, so the page's write is recorded on its way to the real one.
    await page.evaluate(() => {
      const copied: string[] = [];
      const write = navigator.clipboard.writeText.bind(navigator.clipboard);
      Object.assign(window, { copied });
      navigator.clipboard.writeText = (text) => {
        copied.push(text);
        return write(text);
      };
    });
    await page.getByRole("button", { name: "Copy all" }).click();
    await expect(page.locator("#logs-status")).toHaveText(
      `Copied ${lines.length} ${lines.length === 1 ? "entry" : "entries"}.`,
    );
    expect(await page.evaluate(() => (window as unknown as { copied: string[] }).copied)).toEqual([
      saved,
    ]);
    await page.evaluate(() => {
      navigator.clipboard.writeText = async () => {
        throw new DOMException("Document is not focused.", "NotAllowedError");
      };
    });
    await page.getByRole("button", { name: "Copy all" }).click();
    await expect(page.locator("#logs-status")).toHaveText("Copy failed. Use Save file instead.");
    // Debug logging turns off at once.
    await page.getByRole("button", { name: "Turn off debug logging" }).click();
    await expect(page.locator("#logs-status")).toHaveText("Debug logging is off.");
    await expect(
      page.getByRole("button", { name: "Turn on debug logging", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Clear logs" }).click();
    await page.getByRole("button", { name: "Delete all log entries" }).click();
    await expect(page.locator("#logs-status")).toHaveText("Logs cleared.");
    await expect(page.locator("#diagnostics-logs")).toHaveText(/^0 \(0 KB\)$/u);
    expect(
      await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze(),
    ).toMatchObject({ violations: [] });
  } finally {
    await context.close();
    await rm(profile, { recursive: true, force: true });
  }
});

test("a connection appears under a stable pseudonym with its server, and only its KDF family is copied", async () => {
  await withVaultProfile(async (open) => {
    const first = await open();
    await setupProbe(first.page, { action: "configure", variant: "unchanged" });
    const page = await first.context.newPage();
    await page.goto(`chrome-extension://${first.extensionId}/diagnostics.html`);
    // Debug logging records the connection as the worker first sees it.
    await page.getByRole("button", { name: "Turn on debug logging", exact: true }).click();
    await expect(page.locator("#logs-status")).toHaveText(
      "Debug logging is on until you turn it off.",
    );
    const options = await first.context.newPage();
    await options.goto(`chrome-extension://${first.extensionId}/options.html`);
    const accepted = await setupRequest(options, { type: "connection.begin", input: beginInput() });
    if (!accepted.ok || accepted.kind !== "ready") throw new Error("Synthetic setup failed");
    await page.getByRole("button", { name: "Refresh" }).click();
    const connection = page.getByRole("definition").filter({ hasText: /^bitwarden:[0-9a-f]{6}$/u });
    await expect(connection).toHaveCount(1);
    const pseudonym = (await connection.textContent()) ?? "";
    await expect(page.locator("#diagnostics-checks")).toContainText(
      `${pseudonym} vault cache ready`,
    );
    await expect(page.locator("#diagnostics-checks")).toContainText(
      `${pseudonym} Bitwarden server 2026.9.2`,
    );
    await expect(page.getByText(/^PBKDF2-SHA256 \d+$|^Argon2id /u)).toBeVisible();
    const report = await preview(page);
    expect(report).toContain(
      `${pseudonym}: cloud-us · Bitwarden server 2026.9.2 · ready · auto-unlock enabled`,
    );
    expect(report).toMatch(/ · KDF (PBKDF2|Argon2id) · /u);
    // Without the provider permission sync needs, the server is not asked.
    await setupProbe(first.page, { action: "configure", variant: "unchanged", permission: false });
    const before = await setupProbe(first.page, { action: "status" });
    await page.getByRole("button", { name: "Refresh" }).click();
    await expect(page.locator("#diagnostics-checks")).toContainText(
      `${pseudonym} server not checked (no-site-access)`,
    );
    expect((await setupProbe(first.page, { action: "status" })).configCalls).toBe(
      before.configCalls,
    );
    // A failed settings-page Sync is logged and listed in the bug report.
    expect(
      await setupRequest(options, { type: "connection.sync", connectionId: accepted.connectionId }),
    ).toEqual({ ok: false, error: { code: "provider-permission-required" } });
    await expect
      .poll(async () => {
        await page.getByRole("button", { name: "Refresh" }).click();
        return preview(page);
      })
      .toMatch(
        new RegExp(
          `Recent problems \\(24 h, newest first\\):\\n  \\S+Z warn vault\\.sync ${pseudonym} provider-permission-required\\n`,
          "u",
        ),
      );
    await setupProbe(first.page, { action: "configure", variant: "unchanged" });
    expect(report).toMatch(/1 item \(login 1, TOTP \d, passkey \d\) \+ \d unsupported/u);
    for (const absent of [
      v1Email,
      "Synthetic vault",
      accepted.connectionId,
      accepted.snapshotId,
      "PBKDF2-SHA256",
      "Argon2id m=",
    ])
      expect(report).not.toContain(absent);
    const shown = await page.content();
    for (const absent of [v1Email, "Synthetic vault", accepted.connectionId, accepted.snapshotId])
      expect(shown).not.toContain(absent);
    // The log names the connection by the same pseudonym and holds no account data.
    await expect
      .poll(async () => {
        await page.getByRole("button", { name: "Refresh" }).click();
        return logs(page);
      })
      .toContain(`"connection":"${pseudonym}"`);
    const saved = await logs(page);
    for (const absent of [v1Email, "Synthetic vault", accepted.connectionId, accepted.snapshotId])
      expect(saved).not.toContain(absent);

    // Only the exact diagnostics page may ask for the summary or touch the logs.
    for (const request of [
      { version: 1, type: "diagnostics.status" },
      { version: 1, type: "diagnostics.logs.export", includeSites: true },
      { version: 1, type: "diagnostics.logs.clear" },
    ])
      expect(
        // oxlint-disable-next-line no-await-in-loop -- one request at a time, each must fail
        await sendToBackground(options, request).then(
          (response) => response !== undefined,
          () => false,
        ),
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
