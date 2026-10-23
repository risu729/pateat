import { followLanguagePreference, followLanguageMetadata } from "../../src/i18n";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { browser } from "wxt/browser";
import { DiagnosticsApp } from "../../src/diagnostics/app";
import { readBrowserInfo, type UserAgentData } from "../../src/diagnostics/browser";
import {
  DIAGNOSTICS_STATUS_REQUEST,
  parseDiagnosticsResponse,
  parseLogsResponse,
} from "../../src/diagnostics/wire";
import { sendMessage } from "../../src/messaging/protocol";
import { followThemePreference } from "../../src/theme";
// oxlint-disable-next-line import/no-unassigned-import -- Share the settings page stylesheet.
import "../options/style.css";

// The theme is set before the first render, and follows changes made on another page.
followThemePreference();
// The stored language is read before the first render, so no English text flashes.
await followLanguagePreference();
followLanguageMetadata("Pateat diagnostics");

const root = document.getElementById("root");
if (!root) throw new Error("Missing diagnostics root");

createRoot(root).render(
  <QueryClientProvider client={new QueryClient()}>
    <DiagnosticsApp
      client={{
        load: async () =>
          parseDiagnosticsResponse(await sendMessage("diagnostics", DIAGNOSTICS_STATUS_REQUEST)),
        browser: () =>
          readBrowserInfo({
            userAgentData: (navigator as Navigator & { userAgentData?: UserAgentData })
              .userAgentData,
            getSelf: () => browser.management.getSelf(),
          }),
        copy: (text) => navigator.clipboard.writeText(text),
        exportLogs: async (includeSites) =>
          parseLogsResponse(
            "diagnostics.logs.export",
            await sendMessage("diagnostics", {
              version: 1,
              type: "diagnostics.logs.export",
              includeSites,
            }),
          ),
        clearLogs: async () =>
          parseLogsResponse(
            "diagnostics.logs.clear",
            await sendMessage("diagnostics", { version: 1, type: "diagnostics.logs.clear" }),
          ),
        setDebugLogs: async (enabled) =>
          parseLogsResponse(
            "diagnostics.logs.debug",
            await sendMessage("diagnostics", {
              version: 1,
              type: "diagnostics.logs.debug",
              enabled,
            }),
          ),
        // A Blob link needs no `downloads` permission (ADR 0019).
        download(text, filename) {
          const url = URL.createObjectURL(new Blob([text], { type: "application/x-ndjson" }));
          const link = document.createElement("a");
          link.href = url;
          link.download = filename;
          link.click();
          setTimeout(() => URL.revokeObjectURL(url), 60_000);
        },
      }}
    />
  </QueryClientProvider>,
);
