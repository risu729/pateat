import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  const values = new Map<string, unknown>();
  const watchers = new Map<string, Set<(value: unknown, previous: unknown) => void>>();
  // As `chrome.storage.onChanged`: a later task, and only when the value changes.
  const changed = (key: string, value: unknown, previous?: unknown) =>
    setTimeout(() => {
      for (const watcher of watchers.get(key) ?? []) watcher(value, previous);
    });
  return {
    values,
    changed,
    // A read takes the value when it starts and answers once this settles.
    gate: Promise.resolve() as Promise<void>,
    storage: {
      defineItem: vi.fn((key: string) => ({
        getValue: async () => {
          const value = values.get(key) ?? null;
          await h.gate;
          return value;
        },
        setValue: async (value: unknown) => {
          const previous = values.get(key);
          if (previous === value) return;
          values.set(key, value);
          changed(key, value, previous);
        },
        watch: (watcher: (value: unknown, previous: unknown) => void) => {
          const set = watchers.get(key) ?? new Set();
          set.add(watcher);
          watchers.set(key, set);
          return () => set.delete(watcher);
        },
      })),
    },
  };
});
vi.mock("wxt/utils/storage", () => ({ storage: h.storage }));
// Node has no window events; pages and the worker listen for `languagechange` on theirs.
const events = new EventTarget();
vi.stubGlobal("addEventListener", events.addEventListener.bind(events));
vi.stubGlobal("removeEventListener", events.removeEventListener.bind(events));
// The browser setting resolves from the browser's list.
vi.stubGlobal("navigator", { languages: ["en-US"] });

const { extensionLanguageStore, followLanguagePreference, i18n, saveLanguagePreference } =
  await import("./i18n");

const tick = () => new Promise((resolve) => setTimeout(resolve));

beforeEach(async () => {
  h.values.clear();
  await i18n.changeLanguage("en");
});

describe("the language preference as a synced profile setting (ADR 0043, ADR 0024)", () => {
  const KEY = "local:pateat.local-settings.v1";
  const snapshot = (language?: string) => ({
    version: 1,
    revision: 1,
    settings: language ? { excludedSites: [], language } : { excludedSites: [] },
  });
  /** The worker writing a new snapshot, as a sync or the settings page's save does. */
  const write = (next: unknown) => {
    const previous = h.values.get(KEY);
    h.values.set(KEY, next);
    h.changed(KEY, next, previous);
  };

  it("reads the settings snapshot's language, and never writes the snapshot itself", async () => {
    h.values.set(KEY, snapshot("ja"));
    const stop = await followLanguagePreference(extensionLanguageStore());
    expect(h.storage.defineItem).toHaveBeenCalledWith(KEY);
    expect(i18n.resolvedLanguage).toBe("ja");
    // The settings page saves the choice; this applies it here at once.
    saveLanguagePreference("en");
    expect(i18n.resolvedLanguage).toBe("en");
    expect(h.values.get(KEY)).toEqual(snapshot("ja"));
    stop();
  });

  it("follows a language synced in, even during the first read", async () => {
    h.values.set(KEY, snapshot());
    const { promise, resolve } = Promise.withResolvers<void>();
    h.gate = promise;
    const read = followLanguagePreference(extensionLanguageStore());
    // A sync writes after this page's read started and before it answers.
    write(snapshot("ja"));
    await tick();
    resolve();
    const stop = await read;
    expect(i18n.resolvedLanguage).toBe("ja");
    h.gate = Promise.resolve();
    stop();
  });

  it("follows only changes of the language, and absent is the browser setting", async () => {
    h.values.set(KEY, snapshot("ja"));
    const stop = await followLanguagePreference(extensionLanguageStore());
    const seen: (string | undefined)[] = [];
    const record = () => seen.push(i18n.resolvedLanguage);
    i18n.on("languageChanged", record);
    write({ ...snapshot("ja"), revision: 2 });
    await tick();
    expect(seen).toEqual([]);
    write(snapshot());
    await tick();
    i18n.off("languageChanged", record);
    // The browser setting resolves to the browser's English.
    expect(seen).toEqual(["en"]);
    stop();
  });

  it("does not apply its own earlier choice again after a quick change", async () => {
    h.values.set(KEY, snapshot());
    const stop = await followLanguagePreference(extensionLanguageStore());
    const seen: (string | undefined)[] = [];
    const record = () => seen.push(i18n.resolvedLanguage);
    i18n.on("languageChanged", record);
    saveLanguagePreference("ja");
    saveLanguagePreference("en");
    // The settings page's two saves land after both choices.
    write(snapshot("ja"));
    await tick();
    write(snapshot("en"));
    await tick();
    i18n.off("languageChanged", record);
    expect(seen).toEqual(["ja", "en"]);
    expect(i18n.resolvedLanguage).toBe("en");
    stop();
  });
});
