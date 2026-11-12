import { QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { cleanup, render } from "vitest-browser-react";
import { createMetadataQueryClient } from "../../apps/extension/src/options/client";
import { PopupSsoChoice } from "../../apps/extension/src/popup/sso-choice";
import { i18n } from "../../apps/extension/src/i18n";
import type { SsoClient, SsoResponse } from "../../apps/extension/src/login/sso-wire";
const origin = "https://site.example.test";
type Offer = NonNullable<Extract<SsoResponse, { ok: true }>["offer"]>;
const offer = (overrides: Partial<Offer> = {}): Offer => ({
  id: "offer-one",
  origin,
  accountLabel: "Synthetic site account",
  passkey: true,
  password: true,
  methods: [
    {
      method: { number: 1 },
      automatic: true,
      form: "bracket",
      label: "Synthetic Provider",
      candidates: [
        {
          id: "candidate-one",
          itemId: "opaque-item-one",
          itemLabel: "Synthetic provider account",
          connectionLabel: "Synthetic vault",
          origin: "https://idp.example.test",
        },
        {
          id: "candidate-two",
          itemId: "opaque-item-two",
          itemLabel: "Alternative provider account",
          connectionLabel: "Synthetic vault",
          origin: "https://other-idp.example.test",
        },
      ],
    },
  ],
  entries: [],
  ...overrides,
});
async function mount(initial = offer(), shownOrigin: string | undefined = origin) {
  let current: SsoResponse = { ok: true, offer: structuredClone(initial) };
  const client = {
    get: vi.fn<SsoClient["get"]>(async () => structuredClone(current)),
    choose: vi.fn<SsoClient["choose"]>(async () => ({ ok: true })),
    cancel: vi.fn<SsoClient["cancel"]>(async () => ({ ok: true })),
  };
  const query = createMetadataQueryClient();
  await render(
    <QueryClientProvider client={query}>
      <PopupSsoChoice client={client} tabId={7} origin={shownOrigin} />
    </QueryClientProvider>,
  );
  const update = (next: SsoResponse) => {
    current = structuredClone(next);
    query.setQueryData(["popup", "sso", 7], current);
  };
  return { client, query, update };
}
const method = () => page.getByRole("combobox", { name: "Method for this sign-in" });
const account = () => page.getByRole("combobox", { name: "Saved account and sign-in origin" });
const continueButton = () => page.getByRole("button", { name: "Continue", exact: true });
beforeEach(async () => {
  await i18n.changeLanguage("en");
});
afterEach(async () => {
  await cleanup();
  await i18n.changeLanguage("en");
});

test("the popup displays methods for one chosen account and sends only opaque explicit choices", async () => {
  const h = await mount();
  await expect.element(page.getByRole("heading", { name: "Sign-in method" })).toBeVisible();
  await expect
    .element(page.getByText("Choose how to sign in as Synthetic site account."))
    .toBeVisible();
  await expect.element(continueButton()).toBeDisabled();
  await method().selectOptions("password");
  await userEvent.click(continueButton());
  expect(h.client.choose).toHaveBeenCalledExactlyOnceWith({
    tabId: 7,
    offerId: "offer-one",
    selection: { kind: "native", route: "password" },
  });
  expect(JSON.stringify(h.client.choose.mock.calls)).not.toMatch(
    /username|passwordValue|proof|sourceEvidence/u,
  );
});

test("provider mappings can be explicitly saved, replaced, and removed", async () => {
  const h = await mount();
  await account().selectOptions("candidate-one");
  await userEvent.click(page.getByRole("button", { name: "Save provider mapping" }));
  expect(h.client.choose).toHaveBeenLastCalledWith({
    tabId: 7,
    offerId: "offer-one",
    selection: { kind: "mapping", method: { number: 1 }, candidateId: "candidate-one" },
  });
  h.update({
    ok: true,
    offer: offer({ methods: [{ ...offer().methods[0]!, selectedId: "candidate-one" }] }),
  });
  await expect.element(page.getByRole("button", { name: "Remove provider mapping" })).toBeVisible();
  await account().selectOptions("candidate-two");
  await userEvent.click(page.getByRole("button", { name: "Save provider mapping" }));
  expect(h.client.choose).toHaveBeenLastCalledWith({
    tabId: 7,
    offerId: "offer-one",
    selection: { kind: "mapping", method: { number: 1 }, candidateId: "candidate-two" },
  });
  await userEvent.click(page.getByRole("button", { name: "Remove provider mapping" }));
  expect(h.client.choose).toHaveBeenLastCalledWith({
    tabId: 7,
    offerId: "offer-one",
    selection: { kind: "unmap", method: { number: 1 } },
  });
});

test("URL methods require an explicitly selected observed page entry", async () => {
  const initial = offer({
    password: false,
    methods: [
      { ...offer().methods[0]!, form: "url", label: undefined, selectedId: "candidate-one" },
    ],
    entries: [{ id: "observed-one", label: "Continue with local provider" }],
  });
  const h = await mount(initial);
  await method().selectOptions("1");
  await expect.element(continueButton()).toBeDisabled();
  await page
    .getByRole("combobox", { name: "Entry shown on this page" })
    .selectOptions("observed-one");
  await userEvent.click(continueButton());
  expect(h.client.choose).toHaveBeenCalledExactlyOnceWith({
    tabId: 7,
    offerId: "offer-one",
    selection: {
      kind: "sso",
      method: { number: 1 },
      candidateId: "candidate-one",
      entryId: "observed-one",
    },
  });
});

test.each([
  ["mapping-required", "Choose and save the provider account and origin for every enabled method."],
  [
    "duplicate-idp",
    "Two methods name the same provider account. Choose distinct accounts before continuing.",
  ],
  [
    "invalid-value",
    "The SSO fields have invalid syntax, duplicate methods or mixed formats. Correct the vault item and sync it.",
  ],
  ["entry-required", "Choose the provider entry displayed on this page."],
] as const)(
  "%s renders a useful fixed explanation without private values",
  async (reason, text) => {
    await mount(
      offer({ reason, field: "SSO 2", blocked: reason === "invalid-value" ? true : undefined }),
    );
    await expect.element(page.getByRole("status")).toHaveTextContent(`SSO field: SSO 2. ${text}`);
    await expect.element(page.getByText(/SSO field: SSO 2/u)).toBeVisible();
    expect(document.body.textContent).not.toMatch(
      /usernameProof|sourceEvidence|private-synthetic@example.test/u,
    );
  },
);

test("a blocked offer and a request in flight cannot start another choice", async () => {
  const h = await mount();
  const held = Promise.withResolvers<Awaited<ReturnType<SsoClient["choose"]>>>();
  h.client.choose.mockReturnValueOnce(held.promise);
  await method().selectOptions("passkey");
  await userEvent.click(continueButton());
  await expect.element(continueButton()).toBeDisabled();
  await expect.element(page.getByRole("button", { name: "Cancel", exact: true })).toBeDisabled();
  expect(h.client.choose).toHaveBeenCalledTimes(1);
  held.resolve({ ok: false, reason: "scope-changed" });
  await expect.element(continueButton()).toBeEnabled();
  h.update({ ok: true, offer: offer({ blocked: true, reason: "invalid-value" }) });
  await expect.element(continueButton()).toBeDisabled();
});

test("cancel sends only the exact current offer and handles unavailable actions", async () => {
  const h = await mount();
  h.client.cancel.mockRejectedValueOnce(new Error("synthetic unavailable"));
  await userEvent.click(page.getByRole("button", { name: "Cancel", exact: true }));
  expect(h.client.cancel).toHaveBeenCalledExactlyOnceWith(7, "offer-one");
  await expect
    .element(
      page.getByText(
        "This sign-in method is unavailable or changed. Check the vault and reopen the choice.",
      ),
    )
    .toBeVisible();
});

test("an offer from another origin is not displayed in the current popup", async () => {
  const h = await mount(offer(), "https://unrelated.example.test");
  await expect.poll(() => h.client.get.mock.calls.length).toBeGreaterThan(0);
  await expect
    .element(page.getByRole("heading", { name: "Sign-in method" }))
    .not.toBeInTheDocument();
  expect(document.body.textContent).not.toContain("Synthetic site account");
});

test("a replacement offer resets an old in-flight choice and ignores its late response", async () => {
  const h = await mount();
  const held = Promise.withResolvers<Awaited<ReturnType<SsoClient["choose"]>>>();
  h.client.choose.mockReturnValueOnce(held.promise);
  await method().selectOptions("password");
  await userEvent.click(continueButton());
  await expect.element(method()).toBeDisabled();
  h.update({
    ok: true,
    offer: offer({ id: "offer-replacement", accountLabel: "Replacement site account" }),
  });
  await expect
    .element(page.getByText("Choose how to sign in as Replacement site account."))
    .toBeVisible();
  await expect.element(method()).toBeEnabled();
  await expect.element(method()).toHaveValue("");
  held.resolve({ ok: false, reason: "duplicate-idp" });
  await expect
    .element(
      page.getByText(
        "Two methods name the same provider account. Choose distinct accounts before continuing.",
      ),
    )
    .not.toBeInTheDocument();
  await method().selectOptions("passkey");
  await userEvent.click(continueButton());
  expect(h.client.choose).toHaveBeenLastCalledWith({
    tabId: 7,
    offerId: "offer-replacement",
    selection: { kind: "native", route: "passkey" },
  });
});

test("Japanese method controls preserve the same opaque native choice", async () => {
  await i18n.changeLanguage("ja");
  const h = await mount();
  await expect
    .element(page.getByRole("heading", { name: "ログイン方法", exact: true }))
    .toBeVisible();
  await page.getByRole("combobox", { name: "今回のログイン方法" }).selectOptions("password");
  await userEvent.click(page.getByRole("button", { name: "続ける", exact: true }));
  expect(h.client.choose).toHaveBeenCalledExactlyOnceWith({
    tabId: 7,
    offerId: "offer-one",
    selection: { kind: "native", route: "password" },
  });
});
