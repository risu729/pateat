import { createRoot } from "react-dom/client";
import { browser } from "wxt/browser";
import { ChooserApp } from "../../src/passkeys/chooser-app";
import { followThemePreference } from "../../src/theme";
// oxlint-disable-next-line import/no-unassigned-import -- Share the settings page stylesheet.
import "../options/style.css";

// The theme is set before the first render, and follows changes made on another page.
followThemePreference();

const root = document.getElementById("root");
if (!root) throw new Error("Missing passkey chooser root");

createRoot(root).render(
  <ChooserApp
    client={{
      request: new URLSearchParams(location.search).get("request"),
      send: (message) => browser.runtime.sendMessage(message),
      close: () => window.close(),
    }}
  />,
);
