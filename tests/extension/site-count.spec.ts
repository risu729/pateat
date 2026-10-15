import { expect, test, type Page, type Worker } from "@playwright/test";
import { beginInput, settingsRequest, setupProbe, setupRequest } from "./connection-fixture";
import { withVaultProfile } from "./vault-fixture";

const site = "https://synthetic.example.test";
const other = "https://other.example";

/** Connect the synthetic vault and leave it as the only enabled connection. */
async function connect(options: Page) {
  const accepted = await setupRequest(options, { type: "connection.begin", input: beginInput() });
  if (!accepted.ok || accepted.kind !== "ready")
    throw new Error(`Synthetic setup failed: ${JSON.stringify(accepted)}`);
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
  return { connectionId: accepted.connectionId, itemId: item.id };
}

/** The toolbar badge of the tab showing `url`, as Chrome draws it. */
function badge(background: Worker, url: string) {
  return background.evaluate(async (pattern) => {
    const [tab] = await chrome.tabs.query({ url: pattern });
    if (tab?.id === undefined) return undefined;
    const tabId = tab.id;
    const [text, color, textColor, title] = await Promise.all([
      chrome.action.getBadgeText({ tabId }),
      chrome.action.getBadgeBackgroundColor({ tabId }),
      chrome.action.getBadgeTextColor({ tabId }),
      chrome.action.getTitle({ tabId }),
    ]);
    return { text, color, textColor, title };
  }, `${url}/*`);
}

test("the toolbar badge counts the vault items that match each HTTPS site", async () => {
  await withVaultProfile(async (open) => {
    const browser = await open();
    await browser.context.route(
      /^https:\/\/(synthetic\.example\.test|other\.example)\//u,
      (route) =>
        route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Site</title>" }),
    );
    await setupProbe(browser.page, { action: "configure", variant: "uri" });
    const options = await browser.context.newPage();
    await options.goto(`chrome-extension://${browser.extensionId}/options.html`);
    const { connectionId, itemId } = await connect(options);

    const page = await browser.context.newPage();
    await page.goto(`${site}/sign-in`);
    // The page's announcement counts the open vault's one matching item, in teal.
    await expect
      .poll(() => badge(browser.background, site), { timeout: 15_000 })
      .toEqual({
        text: "1",
        color: [17, 94, 89, 255],
        textColor: [255, 255, 255, 255],
        title: "Pateat: 1 account for this site.",
      });

    const elsewhere = await browser.context.newPage();
    await elsewhere.goto(`${other}/`);
    await expect
      .poll(() => badge(browser.background, other), { timeout: 15_000 })
      .toMatchObject({ text: "", title: "Pateat: no account for this site." });

    // Excluding the item shows the match in gray once the page counts again.
    const current = await settingsRequest(options);
    const settings = current.snapshot.settings;
    settings.connections = settings.connections.map((entry) =>
      entry.connectionId === connectionId ? { ...entry, excludedItemIds: [itemId] } : entry,
    );
    await settingsRequest(options, {
      version: 1,
      type: "settings.save",
      expectedRevision: current.snapshot.revision,
      settings,
    });
    await page.reload();
    await expect
      .poll(() => badge(browser.background, site), { timeout: 15_000 })
      .toEqual({
        text: "1",
        color: [203, 213, 225, 255],
        textColor: [30, 41, 59, 255],
        title:
          "Pateat: 1 account matches this site, but none can be used: they are excluded in settings.",
      });
  });
});
