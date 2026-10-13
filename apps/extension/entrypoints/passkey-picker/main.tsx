import { createRoot } from "react-dom/client";
import { sendMessage } from "../../src/messaging/protocol";
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
      send: (message) => sendMessage("passkey-chooser", message),
      close: () => window.close(),
    }}
  />,
);
