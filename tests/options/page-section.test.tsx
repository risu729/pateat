import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { page } from "vitest/browser";
import { cleanup, render } from "vitest-browser-react";
import { PageSectionToggle } from "../../apps/extension/src/options/page-section-toggle";
import {
  followPageSectionShown,
  PAGE_SECTION_STORAGE_KEY,
  readPageSectionShown,
  savePageSectionShown,
} from "../../apps/extension/src/page-section";

// Whether the popup shows "This page" is presentation only: a localStorage value.

beforeEach(() => localStorage.clear());

afterEach(async () => {
  await cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
});

test("the section shows unless hidden is stored", () => {
  expect(readPageSectionShown()).toBe(true);
  localStorage.setItem(PAGE_SECTION_STORAGE_KEY, "sometimes");
  expect(readPageSectionShown()).toBe(true);
  savePageSectionShown(false);
  expect(localStorage.getItem(PAGE_SECTION_STORAGE_KEY)).toBe("hidden");
  expect(readPageSectionShown()).toBe(false);
  savePageSectionShown(true);
  expect(localStorage.getItem(PAGE_SECTION_STORAGE_KEY)).toBe("shown");
  expect(readPageSectionShown()).toBe(true);
});

test("unusable storage shows the section and saving does not throw", () => {
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw new DOMException("Synthetic storage denial", "SecurityError");
  });
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new DOMException("Synthetic storage denial", "SecurityError");
  });
  expect(readPageSectionShown()).toBe(true);
  expect(() => savePageSectionShown(false)).not.toThrow();
});

test("follows a choice another page makes", () => {
  const seen = vi.fn();
  const stop = followPageSectionShown(seen);
  localStorage.setItem(PAGE_SECTION_STORAGE_KEY, "hidden");
  window.dispatchEvent(new StorageEvent("storage", { key: PAGE_SECTION_STORAGE_KEY }));
  expect(seen).toHaveBeenLastCalledWith(false);

  // The theme changing leaves this choice alone.
  window.dispatchEvent(new StorageEvent("storage", { key: "pateat.theme" }));
  expect(seen).toHaveBeenCalledOnce();

  localStorage.clear();
  window.dispatchEvent(new StorageEvent("storage", { key: null }));
  expect(seen).toHaveBeenLastCalledWith(true);

  stop();
  window.dispatchEvent(new StorageEvent("storage", { key: PAGE_SECTION_STORAGE_KEY }));
  expect(seen).toHaveBeenCalledTimes(2);
});

test("the settings checkbox shows the stored choice and changes it", async () => {
  await render(<PageSectionToggle />);
  const box = page.getByRole("checkbox", { name: 'Show "This page" in the popup' });
  await expect.element(box).toBeChecked();

  await box.click();
  await expect.element(box).not.toBeChecked();
  expect(localStorage.getItem(PAGE_SECTION_STORAGE_KEY)).toBe("hidden");

  await box.click();
  await expect.element(box).toBeChecked();
  expect(localStorage.getItem(PAGE_SECTION_STORAGE_KEY)).toBe("shown");

  // Another open settings page changing it moves this checkbox too.
  localStorage.setItem(PAGE_SECTION_STORAGE_KEY, "hidden");
  window.dispatchEvent(new StorageEvent("storage", { key: PAGE_SECTION_STORAGE_KEY }));
  await expect.element(box).not.toBeChecked();
});
