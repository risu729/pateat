import {
  normalizeHostname,
  parseRuntimeStatus,
  parseSettingsResponse,
  parseSiteUrl,
  resolveSiteAccount,
  type LocalSettings,
  type SettingsSnapshot,
  type VaultCatalog,
} from "@pateat/contracts";
import { browser } from "wxt/browser";

function element(id: string): HTMLElement {
  const result = document.getElementById(id);
  if (!result) throw new Error(`Missing settings element: ${id}`);
  return result;
}

const status = element("runtime-status");
const refresh = element("refresh-status") as HTMLButtonElement;
const settingsStatus = element("settings-status");
const controls = element("settings-controls") as HTMLFieldSetElement;
const save = element("save-settings") as HTMLButtonElement;
const reload = element("reload-settings") as HTMLButtonElement;
const siteHostname = element("site-hostname") as HTMLInputElement;
const siteSubdomains = element("site-subdomains") as HTMLInputElement;
const defaultOrigin = element("default-origin") as HTMLInputElement;
const defaultAccount = element("default-account") as HTMLSelectElement;
let snapshot: SettingsSnapshot | undefined;
let draft: LocalSettings | undefined;
let catalog: VaultCatalog | undefined;
let busy = false;
let saveBlocked = true;
let dirty = false;

function node<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  text?: string,
): HTMLElementTagNameMap[K] {
  const result = document.createElement(tag);
  if (text !== undefined) result.textContent = text;
  return result;
}

function updateActions(): void {
  controls.disabled = busy || !draft;
  save.disabled = busy || saveBlocked || !draft || !dirty;
  reload.disabled = busy;
}

function changed(): void {
  dirty = true;
  if (!saveBlocked)
    settingsStatus.textContent = "Unsaved changes. Save settings to apply this draft.";
  updateActions();
  renderDefaults();
}

function checkbox(
  parent: HTMLElement,
  label: string,
  checked: boolean,
  change: (checked: boolean) => void,
): HTMLInputElement {
  const wrapper = node("label");
  wrapper.className = "checkbox-row";
  const input = node("input");
  input.type = "checkbox";
  input.checked = checked;
  input.setAttribute("aria-label", label);
  wrapper.append(input, node("span", label.slice(label.indexOf(": ") + 2)));
  input.addEventListener("change", () => {
    change(input.checked);
    changed();
  });
  parent.append(wrapper);
  return input;
}

function toggleId(ids: string[], id: string, included: boolean): string[] {
  return included ? [...new Set([...ids, id])] : ids.filter((entry) => entry !== id);
}

function renderConnections(): void {
  const container = element("connections");
  container.replaceChildren();
  if (!draft || !catalog) return;
  for (const connection of draft.connections) {
    const metadata = catalog.connections.find((entry) => entry.id === connection.connectionId);
    if (!metadata) {
      container.append(
        node(
          "p",
          `Unavailable connection: ${connection.connectionId}. Its saved settings are preserved.`,
        ),
      );
      continue;
    }
    const group = node("fieldset");
    group.className = "connection";
    group.append(node("legend", metadata.label));
    checkbox(group, `${metadata.label}: Enabled`, connection.enabled, (checked) => {
      connection.enabled = checked;
    });
    const selectionLabel = node("label", "Item access");
    const selection = node("select");
    selection.setAttribute("aria-label", `${metadata.label}: Item access`);
    for (const [value, label] of [
      ["all", "All items except exclusions"],
      ["selected", "Selected groups and items only"],
    ]) {
      const option = node("option", label);
      option.value = value ?? "";
      selection.append(option);
    }
    selection.value = connection.selection.mode;
    selectionLabel.append(selection);
    group.append(selectionLabel);
    const included = node("fieldset");
    included.className = "selection";
    included.append(node("legend", "Included groups and items"));
    included.disabled = connection.selection.mode !== "selected";
    selection.addEventListener("change", () => {
      connection.selection.mode = selection.value === "selected" ? "selected" : "all";
      included.disabled = connection.selection.mode !== "selected";
      changed();
    });
    for (const entry of metadata.groups) {
      checkbox(
        included,
        `${metadata.label}: Include group ${entry.label}`,
        connection.selection.groupIds.includes(entry.id),
        (checked) => {
          connection.selection.groupIds = toggleId(
            connection.selection.groupIds,
            entry.id,
            checked,
          );
        },
      );
    }
    for (const item of metadata.items) {
      checkbox(
        included,
        `${metadata.label}: Include item ${item.label}`,
        connection.selection.itemIds.includes(item.id),
        (checked) => {
          connection.selection.itemIds = toggleId(connection.selection.itemIds, item.id, checked);
        },
      );
    }
    group.append(included, node("h3", "Item and field exclusions"));
    for (const item of metadata.items) {
      const exclusions = node("fieldset");
      exclusions.className = "item-exclusions";
      exclusions.append(node("legend", item.label));
      checkbox(
        exclusions,
        `${metadata.label}: Exclude item ${item.label}`,
        connection.excludedItemIds.includes(item.id),
        (checked) => {
          connection.excludedItemIds = toggleId(connection.excludedItemIds, item.id, checked);
        },
      );
      for (const field of item.fields) {
        checkbox(
          exclusions,
          `${metadata.label}: Exclude ${field.label} from ${item.label}`,
          connection.excludedFields.some(
            (ref) => ref.itemId === item.id && ref.fieldId === field.id,
          ),
          (checked) => {
            connection.excludedFields = connection.excludedFields.filter(
              (ref) => ref.itemId !== item.id || ref.fieldId !== field.id,
            );
            if (checked) connection.excludedFields.push({ itemId: item.id, fieldId: field.id });
          },
        );
      }
      group.append(exclusions);
    }
    container.append(group);
  }
}

