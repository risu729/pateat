import { createRoot } from "react-dom/client";
import { browser } from "wxt/browser";
import { ChooserApp } from "../../src/passkeys/chooser-app";
// oxlint-disable-next-line import/no-unassigned-import -- Share the settings page stylesheet.
import "../options/style.css";

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
