import { useState } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { page } from "vitest/browser";
import { cleanup, render } from "vitest-browser-react";
import { i18n, saveLanguagePreference } from "../../apps/extension/src/i18n";
import { PagePermissions } from "../../apps/extension/src/options/page-permissions";
import { PopupPagePermissions } from "../../apps/extension/src/popup/page-permissions";
import {
  createDefaultSettings,
  DEFAULT_PAGE_PERMISSIONS,
  type LocalSettings,
} from "../../packages/contracts/src/index";

function settings(): LocalSettings {
  return { ...createDefaultSettings(), connections: [] };
}

async function mount(initial = settings(), popupOrigin?: string) {
  const changed = vi.fn<(value: LocalSettings) => void>();
  const openSettings = vi.fn();
  function Draft() {
    const [draft, setDraft] = useState(initial);
    function edit(update: (value: LocalSettings) => void) {
      const next = structuredClone(draft);
      update(next);
      changed(next);
      setDraft(next);
      return true;
    }
    return popupOrigin ? (
      <PopupPagePermissions
        settings={draft}
        origin={popupOrigin}
        disabled={false}
        onChange={edit}
        onOpenSettings={openSettings}
      />
    ) : (
      <PagePermissions draft={draft} edit={edit} />
    );
  }
  await render(<Draft />);
  return { changed, openSettings };
}
const select = (name: string) => page.getByRole("combobox", { name, exact: true });
const defaults = () => page.getByRole("group", { name: "Profile defaults", exact: true });
const row = (hostname: string) => page.getByRole("group", { name: hostname, exact: true });
const site = () => page.getByRole("textbox", { name: "Site", exact: true });
const add = () => page.getByRole("button", { name: "Add site rule", exact: true }).click();
beforeEach(() => {
  localStorage.clear();
  saveLanguagePreference("en");
});
afterEach(async () => {
  await cleanup();
  localStorage.clear();
  await i18n.changeLanguage("en");
});

test("all three defaults are editable and unavailable features are explained", async () => {
  const { changed } = await mount();
  await expect
    .element(defaults().getByRole("combobox", { name: "Sign-in pages", exact: true }))
    .toHaveValue("auto");
  await expect
    .element(
      defaults().getByRole("combobox", { name: "Verification while signed in", exact: true }),
    )
    .toHaveValue("fill");
  await expect
    .element(defaults().getByRole("combobox", { name: "Other personal-detail forms", exact: true }))
    .toHaveValue("fill");
  await expect.element(page.getByText(/Verification pages are not filled yet\./)).toBeVisible();
  await expect
    .element(page.getByText(/Filling personal details outside a login is not available yet\./))
    .toBeVisible();
  await defaults()
    .getByRole("combobox", { name: "Sign-in pages", exact: true })
    .selectOptions("fill");
  await defaults()
    .getByRole("combobox", { name: "Verification while signed in", exact: true })
    .selectOptions("off");
  await defaults()
    .getByRole("combobox", { name: "Other personal-detail forms", exact: true })
    .selectOptions("off");
  expect(changed.mock.lastCall?.[0].pagePermissionDefaults).toEqual({
    "sign-in": "fill",
    confirm: "off",
    "personal-details": "off",
  });
  await defaults()
    .getByRole("combobox", { name: "Sign-in pages", exact: true })
    .selectOptions("auto");
  await defaults()
    .getByRole("combobox", { name: "Verification while signed in", exact: true })
    .selectOptions("fill");
  await defaults()
    .getByRole("combobox", { name: "Other personal-detail forms", exact: true })
    .selectOptions("fill");
  expect(changed.mock.lastCall?.[0]).not.toHaveProperty("pagePermissionDefaults");
});

