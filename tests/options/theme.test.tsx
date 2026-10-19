import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { cdp, page } from "vitest/browser";
import { cleanup, render } from "vitest-browser-react";
// oxlint-disable-next-line import/no-unassigned-import -- Apply the options page stylesheet.
import "../../apps/extension/entrypoints/options/style.css";
import { ThemeSelect } from "../../apps/extension/src/options/theme-select";
import {
  followThemePreference,
  readThemePreference,
  saveThemePreference,
  THEME_STORAGE_KEY,
} from "../../apps/extension/src/theme";

// The theme choice is presentation only: a localStorage value and the root's data-theme.

const root = document.documentElement;
function token(name: string): string {
  const probe = document.createElement("span");
  probe.style.backgroundColor = `var(${name})`;
  root.append(probe);
  const color = getComputedStyle(probe).backgroundColor;
  probe.remove();
  return color;
}

beforeEach(() => {
  localStorage.clear();
  root.removeAttribute("data-theme");
});

afterEach(async () => {
  await cleanup();
  await cdp().send("Emulation.setEmulatedMedia", { features: [] });
  vi.restoreAllMocks();
  localStorage.clear();
  root.removeAttribute("data-theme");
});

test("follows the browser when nothing is stored", () => {
  root.setAttribute("data-theme", "dark");
  expect(readThemePreference()).toBe("system");
  const stop = followThemePreference();
  expect(root.hasAttribute("data-theme")).toBe(false);
  stop();
});

test("treats an invalid stored value as system", () => {
  localStorage.setItem(THEME_STORAGE_KEY, "sepia");
  root.setAttribute("data-theme", "light");
  expect(readThemePreference()).toBe("system");
  const stop = followThemePreference();
  expect(root.hasAttribute("data-theme")).toBe(false);
  stop();
});

test("treats unreadable storage as system", () => {
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw new DOMException("Synthetic storage denial", "SecurityError");
  });
  expect(readThemePreference()).toBe("system");
});

test("keeps a choice on the page when storage cannot be written", () => {
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new DOMException("Synthetic storage denial", "SecurityError");
  });
  saveThemePreference("dark");
  expect(root.getAttribute("data-theme")).toBe("dark");
});

test("stores and applies light and dark, and the tokens switch with them", () => {
  saveThemePreference("light");
  expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");
  expect(root.getAttribute("data-theme")).toBe("light");
  expect(token("--bg")).toBe("rgb(241, 245, 249)");
  expect(token("--accent")).toBe("rgb(17, 94, 89)");

  saveThemePreference("dark");
  expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
  expect(root.getAttribute("data-theme")).toBe("dark");
  expect(token("--bg")).toBe("rgb(14, 19, 22)");
  expect(token("--accent")).toBe("rgb(92, 199, 173)");
  expect(getComputedStyle(root).colorScheme).toBe("dark");

  saveThemePreference("system");
  expect(readThemePreference()).toBe("system");
  expect(root.hasAttribute("data-theme")).toBe(false);
});

test.each(["light", "dark"] as const)(
  "browser setting follows %s while explicit choices override it",
  async (scheme) => {
    await cdp().send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-color-scheme", value: scheme }],
    });
    saveThemePreference("system");
    expect(token("--bg")).toBe(scheme === "light" ? "rgb(241, 245, 249)" : "rgb(14, 19, 22)");
    saveThemePreference(scheme === "light" ? "dark" : "light");
    expect(token("--bg")).toBe(scheme === "light" ? "rgb(14, 19, 22)" : "rgb(241, 245, 249)");
    saveThemePreference("system");
    expect(root.hasAttribute("data-theme")).toBe(false);
    expect(token("--bg")).toBe(scheme === "light" ? "rgb(241, 245, 249)" : "rgb(14, 19, 22)");
  },
);

test("follows a choice another page makes", () => {
  const seen = vi.fn();
  const stop = followThemePreference(seen);
  localStorage.setItem(THEME_STORAGE_KEY, "dark");
  window.dispatchEvent(new StorageEvent("storage", { key: THEME_STORAGE_KEY, newValue: "dark" }));
  expect(root.getAttribute("data-theme")).toBe("dark");
  expect(seen).toHaveBeenLastCalledWith("dark");

  // Another key changing leaves the theme alone.
  window.dispatchEvent(new StorageEvent("storage", { key: "unrelated", newValue: "x" }));
  expect(seen).toHaveBeenCalledOnce();

  localStorage.clear();
  window.dispatchEvent(new StorageEvent("storage", { key: null }));
  expect(root.hasAttribute("data-theme")).toBe(false);
  expect(seen).toHaveBeenLastCalledWith("system");

  stop();
  localStorage.setItem(THEME_STORAGE_KEY, "light");
  window.dispatchEvent(new StorageEvent("storage", { key: THEME_STORAGE_KEY }));
  expect(root.hasAttribute("data-theme")).toBe(false);
});

test("the Theme select shows the stored choice and changes the theme", async () => {
  localStorage.setItem(THEME_STORAGE_KEY, "light");
  await render(<ThemeSelect />);
  const select = page.getByRole("combobox", { name: "Theme", exact: true });
  await expect.element(select).toHaveValue("light");
  expect(
    [...(select.element() as HTMLSelectElement).options].map((option) => option.textContent),
  ).toEqual(["Browser setting", "Light", "Dark"]);

  await select.selectOptions("dark");
  expect(root.getAttribute("data-theme")).toBe("dark");
  expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");

  localStorage.setItem(THEME_STORAGE_KEY, "system");
  window.dispatchEvent(new StorageEvent("storage", { key: THEME_STORAGE_KEY }));
  await expect.element(select).toHaveValue("system");
  expect(root.hasAttribute("data-theme")).toBe(false);
});
