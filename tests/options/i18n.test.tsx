import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { page } from "vitest/browser";
import { cleanup, render } from "vitest-browser-react";
import {
  followLanguagePreference,
  i18n,
  LANGUAGE_STORAGE_KEY,
  parseLanguagePreference,
  readLanguagePreference,
  resolveLanguage,
  saveLanguagePreference,
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

test("uses the browser setting when the stored preference is invalid or unreadable", () => {
  localStorage.setItem(LANGUAGE_STORAGE_KEY, "unsupported-language");
  expect(readLanguagePreference()).toBe("system");
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw new DOMException("Synthetic storage denial", "SecurityError");
  });
  expect(readLanguagePreference()).toBe("system");
});

test("applies Japanese on the page even when writing storage is denied", () => {
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new DOMException("Synthetic storage denial", "SecurityError");
  });
  expect(() => saveLanguagePreference("ja")).not.toThrow();
  expect(i18n.resolvedLanguage).toBe("ja");
  expect(i18n.t("Language")).toBe("言語");
});

test("follows other pages and browser language changes, and removes both listeners", () => {
  const seen = vi.fn();
  const stop = followLanguagePreference(seen);
  seen.mockClear();
  localStorage.setItem(LANGUAGE_STORAGE_KEY, "ja");
  window.dispatchEvent(new StorageEvent("storage", { key: LANGUAGE_STORAGE_KEY, newValue: "ja" }));
  expect(i18n.resolvedLanguage).toBe("ja");
  expect(seen).toHaveBeenLastCalledWith("ja");
  window.dispatchEvent(new StorageEvent("storage", { key: "unrelated", newValue: "en" }));
  expect(seen).toHaveBeenCalledOnce();

  const languages = vi.spyOn(navigator, "languages", "get").mockReturnValue(["ja-JP"]);
  localStorage.clear();
  window.dispatchEvent(new StorageEvent("storage", { key: null }));
  expect(seen).toHaveBeenLastCalledWith("system");
  expect(i18n.resolvedLanguage).toBe("ja");
  languages.mockReturnValue(["en-US"]);
  window.dispatchEvent(new Event("languagechange"));
  expect(i18n.resolvedLanguage).toBe("en");
  stop();
  seen.mockClear();
  localStorage.setItem(LANGUAGE_STORAGE_KEY, "ja");
  window.dispatchEvent(new StorageEvent("storage", { key: LANGUAGE_STORAGE_KEY }));
  window.dispatchEvent(new Event("languagechange"));
  expect(i18n.resolvedLanguage).toBe("en");
  expect(seen).not.toHaveBeenCalled();
});

test("the language control persists the choice and immediately translates its accessible label", async () => {
  await render(<LanguageSelect />);
  const english = page.getByRole("combobox", { name: "Language", exact: true });
  await expect.element(english).toHaveValue("en");
  await english.selectOptions("ja");
  const japanese = page.getByRole("combobox", { name: "言語", exact: true });
  await expect.element(japanese).toHaveValue("ja");
  expect(localStorage.getItem(LANGUAGE_STORAGE_KEY)).toBe("ja");
  expect(
    [...(japanese.element() as HTMLSelectElement).options].map((option) => option.value),
  ).toEqual(["system", "en", "ja"]);
  localStorage.setItem(LANGUAGE_STORAGE_KEY, "en");
  window.dispatchEvent(new StorageEvent("storage", { key: LANGUAGE_STORAGE_KEY, newValue: "en" }));
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
  await expect.element(page.getByText("このタブでこのサイトからログアウトしました")).toBeVisible();
  const list = page.getByRole("list", { name: "利用できるパスキー" });
  await expect
    .element(list)
    .toHaveTextContent("Synthetic userSynthetic account の <img src=x onerror=alert(1)>");
  expect(list.element().querySelector("img")).toBeNull();
  await page.getByRole("button", { name: "ブラウザーまたは別の拡張機能を使う" }).click();
  expect(send).toHaveBeenLastCalledWith({
    version: 1,
    type: "passkey-chooser.answer",
    request: "6f1c1f0e-8a52-4c2e-9d4b-0b7e3f1a2c3d",
    answer: { kind: "browser" },
  });
});
