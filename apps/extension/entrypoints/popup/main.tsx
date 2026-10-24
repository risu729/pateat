import { followLanguagePreference, followLanguageMetadata } from "../../src/i18n";
import { QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { browser } from "wxt/browser";
import { storage } from "wxt/utils/storage";
import { createMetadataQueryClient, createSettingsClient } from "../../src/options/client";
import { createChoiceClient } from "../../src/login/choice-wire";
import { createDetailClient } from "../../src/login/detail-wire";
import { sendMessage } from "../../src/messaging/protocol";
import { SiteApp } from "../../src/popup/site-app";
import { SETTINGS_STORAGE_KEY } from "../../src/settings";
import { followThemePreference } from "../../src/theme";
// oxlint-disable-next-line import/no-unassigned-import -- Share the settings page stylesheet.
import "../options/style.css";
// oxlint-disable-next-line import/no-unassigned-import -- Size the popup.
import "./style.css";

// The theme is set before the first render, and follows changes made on another page.
followThemePreference();
// The stored language is read before the first render, so no English text flashes.
await followLanguagePreference();
followLanguageMetadata("Pateat");

const root = document.getElementById("root");
if (!root) throw new Error("Missing popup root");

createRoot(root).render(
  <QueryClientProvider client={createMetadataQueryClient()}>
    <SiteApp
      client={createSettingsClient((message) => sendMessage("settings", message))}
      choices={createChoiceClient((message) => sendMessage("login", message))}
      details={createDetailClient((message) => sendMessage("login", message))}
      host={{
        async currentTab() {
          const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
          return tab && { id: tab.id, url: tab.url, incognito: tab.incognito };
        },
        openSettings(section) {
          // A section is opened at its anchor in a tab of its own.
          if (section)
            void browser.tabs.create({
              url: `${browser.runtime.getURL("/options.html")}#${encodeURIComponent(section)}`,
            });
          else void browser.runtime.openOptionsPage();
          window.close();
        },
        openDiagnostics() {
          void browser.tabs.create({ url: browser.runtime.getURL("/diagnostics.html") });
          window.close();
        },
        close() {
          window.close();
        },
        // Only a signal: the settings themselves are read again from the worker.
        watchSettings: (onChange) => storage.watch(`local:${SETTINGS_STORAGE_KEY}`, onChange),
      }}
    />
  </QueryClientProvider>,
);
