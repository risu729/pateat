import { afterEach, beforeEach, expect, onTestFinished, test, vi } from "vitest";
import { page } from "vitest/browser";
import { cleanup, render } from "vitest-browser-react";
import {
  currentLanguagePreference,
  followLanguagePreference,
  formatLocale,
  i18n,
  memoryLanguageStore,
  parseLanguagePreference,
  resolveLanguage,
  saveLanguagePreference,
  watchLanguagePreference,
  type LanguageStore,
} from "../../apps/extension/src/i18n";
import { LanguageSelect } from "../../apps/extension/src/options/language-select";

beforeEach(() => {
  localStorage.clear();
  saveLanguagePreference("en");
});

afterEach(async () => {
  await cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
  await i18n.changeLanguage("en");
});

test("parses only supported preferences and resolves browser languages in priority order", () => {
  for (const invalid of [null, undefined, "fr", "ja-JP", 1, {}, ["ja"]])
    expect(parseLanguagePreference(invalid)).toBe("system");
  expect(resolveLanguage("system", ["fr-FR", "ja-JP", "en-US"])).toBe("ja");
  expect(resolveLanguage("system", ["en-GB", "ja"])).toBe("en");
  expect(resolveLanguage("system", ["JA-jp"])).toBe("ja");
  expect(resolveLanguage("system", ["fr", "de"])).toBe("en");
  expect(resolveLanguage("system", [])).toBe("en");
  expect(resolveLanguage("en", ["ja"])).toBe("en");
  expect(resolveLanguage("ja", ["en"])).toBe("ja");
});

const unreadable: LanguageStore = {
  get: async () => {
    throw new DOMException("Synthetic storage denial", "SecurityError");
  },
  set: async () => {
    throw new DOMException("Synthetic storage denial", "SecurityError");
  },
  watch: () => () => undefined,
};

test("uses the browser setting when the stored preference is invalid or unreadable", async () => {
  saveLanguagePreference("ja");
  let stop = await followLanguagePreference(memoryLanguageStore("unsupported-language"));
  expect(currentLanguagePreference()).toBe("system");
  stop();
  saveLanguagePreference("ja");
  stop = await followLanguagePreference(unreadable);
  expect(currentLanguagePreference()).toBe("system");
  stop();
});

test("applies Japanese on the page even when writing storage is denied", async () => {
  const stop = await followLanguagePreference(unreadable);
  expect(() => saveLanguagePreference("ja")).not.toThrow();
  expect(i18n.resolvedLanguage).toBe("ja");
  expect(i18n.t("Language")).toBe("言語");
  stop();
});

test("keeps a choice made while the stored one is still being read", async () => {
  let answer!: (value: unknown) => void;
  const slow: LanguageStore = {
    ...memoryLanguageStore(),
    get: () => new Promise((resolve) => (answer = resolve)),
  };
  const following = followLanguagePreference(slow);
  saveLanguagePreference("ja");
  answer("en");
  const stop = await following;
  expect(currentLanguagePreference()).toBe("ja");
  expect(i18n.resolvedLanguage).toBe("ja");
  stop();
});

test("follows other pages and browser language changes, and removes both listeners", async () => {
  const store = memoryLanguageStore();
  const stop = await followLanguagePreference(store);
  const seen = vi.fn();
  const unwatch = watchLanguagePreference(seen);
  // Another extension page, or the service worker's copy of the store, wrote the choice.
  await store.set("ja");
  expect(i18n.resolvedLanguage).toBe("ja");
  expect(seen).toHaveBeenLastCalledWith("ja");

  const languages = vi.spyOn(navigator, "languages", "get").mockReturnValue(["ja-JP"]);
  await store.set("system");
  expect(seen).toHaveBeenLastCalledWith("system");
  expect(i18n.resolvedLanguage).toBe("ja");
  languages.mockReturnValue(["en-US"]);
  window.dispatchEvent(new Event("languagechange"));
  expect(i18n.resolvedLanguage).toBe("en");
  stop();
  unwatch();
  seen.mockClear();
  await store.set("ja");
  window.dispatchEvent(new Event("languagechange"));
  expect(i18n.resolvedLanguage).toBe("en");
  expect(seen).not.toHaveBeenCalled();
});

test("dates and lists use the browser's regional form of the UI language", () => {
  expect(formatLocale("en", ["ja-JP", "en-GB"])).toBe("en-GB");
  expect(formatLocale("ja", ["en-US", "ja-JP"])).toBe("ja-JP");
  expect(formatLocale("ja", ["en-US"])).toBe("ja");
});

test("the language control persists the choice and immediately translates its accessible label", async () => {
  const store = memoryLanguageStore();
  const stop = await followLanguagePreference(store);
  onTestFinished(stop);
  await render(<LanguageSelect />);
  const english = page.getByRole("combobox", { name: "Language", exact: true });
  await expect.element(english).toHaveValue("system");
  await english.selectOptions("ja");
  const japanese = page.getByRole("combobox", { name: "言語", exact: true });
  await expect.element(japanese).toHaveValue("ja");
  expect(await store.get()).toBe("ja");
  expect(
    [...(japanese.element() as HTMLSelectElement).options].map((option) => option.value),
  ).toEqual(["system", "en", "ja"]);
  await store.set("en");
  await expect.element(english).toHaveValue("en");
});

test("Japanese passkey chooser keeps interpolated account markup as literal text", async () => {
  saveLanguagePreference("ja");
  const { ChooserApp } = await import("../../apps/extension/src/passkeys/chooser-app");
  const send = vi.fn(async (message: unknown) =>
    (message as { type: string }).type === "passkey-chooser.load"
      ? {
          ok: true,
          view: {
            origin: "https://login.example.test",
            rpId: "example.test",
            entries: [
              {
                item: "<img src=x onerror=alert(1)>",
                userName: "Synthetic user",
                account: "Synthetic account",
              },
            ],
            replacesDefault: false,
            again: true,
            loggedOut: true,
          },
        }
      : { ok: true },
  );
  await render(
    <ChooserApp
      client={{ request: "6f1c1f0e-8a52-4c2e-9d4b-0b7e3f1a2c3d", send, close: vi.fn() }}
    />,
  );
  await expect
    .element(page.getByRole("heading", { name: "login.example.test にログイン" }))
    .toBeVisible();
  await expect
    .element(page.getByText("このタブでこのサイトからログアウトされました。"))
    .toBeVisible();
  const list = page.getByRole("list", { name: "一致するパスキー" });
  await expect
    .element(list)
    .toHaveTextContent("Synthetic userSynthetic account の <img src=x onerror=alert(1)>");
  expect(list.element().querySelector("img")).toBeNull();
  await page.getByRole("button", { name: "ブラウザーまたは別の拡張機能を使う" }).click();
  await expect
    .element(page.getByRole("menuitem", { name: /^このサイトでは常に/u }))
    .toHaveTextContent(
      "このサイトでは常にlogin.example.test のパスキーは今後ブラウザーに任せます。Pateat の設定で元に戻せます。",
    );
  await page.getByRole("menuitem", { name: "今回のみ" }).click();
  expect(send).toHaveBeenLastCalledWith({
    version: 1,
    type: "passkey-chooser.answer",
    request: "6f1c1f0e-8a52-4c2e-9d4b-0b7e3f1a2c3d",
    answer: { kind: "browser" },
  });
});
