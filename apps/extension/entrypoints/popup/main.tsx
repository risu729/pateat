import { QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { browser } from "wxt/browser";
import { createMetadataQueryClient, createSettingsClient } from "../../src/options/client";
import { SiteApp } from "../../src/popup/site-app";
// oxlint-disable-next-line import/no-unassigned-import -- Share the settings page stylesheet.
import "../options/style.css";
// oxlint-disable-next-line import/no-unassigned-import -- Size the popup.
import "./style.css";

const root = document.getElementById("root");
if (!root) throw new Error("Missing popup root");

createRoot(root).render(
  <QueryClientProvider client={createMetadataQueryClient()}>
    <SiteApp
      client={createSettingsClient((message) => browser.runtime.sendMessage(message))}
      host={{
        async currentTabUrl() {
          const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
          return tab?.url;
        },
        openSettings() {
          void browser.runtime.openOptionsPage();
          window.close();
        },
      }}
    />
  </QueryClientProvider>,
);