test("site CRUD canonicalizes hosts, preserves other kinds, and inherits per kind", async () => {
  const initial = settings();
  initial.sitePagePermissions = [
    {
      hostname: "example.com",
      includeSubdomains: true,
      permissions: { "sign-in": "fill", confirm: "off" },
    },
    {
      hostname: "login.example.com",
      includeSubdomains: false,
      permissions: { "sign-in": "auto", "personal-details": "off" },
    },
    { hostname: "other.example", includeSubdomains: false, permissions: { confirm: "off" } },
  ];
  const { changed } = await mount(initial);
  const login = row("login.example.com");
  await expect
    .element(login.getByRole("option", { name: "Use example.com's rule (Off)", exact: true }))
    .toBeInTheDocument();
  await expect
    .element(login.getByRole("option", { name: "Use profile default (Fill only)", exact: true }))
    .toBeInTheDocument();
  await login
    .getByRole("combobox", { name: "Sign-in pages", exact: true })
    .selectOptions("inherit");
  expect(changed.mock.lastCall?.[0].sitePagePermissions).toContainEqual({
    hostname: "login.example.com",
    includeSubdomains: false,
    permissions: { "personal-details": "off" },
  });
  await login
    .getByRole("combobox", { name: "Other personal-detail forms", exact: true })
    .selectOptions("inherit");
  expect(changed.mock.lastCall?.[0].sitePagePermissions?.map((entry) => entry.hostname)).toEqual([
    "example.com",
    "other.example",
  ]);
  await site().fill("https://BANK.example./");
  await add();
  await expect.element(row("bank.example")).toBeVisible();
  expect(changed.mock.lastCall?.[0].sitePagePermissions).toContainEqual({
    hostname: "bank.example",
    includeSubdomains: false,
    permissions: { "sign-in": "fill" },
  });
  await row("bank.example")
    .getByRole("combobox", { name: "Verification while signed in", exact: true })
    .selectOptions("off");
  await page
    .getByRole("button", { name: "Remove page behavior for bank.example", exact: true })
    .click();
  expect(changed.mock.lastCall?.[0].sitePagePermissions).toEqual(
    initial.sitePagePermissions?.filter((entry) => entry.hostname !== "login.example.com"),
  );
});

test.each([
  "not a host",
  "http://",
  "javascript:alert(1)",
  "https://bank.example/login",
  "https://user:password@example.com",
])("invalid site %s cannot change settings", async (input) => {
  const { changed } = await mount();
  await site().fill(input);
  await add();
  await expect.element(page.getByRole("alert")).toMatchTextContent("Enter a site");
  await expect.element(site()).toHaveAttribute("aria-invalid", "true");
  expect(changed).not.toHaveBeenCalled();
});

test(
  "the 1,000 unique-host limit rejects duplicates and new hosts",
  { timeout: 60_000 },
  async () => {
    const initial = settings();
    initial.sitePagePermissions = Array.from({ length: 1000 }, (_, index) => ({
      hostname: `site-${index}.example`,
      includeSubdomains: false,
      permissions: { "sign-in": "fill" },
    }));
    const { changed } = await mount(initial);
    await site().fill("SITE-0.example.");
    await add();
    await expect.element(page.getByRole("alert")).toMatchTextContent("already has a rule");
    await site().fill("new.example");
    await add();
    await expect.element(page.getByRole("alert")).toMatchTextContent("already 1,000 site rules");
    expect(changed).not.toHaveBeenCalled();
  },
);

test("popup writes only the canonical exact host and deleting one kind preserves the rest", async () => {
  const initial = settings();
  initial.sitePagePermissions = [
    {
      hostname: "example.com",
      includeSubdomains: true,
      permissions: { "sign-in": "fill", confirm: "off" },
    },
    {
      hostname: "login.example.com",
      includeSubdomains: false,
      permissions: { confirm: "fill", "personal-details": "off" },
    },
    { hostname: "unrelated.example", includeSubdomains: false, permissions: { "sign-in": "fill" } },
  ];
  const { changed } = await mount(initial, "https://login.example.com.");
  await expect.element(select("Sign-in pages")).toHaveValue("inherit");
  await select("Sign-in pages").selectOptions("auto");
  const exact = {
    hostname: "login.example.com",
    includeSubdomains: false,
    permissions: { "sign-in": "auto", confirm: "fill", "personal-details": "off" },
  };
  expect(changed.mock.lastCall?.[0].sitePagePermissions).toEqual([
    initial.sitePagePermissions[0],
    initial.sitePagePermissions[2],
    exact,
  ]);
  await select("Sign-in pages").selectOptions("inherit");
  expect(changed.mock.lastCall?.[0].sitePagePermissions).toContainEqual(
    initial.sitePagePermissions[1],
  );
  expect(changed.mock.lastCall?.[0].sitePagePermissions).toContainEqual(
    initial.sitePagePermissions[0],
  );
});

