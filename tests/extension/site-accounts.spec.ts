import { expect, test, type Page } from "@playwright/test";
import type { CustomAccountVariant } from "../../packages/bitwarden/src/__fixtures__/connection";
import { beginInput, settingsRequest, setupProbe, setupRequest } from "./connection-fixture";
import { withVaultProfile } from "./vault-fixture";

const site = "https://synthetic.example.test";

/** Connect the synthetic vault and leave it as the only enabled connection. */
async function connect(options: Page) {
  const accepted = await setupRequest(options, { type: "connection.begin", input: beginInput() });
  if (!accepted.ok || accepted.kind !== "ready") throw new Error("Synthetic setup failed");
  const current = await settingsRequest(options);
  const settings = current.snapshot.settings;
  settings.connections = settings.connections.map((entry) => ({
    ...entry,
    enabled: entry.connectionId === accepted.connectionId,
  }));
  const saved = await settingsRequest(options, {
    version: 1,
    type: "settings.save",
    expectedRevision: current.snapshot.revision,
    settings,
  });
  const item = saved.catalog.connections.find((entry) => entry.id === accepted.connectionId)
    ?.items[0];
  if (!item) throw new Error("Synthetic vault item missing");
  return JSON.stringify([accepted.connectionId, item.id]);
}

async function accountOptions(options: Page) {
  return options
    .locator("#default-account option")
    .evaluateAll((entries) =>
      entries.map((entry) => [(entry as HTMLOptionElement).value, entry.textContent]),
    );
}

for (const [variant, matched] of [
  ["uri", "URI"],
  ["passkey", "passkey"],
] as const satisfies readonly (readonly [CustomAccountVariant, string])[]) {
  test(`the default account picker offers a vault item that matches the origin by ${matched}`, async () => {
    await withVaultProfile(async (open) => {
      const browser = await open();
      await setupProbe(browser.page, { action: "configure", variant });
      const options = await browser.context.newPage();
      await options.goto(`chrome-extension://${browser.extensionId}/options.html`);
      const value = await connect(options);
      await options.reload();
      await expect(options.locator("#settings-status")).toContainText("Saved settings loaded");

      await options.locator("#default-origin").fill("https://other.example");
      await expect(options.locator("#default-account-note")).toContainText("No vault item matches");
      await expect(options.locator("#default-account")).toBeDisabled();

      await options.locator("#default-origin").fill(site);
      await expect(options.locator("#default-account-note")).toContainText("1 matching item");
      // The matched item shows its login username, decrypted only for this answer.
      expect(await accountOptions(options)).toEqual([
        [value, `My test login · test_username (${matched})`],
      ]);
      await options.locator("#add-default").click();
      await expect(options.locator("#site-defaults")).toContainText(site);
      // The saved line shows how the item matches, and as whom, instead of a mismatch.
      await expect(options.locator("#site-defaults")).toContainText(
        `My test login · test_username`,
      );
      await expect(options.locator("#site-defaults")).toContainText(
        `Matches this origin by ${matched}; checked again on each login`,
      );
      // The same item saved for an origin it does not match gets no username.
      await options.locator("#default-origin").fill("https://other.example");
      await expect(options.locator("#default-account-note")).toContainText("No vault item matches");
      await options.locator("#default-account-all").check();
      await options.locator("#default-account").selectOption(value);
      await options.locator("#add-default").click();

      // The matches are looked up again from the vault, never saved with the defaults.
      await options.locator("#save-settings").click();
      await expect(options.locator("#settings-status")).toContainText("Settings saved");
      const stored = await settingsRequest(options);
      expect(stored.snapshot.settings.siteDefaults).toMatchObject([
        { origin: site },
        { origin: "https://other.example" },
      ]);
      expect(JSON.stringify(stored.snapshot.settings)).not.toContain("test_username");
      await options.reload();
      // Both rows look up their origin at once against the one vault.
      const row = (origin: string) =>
        options.locator("#site-defaults li").filter({ hasText: `${origin} →` });
      await expect(row(site)).toContainText("My test login · test_username");
      await expect(row(site)).toContainText(`Matches this origin by ${matched}`);
      await expect(row("https://other.example")).toContainText(
        "No URI rule or passkey of this item matches this origin",
      );
      await expect(row("https://other.example")).not.toContainText("test_username");
    });
  });
}
