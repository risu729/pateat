import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { browser } from "wxt/browser";
import { DiagnosticsApp } from "../../src/diagnostics/app";
import { readBrowserInfo, type UserAgentData } from "../../src/diagnostics/browser";
import { DIAGNOSTICS_STATUS_REQUEST, parseDiagnosticsResponse } from "../../src/diagnostics/wire";
// oxlint-disable-next-line import/no-unassigned-import -- Share the settings page stylesheet.
import "../options/style.css";

const root = document.getElementById("root");
if (!root) throw new Error("Missing diagnostics root");

createRoot(root).render(
  <QueryClientProvider client={new QueryClient()}>
    <DiagnosticsApp
      client={{
        load: async () =>
          parseDiagnosticsResponse(await browser.runtime.sendMessage(DIAGNOSTICS_STATUS_REQUEST)),
        browser: () =>
          readBrowserInfo({
            userAgentData: (navigator as Navigator & { userAgentData?: UserAgentData })
              .userAgentData,
            getSelf: () => browser.management.getSelf(),
          }),
        copy: (text) => navigator.clipboard.writeText(text),
      }}
    />
  </QueryClientProvider>,
);