test("popup creates an exact override without changing the inherited parent rule", async () => {
  const initial = settings();
  initial.sitePagePermissions = [
    { hostname: "example.com", includeSubdomains: true, permissions: { "sign-in": "fill" } },
  ];
  const { changed } = await mount(initial, "https://login.example.com");
  await select("Sign-in pages").selectOptions("auto");
  expect(changed.mock.lastCall?.[0].sitePagePermissions).toEqual([
    ...initial.sitePagePermissions,
    { hostname: "login.example.com", includeSubdomains: false, permissions: { "sign-in": "auto" } },
  ]);
});

test("a popup on a broad rule is read only and links to scoped settings even with a trailing dot", async () => {
  const initial = settings();
  initial.sitePagePermissions = [
    {
      hostname: "example.com",
      includeSubdomains: true,
      permissions: { "sign-in": "fill", confirm: "off" },
    },
  ];
  const { changed, openSettings } = await mount(initial, "https://example.com.");
  await expect.element(page.getByRole("combobox")).not.toBeInTheDocument();
  await expect
    .element(page.getByRole("region", { name: "Page behavior", exact: true }))
    .toMatchTextContent("Sign-in pages: Fill only");
  await expect.element(page.getByText(/saved rule also covers its subdomains/)).toBeVisible();
  await page
    .getByRole("button", { name: "Edit profile defaults and site rules", exact: true })
    .click();
  expect(openSettings).toHaveBeenCalledExactlyOnceWith("page-permissions");
  expect(changed).not.toHaveBeenCalled();
});

test("a full popup can edit an existing host but cannot create another", async () => {
  const initial = settings();
  initial.sitePagePermissions = Array.from({ length: 1000 }, (_, index) => ({
    hostname: `site-${index}.example`,
    includeSubdomains: false,
    permissions: { "sign-in": "fill" },
  }));
  const { changed } = await mount(initial, "https://new.example");
  await expect.element(select("Sign-in pages")).toBeDisabled();
  expect(changed).not.toHaveBeenCalled();
  await cleanup();
  const editable = await mount(initial, "https://site-0.example");
  await expect.element(select("Sign-in pages")).toBeEnabled();
  await select("Sign-in pages").selectOptions("auto");
  expect(editable.changed.mock.lastCall?.[0].sitePagePermissions).toHaveLength(1000);
});

test("English and Japanese page controls keep their draft and translate validation and limits", async () => {
  const initial = settings();
  initial.pagePermissionDefaults = { ...DEFAULT_PAGE_PERMISSIONS, "sign-in": "fill" };
  const { changed } = await mount(initial);
  await site().fill("not a host");
  await add();
  await i18n.changeLanguage("ja");
  const translated = i18n.t("Page behavior");
  expect(translated).not.toBe("Page behavior");
  await expect.element(page.getByRole("heading", { name: translated, exact: true })).toBeVisible();
  await expect
    .element(page.getByRole("alert"))
    .toMatchTextContent(i18n.t("Enter a site such as https://bank.example or bank.example."));
  await expect
    .element(page.getByRole("textbox", { name: i18n.t("Site"), exact: true }))
    .toHaveValue("not a host");
  await expect
    .element(
      page
        .getByRole("group", { name: i18n.t("Profile defaults"), exact: true })
        .getByRole("combobox", { name: i18n.t("Sign-in pages"), exact: true }),
    )
    .toHaveValue("fill");
  expect(changed).not.toHaveBeenCalled();
  await i18n.changeLanguage("en");
  await expect.element(site()).toHaveValue("not a host");
});

test("a site's subdomain scope is explicit when adding and can be narrowed in settings", async () => {
  const { changed } = await mount();
  await site().fill("scope.example");
  await page.getByRole("checkbox", { name: "Apply to subdomains too", exact: true }).click();
  await add();
  expect(changed.mock.lastCall?.[0].sitePagePermissions).toEqual([
    { hostname: "scope.example", includeSubdomains: true, permissions: { "sign-in": "fill" } },
  ]);
  await page.getByRole("checkbox", { name: "Apply to subdomains too", exact: true }).nth(0).click();
  expect(changed.mock.lastCall?.[0].sitePagePermissions).toEqual([
    { hostname: "scope.example", includeSubdomains: false, permissions: { "sign-in": "fill" } },
  ]);
});
