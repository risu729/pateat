import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { browser } from "wxt/browser";
import { SettingsApp } from "../../src/options/settings-app";
import { createMetadataQueryClient, createSettingsClient } from "../../src/options/client";
// oxlint-disable-next-line import/no-unassigned-import -- Bundle the options page stylesheet.
import "./style.css";

const root = document.getElementById("root");
if (!root) throw new Error("Missing options root");

createRoot(root).render(
  <QueryClientProvider client={createMetadataQueryClient()}>
    <SettingsApp client={createSettingsClient((message) => browser.runtime.sendMessage(message))} />
  </QueryClientProvider>,
);
