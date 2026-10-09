import { parseRuntimeStatus } from "@pateat/contracts";
import { browser } from "wxt/browser";

function element(id: string): HTMLElement {
  const result = document.getElementById(id);
  if (!result) throw new Error(`Missing settings element: ${id}`);
  return result;
}

const status = element("runtime-status");
const refresh = element("refresh-status") as HTMLButtonElement;

async function refreshStatus(): Promise<void> {
  refresh.disabled = true;
  status.textContent = "Checking extension…";
  try {
    const result = parseRuntimeStatus(
      await browser.runtime.sendMessage({ version: 1, type: "runtime.status.get" }),
    );
    element("vault-status").textContent =
      result.vault === "not-connected" ? "Not connected" : "Unknown";
    element("service-status").textContent =
      result.service === "not-configured" ? "Not configured" : "Unknown";
    element("login-status").textContent =
      result.login === "not-implemented" ? "Not implemented" : "Unknown";
    status.textContent = "Extension ready · Foundation only";
  } catch {
    for (const id of ["vault-status", "service-status", "login-status"]) {
      element(id).textContent = "Unknown";
    }
    status.textContent = "Unable to read runtime status. Reload the extension and try again.";
  } finally {
    refresh.disabled = false;
  }
}

refresh.addEventListener("click", () => void refreshStatus());
void refreshStatus();
