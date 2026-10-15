import { useEffect, useState } from "react";

/**
 * Whether the popup shows its "This page" section (ADR 0038). Presentation only, so it is
 * kept per device in the extension's `localStorage` next to the theme, not in the
 * settings store.
 */
export const PAGE_SECTION_STORAGE_KEY = "pateat.popup-page-section";

/** True unless "hidden" is stored; unreadable storage shows the section. */
export function readPageSectionShown(): boolean {
  try {
    return localStorage.getItem(PAGE_SECTION_STORAGE_KEY) !== "hidden";
  } catch {
    return true;
  }
}

/** Stores the choice; other open pages follow through the `storage` event. */
export function savePageSectionShown(shown: boolean): void {
  try {
    localStorage.setItem(PAGE_SECTION_STORAGE_KEY, shown ? "shown" : "hidden");
  } catch {
    // Without storage the choice lasts until this page closes.
  }
}

/**
 * Calls back whenever another page of this origin changes the choice. Returns a function
 * that stops following.
 */
export function followPageSectionShown(onChange: (shown: boolean) => void): () => void {
  const listener = (event: StorageEvent) => {
    // A null key means the whole storage was cleared.
    if (event.key !== null && event.key !== PAGE_SECTION_STORAGE_KEY) return;
    onChange(readPageSectionShown());
  };
  window.addEventListener("storage", listener);
  return () => window.removeEventListener("storage", listener);
}

/** The stored choice, following changes made on another page, and its setter. */
export function usePageSectionShown(): [boolean, (shown: boolean) => void] {
  const [shown, setShown] = useState(readPageSectionShown);
  useEffect(() => followPageSectionShown(setShown), []);
  return [
    shown,
    (next) => {
      setShown(next);
      savePageSectionShown(next);
    },
  ];
}
