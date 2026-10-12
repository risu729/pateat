import { QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { browser } from "wxt/browser";
import { createMetadataQueryClient, createSettingsClient } from "../../src/options/client";
import { createChoiceClient } from "../../src/login/choice-wire";
import { SiteApp } from "../../src/popup/site-app";
import { followThemePreference } from "../../src/theme";
// oxlint-disable-next-line import/no-unassigned-import -- Share the settings page stylesheet.
import "../options/style.css";
// oxlint-disable-next-line import/no-unassigned-import -- Size the popup.
import "./style.css";

// The theme is set before the first render, and follows changes made on another page.
followThemePreference();

const root = document.getElementById("root");
if (!root) throw new Error("Missing popup root");

createRoot(root).render(
  <QueryClientProvider client={createMetadataQueryClient()}>
    <SiteApp
      client={createSettingsClient((message) => browser.runtime.sendMessage(message))}
      choices={createChoiceClient((message) => browser.runtime.sendMessage(message))}
      host={{
        async currentTab() {
          const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
          return tab && { id: tab.id, url: tab.url, incognito: tab.incognito };
        },
        openSettings() {
          void browser.runtime.openOptionsPage();
          window.close();
        },
        close() {
          window.close();
        },
      }}
    />
  </QueryClientProvider>,
);