function removeButton(label: string, remove: () => void): HTMLButtonElement {
  const button = node("button", "Remove");
  button.type = "button";
  button.className = "secondary";
  button.setAttribute("aria-label", label);
  button.addEventListener("click", () => {
    remove();
    changed();
  });
  return button;
}

function renderSites(): void {
  const list = element("excluded-sites");
  list.replaceChildren();
  if (!draft) return;
  if (!draft.excludedSites.length) list.append(node("li", "No excluded sites."));
  for (const site of draft.excludedSites) {
    const row = node("li");
    row.append(
      node(
        "span",
        `${site.hostname} · ${site.includeSubdomains ? "Including subdomains" : "Exact hostname only"}`,
      ),
      removeButton(`Remove excluded site ${site.hostname}`, () => {
        if (!draft) return;
        draft.excludedSites = draft.excludedSites.filter((entry) => entry !== site);
        renderSites();
      }),
    );
    list.append(row);
  }
}

function renderDefaults(): void {
  const list = element("site-defaults");
  list.replaceChildren();
  if (!draft || !catalog) return;
  if (!draft.siteDefaults.length)
    list.append(node("li", "No site defaults. Account selection requires configuration."));
  for (const selected of draft.siteDefaults) {
    const connection = catalog.connections.find((entry) => entry.id === selected.connectionId);
    const item = connection?.items.find((entry) => entry.id === selected.itemId);
    const resolved = resolveSiteAccount(draft, catalog, selected.origin);
    const row = node("li");
    const description = node(
      "span",
      `${selected.origin} → ${connection?.label ?? selected.connectionId} / ${item?.label ?? selected.itemId}`,
    );
    description.append(
      node(
        "small",
        resolved.ok
          ? "Available under this draft policy"
          : `Unavailable under this draft policy: ${unavailableReason(resolved.reason)}`,
      ),
    );
    row.append(
      description,
      removeButton(`Remove site default ${selected.origin}`, () => {
        if (draft) draft.siteDefaults = draft.siteDefaults.filter((entry) => entry !== selected);
      }),
    );
    list.append(row);
  }
}

function unavailableReason(reason: string): string {
  const descriptions: Record<string, string> = {
    "invalid-url": "The destination is invalid.",
    "site-excluded": "This site is excluded.",
    "default-not-set": "No default account is configured.",
    "item-origin-mismatch": "This account does not match the exact origin.",
    "connection-missing": "The vault connection is unavailable.",
    "connection-disabled": "The vault connection is disabled.",
    "item-missing": "The account is unavailable.",
    "item-excluded": "This account is excluded.",
    "item-not-selected": "This account is outside the selected groups and items.",
    "fields-excluded": "All fields in this account are excluded.",
  };
  return descriptions[reason] ?? "This account is unavailable.";
}

function renderSettings(): void {
  renderConnections();
  renderSites();
  renderDefaults();
  defaultAccount.replaceChildren();
  if (!catalog) return;
  for (const connection of catalog.connections) {
    const group = node("optgroup");
    group.label = connection.label;
    for (const item of connection.items) {
      const option = node("option", item.label);
      option.value = JSON.stringify([connection.id, item.id]);
      group.append(option);
    }
    defaultAccount.append(group);
  }
}

