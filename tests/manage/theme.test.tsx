import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { page } from "vitest/browser";
import { cleanup, render } from "vitest-browser-react";
import { ManageApiError, type ManageClient } from "../../services/api/web/api";
import { ThemeSelect } from "../../services/api/web/theme-select";
import {
  followThemePreference,
  readThemePreference,
  saveThemePreference,
  THEME_STORAGE_KEY,
  type ThemePreference,
} from "../../services/api/web/theme";

// The /manage theme choice: the owner's synced choice, a localStorage copy and the root's
// data-theme. Synthetic service answers only.

const root = document.documentElement;

beforeEach(() => {
  localStorage.clear();
  root.removeAttribute("data-theme");
});

afterEach(async () => {
  await cleanup();
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

test("stores and applies light and dark", () => {
  saveThemePreference("light");
  expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");
  expect(root.getAttribute("data-theme")).toBe("light");

  saveThemePreference("dark");
  expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
  expect(root.getAttribute("data-theme")).toBe("dark");

  saveThemePreference("system");
  expect(readThemePreference()).toBe("system");
  expect(root.hasAttribute("data-theme")).toBe(false);
});

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

/** A synthetic service holding the owner's choice; none answers `not_paired`. */
function preferencesClient(theme: ThemePreference | undefined) {
  const state = { theme };
  return {
    state,
    preferences: vi.fn<ManageClient["preferences"]>(async () => {
      if (state.theme === undefined) throw new ManageApiError("not_paired");
      return { version: 1, theme: state.theme };
    }),
    savePreferences: vi.fn<ManageClient["savePreferences"]>(async (preferences) => {
      state.theme = preferences.theme;
      return preferences;
    }),
  };
}

function renderSelect(client: ReturnType<typeof preferencesClient>) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return {
    queryClient,
    rendered: render(
      <QueryClientProvider client={queryClient}>
        <ThemeSelect client={client} />
      </QueryClientProvider>,
    ),
  };
}

test("the Theme select shows the stored choice and changes the theme", async () => {
  localStorage.setItem(THEME_STORAGE_KEY, "light");
  // No paired device: the choice stays in this browser.
  const client = preferencesClient(undefined);
  await renderSelect(client).rendered;
  const select = page.getByRole("combobox", { name: "Theme", exact: true });
  await expect.element(select).toHaveValue("light");

  await select.selectOptions("dark");
  expect(root.getAttribute("data-theme")).toBe("dark");
  expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");

  localStorage.setItem(THEME_STORAGE_KEY, "system");
  window.dispatchEvent(new StorageEvent("storage", { key: THEME_STORAGE_KEY }));
  await expect.element(select).toHaveValue("system");
  expect(root.hasAttribute("data-theme")).toBe(false);
});

test("paints the copy first, then takes the owner's synced choice and saves a new one", async () => {
  localStorage.setItem(THEME_STORAGE_KEY, "light");
  const stop = followThemePreference();
  expect(root.getAttribute("data-theme")).toBe("light");
  // Another browser of the owner chose dark.
  const client = preferencesClient("dark");
  const { queryClient, rendered } = renderSelect(client);
  await rendered;
  const select = page.getByRole("combobox", { name: "Theme", exact: true });
  await expect.element(select).toHaveValue("dark");
  expect(root.getAttribute("data-theme")).toBe("dark");
  expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");

  await select.selectOptions("system");
  await vi.waitFor(() =>
    expect(client.savePreferences).toHaveBeenCalledWith({ version: 1, theme: "system" }),
  );
  expect(client.state.theme).toBe("system");
  expect(root.hasAttribute("data-theme")).toBe(false);

  // Another browser's later choice arrives with the next read, as on focus.
  client.state.theme = "light";
  await queryClient.invalidateQueries();
  await expect.element(select).toHaveValue("light");
  expect(root.getAttribute("data-theme")).toBe("light");
  stop();
});

test("keeps a choice the service could not save until its next answer", async () => {
  const client = preferencesClient("light");
  client.savePreferences.mockRejectedValueOnce(new ManageApiError("network"));
  const { queryClient, rendered } = renderSelect(client);
  await rendered;
  const select = page.getByRole("combobox", { name: "Theme", exact: true });
  await expect.element(select).toHaveValue("light");
  await select.selectOptions("dark");
  await vi.waitFor(() => expect(client.savePreferences).toHaveBeenCalledOnce());
  await expect.element(select).toHaveValue("dark");
  expect(root.getAttribute("data-theme")).toBe("dark");
  // The service still holds light, which its next answer brings back.
  await queryClient.invalidateQueries();
  await expect.element(select).toHaveValue("light");
});
