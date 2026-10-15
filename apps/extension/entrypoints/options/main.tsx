import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { browser } from "wxt/browser";
import { SettingsApp } from "../../src/options/settings-app";
import { createMetadataQueryClient, createSettingsClient } from "../../src/options/client";
import { createConnectionClient } from "../../src/options/connection-client";
import { createServiceClient } from "../../src/options/service-client";
import { sendMessage } from "../../src/messaging/protocol";
import { followThemePreference } from "../../src/theme";
import { trustedRecord } from "../../src/storage";
import { parseVaultTimeout, VAULT_TIMEOUT_KEY, type VaultTimeout } from "../../src/vault/timeout";
// oxlint-disable-next-line import/no-unassigned-import -- Bundle the options page stylesheet.
import "./style.css";

// The theme is set before the first render, and follows changes made on another page.
followThemePreference();

const root = document.getElementById("root");
if (!root) throw new Error("Missing options root");
// A device setting the worker watches; it is never synced, so it needs no message.
const vaultTimeoutRecord = trustedRecord<VaultTimeout>(VAULT_TIMEOUT_KEY);
const connectionClient = createConnectionClient({
  connect: (name) => browser.runtime.connect({ name }),
  requestPermission: (origins) => browser.permissions.request({ origins }),
});

createRoot(root).render(
  <QueryClientProvider client={createMetadataQueryClient()}>
    <SettingsApp
      client={createSettingsClient((message) => sendMessage("settings", message))}
      connectionClient={connectionClient}
      serviceClient={createServiceClient({
        send: (message) => sendMessage("service", message),
        openTab: (url) => browser.tabs.create({ url }),
        // Chrome match patterns do not carry ports; site access is granted per host.
        requestSiteAccess: (origin) =>
          browser.permissions.request({ origins: [`https://${new URL(origin).hostname}/*`] }),
      })}
      vaultTimeoutClient={{
        read: async () => parseVaultTimeout(await vaultTimeoutRecord.read()),
        write: (value) => vaultTimeoutRecord.write(value),
      }}
    />
  </QueryClientProvider>,
);
