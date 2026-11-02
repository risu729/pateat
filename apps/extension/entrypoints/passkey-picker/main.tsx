import { followLanguagePreference, followLanguageMetadata } from "../../src/i18n";
import { createRoot } from "react-dom/client";
import { sendMessage } from "../../src/messaging/protocol";
import { ChooserApp } from "../../src/passkeys/chooser-app";
import { followThemePreference } from "../../src/theme";
import { followProfileTheme } from "../../src/theme-profile";
// oxlint-disable-next-line import/no-unassigned-import -- Share the settings page stylesheet.
import "../options/style.css";

// The theme is set before the first render from this origin's copy, then follows the synced
// profile setting.
followThemePreference();
followProfileTheme();
// The stored language is read before the first render, so no English text flashes.
await followLanguagePreference();
followLanguageMetadata("Pateat passkey sign-in");

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
