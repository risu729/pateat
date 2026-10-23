import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  const values = new Map<string, unknown>();
  const watchers = new Map<string, Set<(value: unknown) => void>>();
  // As `chrome.storage.onChanged`: a later task, and only when the value changes.
  const changed = (key: string, value: unknown) =>
    setTimeout(() => {
      for (const watcher of watchers.get(key) ?? []) watcher(value);
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
          if (values.get(key) === value) return;
          values.set(key, value);
          changed(key, value);
        },
        watch: (watcher: (value: unknown) => void) => {
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

const { extensionLanguageStore, followLanguagePreference, i18n, saveLanguagePreference } =
  await import("./i18n");

const tick = () => new Promise((resolve) => setTimeout(resolve));

beforeEach(async () => {
  h.values.clear();
  await i18n.changeLanguage("en");
});

describe("the language preference in extension storage (ADR 0043)", () => {
  it("reads and writes pateat.language in chrome.storage.local", async () => {
    h.values.set("local:pateat.language", "ja");
    const stop = await followLanguagePreference(extensionLanguageStore());
    expect(h.storage.defineItem).toHaveBeenCalledWith("local:pateat.language");
    expect(i18n.resolvedLanguage).toBe("ja");
    saveLanguagePreference("en");
    expect(i18n.resolvedLanguage).toBe("en");
    expect(h.values.get("local:pateat.language")).toBe("en");
    stop();
  });

  it("follows a choice another page writes, even during the first read", async () => {
    const { promise, resolve } = Promise.withResolvers<void>();
    h.gate = promise;
    const read = followLanguagePreference(extensionLanguageStore());
    // Another page writes after this page's read started and before it answers.
    h.values.set("local:pateat.language", "ja");
    h.changed("local:pateat.language", "ja");
    await tick();
    resolve();
    const stop = await read;
    expect(i18n.resolvedLanguage).toBe("ja");
    h.gate = Promise.resolve();
    stop();
  });

  it("does not apply its own earlier write again after a quick change", async () => {
    const stop = await followLanguagePreference(extensionLanguageStore());
    const seen: (string | undefined)[] = [];
    const record = () => seen.push(i18n.resolvedLanguage);
    i18n.on("languageChanged", record);
    saveLanguagePreference("ja");
    saveLanguagePreference("en");
    await tick();
    await tick();
    i18n.off("languageChanged", record);
    expect(seen).toEqual(["ja", "en"]);
    expect(i18n.resolvedLanguage).toBe("en");
    stop();
  });
});
