import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { cdp, page } from "vitest/browser";
import { cleanup, render } from "vitest-browser-react";
// oxlint-disable-next-line import/no-unassigned-import -- Apply the options page stylesheet.
import "../../apps/extension/entrypoints/options/style.css";
import { useState } from "react";
import { ThemeSelect } from "../../apps/extension/src/options/theme-select";
import { followProfileTheme, noteOwnThemeChoice } from "../../apps/extension/src/theme-profile";
import { createDefaultSettings, type LocalSettings } from "../../packages/contracts/src/index";
import {
  followThemePreference,
  readThemePreference,
  saveThemePreference,
  THEME_STORAGE_KEY,
} from "../../apps/extension/src/theme";

// The theme choice is presentation only: the root's data-theme, from the synced profile
// setting `theme`, with a copy in this origin's localStorage for the next page's start.

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

test("the Theme select saves the choice as a profile setting and changes the theme", async () => {
  const saved = vi.fn<(value: LocalSettings["theme"]) => void>();
  function Harness() {
    const [draft, setDraft] = useState<LocalSettings>(() => ({
      ...createDefaultSettings(),
      theme: "light",
    }));
    return (
      <ThemeSelect
        draft={draft}
        edit={(update) => {
          const next = structuredClone(draft);
          update(next);
          saved(next.theme);
          setDraft(next);
          return true;
        }}
      />
    );
  }
  await render(<Harness />);
  const select = page.getByRole("combobox", { name: "Theme", exact: true });
  await expect.element(select).toHaveValue("light");
  expect(
    [...(select.element() as HTMLSelectElement).options].map((option) => option.textContent),
  ).toEqual(["Browser setting", "Light", "Dark"]);

  await select.selectOptions("dark");
  expect(saved).toHaveBeenLastCalledWith("dark");
  expect(root.getAttribute("data-theme")).toBe("dark");
  // This origin's copy lets the next page start in the theme.
  expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");

  // The browser setting is the absent field, as in the synced document.
  await select.selectOptions("system");
  expect(saved).toHaveBeenLastCalledWith(undefined);
  expect(root.hasAttribute("data-theme")).toBe(false);
});

test("a theme choice the settings page could not take changes nothing", async () => {
  await render(<ThemeSelect draft={createDefaultSettings()} edit={() => false} />);
  await page.getByRole("combobox", { name: "Theme", exact: true }).selectOptions("dark");
  expect(root.hasAttribute("data-theme")).toBe(false);
});

function profileStore(initial: unknown) {
  const watchers = new Set<(value: unknown) => void>();
  let value = initial;
  return {
    get: vi.fn(async () => value),
    watch: (changed: (value: unknown) => void) => {
      watchers.add(changed);
      return () => watchers.delete(changed);
    },
    set(next: unknown) {
      value = next;
      for (const watcher of watchers) watcher(next);
    },
  };
}

test("follows the synced theme and keeps this origin's copy for the next page's start", async () => {
  localStorage.setItem(THEME_STORAGE_KEY, "light");
  const store = profileStore("dark");
  const seen = vi.fn();
  const stop = followProfileTheme(store, seen);
  await vi.waitFor(() => expect(root.getAttribute("data-theme")).toBe("dark"));
  expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
  // Absent is the browser setting.
  store.set(undefined);
  expect(root.hasAttribute("data-theme")).toBe(false);
  expect(readThemePreference()).toBe("system");
  expect(seen).toHaveBeenLastCalledWith("system");
  // A value no version knows is the browser setting too.
  store.set("sepia");
  expect(readThemePreference()).toBe("system");
  stop();
  store.set("light");
  expect(root.hasAttribute("data-theme")).toBe(false);
});

test("its own quick choices' late save events do not flip the page back", async () => {
  const store = profileStore(undefined);
  const stop = followProfileTheme(store);
  await new Promise((resolve) => setTimeout(resolve));
  // The settings page chose dark, then light, applying each at once.
  saveThemePreference("dark");
  noteOwnThemeChoice("dark");
  saveThemePreference("light");
  noteOwnThemeChoice("light");
  store.set("dark");
  expect(root.getAttribute("data-theme")).toBe("light");
  store.set("light");
  expect(root.getAttribute("data-theme")).toBe("light");
  // A change made elsewhere afterwards still applies.
  store.set("dark");
  expect(root.getAttribute("data-theme")).toBe("dark");
  stop();
});

test("a synced change seen during the first read wins over what was read", async () => {
  let release!: (value: unknown) => void;
  const store = profileStore(undefined);
  store.get.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const stop = followProfileTheme(store);
  store.set("dark");
  release("light");
  await new Promise((resolve) => setTimeout(resolve));
  expect(root.getAttribute("data-theme")).toBe("dark");
  stop();
});