async function loadSettings(): Promise<void> {
  if (busy) return;
  busy = true;
  saveBlocked = true;
  settingsStatus.textContent = "Loading saved settings…";
  updateActions();
  try {
    const result = parseSettingsResponse(
      await browser.runtime.sendMessage({ version: 1, type: "settings.get" }),
    );
    if (!result.ok) {
      settingsStatus.textContent = `${result.error.message} Reload saved settings to retry. Your existing draft has been preserved.`;
      return;
    }
    snapshot = result.snapshot;
    draft = structuredClone(result.snapshot.settings);
    catalog = result.catalog;
    dirty = false;
    saveBlocked = false;
    siteHostname.value = "";
    siteSubdomains.checked = false;
    defaultOrigin.value = "";
    for (const input of [siteHostname, defaultOrigin]) input.setCustomValidity("");
    renderSettings();
    settingsStatus.textContent = `Saved settings loaded · Revision ${snapshot.revision}`;
  } catch {
    settingsStatus.textContent =
      "Unable to read saved settings. Your existing draft has been preserved. Reload saved settings to retry.";
  } finally {
    busy = false;
    updateActions();
  }
}

async function saveSettings(): Promise<void> {
  if (busy || saveBlocked || !draft || !snapshot || !dirty) return;
  busy = true;
  settingsStatus.textContent = "Saving local settings…";
  updateActions();
  try {
    const result = parseSettingsResponse(
      await browser.runtime.sendMessage({
        version: 1,
        type: "settings.save",
        expectedRevision: snapshot.revision,
        settings: structuredClone(draft),
      }),
    );
    if (!result.ok) {
      saveBlocked =
        result.error.code !== "invalid-settings" && result.error.code !== "invalid-request";
      settingsStatus.textContent =
        result.error.code === "revision-conflict"
          ? "Settings changed in another window. Your unsaved draft has been preserved. Reload saved settings to review the latest version before saving."
          : `${result.error.message} Your unsaved draft has been preserved.${saveBlocked ? " Reload saved settings to retry." : ""}`;
      return;
    }
    snapshot = result.snapshot;
    draft = structuredClone(result.snapshot.settings);
    catalog = result.catalog;
    dirty = false;
    renderSettings();
    settingsStatus.textContent = `Settings saved locally · Revision ${snapshot.revision}`;
  } catch {
    saveBlocked = true;
    settingsStatus.textContent =
      "Unable to confirm saved settings. Your unsaved draft has been preserved. Reload saved settings before trying again.";
  } finally {
    busy = false;
    updateActions();
  }
}

element("add-site").addEventListener("click", () => {
  if (!draft || busy) return;
  const hostname = normalizeHostname(siteHostname.value.trim());
  siteHostname.setCustomValidity(
    hostname ? "" : "Enter a hostname without a scheme, port or path.",
  );
  if (!hostname) {
    siteHostname.reportValidity();
    return;
  }
  draft.excludedSites = draft.excludedSites.filter((entry) => entry.hostname !== hostname);
  draft.excludedSites.push({ hostname, includeSubdomains: siteSubdomains.checked });
  siteHostname.value = "";
  siteSubdomains.checked = false;
  renderSites();
  changed();
});

element("add-default").addEventListener("click", () => {
  if (!draft || !catalog || busy) return;
  const value = defaultOrigin.value.trim();
  const url = parseSiteUrl(value);
  const valid = url && url.origin === value && normalizeHostname(url.hostname);
  defaultOrigin.setCustomValidity(
    valid ? "" : "Enter an exact HTTP(S) origin without a path or trailing slash.",
  );
  if (!valid || !url) {
    defaultOrigin.reportValidity();
    return;
  }
  const selected = catalog.connections
    .flatMap((connection) =>
      connection.items.map((item) => ({
        connectionId: connection.id,
        itemId: item.id,
        value: JSON.stringify([connection.id, item.id]),
      })),
    )
    .find((entry) => entry.value === defaultAccount.value);
  if (!selected) return;
  draft.siteDefaults = draft.siteDefaults.filter((entry) => entry.origin !== url.origin);
  draft.siteDefaults.push({
    origin: url.origin,
    connectionId: selected.connectionId,
    itemId: selected.itemId,
  });
  defaultOrigin.value = "";
  changed();
});

for (const input of [siteHostname, defaultOrigin])
  input.addEventListener("input", () => input.setCustomValidity(""));
element("settings-form").addEventListener("submit", (event) => {
  event.preventDefault();
  void saveSettings();
});
reload.addEventListener("click", () => void loadSettings());

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
void loadSettings();
