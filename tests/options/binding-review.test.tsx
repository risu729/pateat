import { QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, test, vi } from "vitest";
import { page } from "vitest/browser";
import { cleanup, render } from "vitest-browser-react";
import { createMetadataQueryClient } from "../../apps/extension/src/options/client";
import { BindingReviewSection } from "../../apps/extension/src/popup/binding-review";
import type {
  BindingReviewClient,
  BindingReviewResponse,
} from "../../apps/extension/src/login/binding-review-wire";

afterEach(cleanup);
const repair: NonNullable<BindingReviewResponse["repair"]> = {
  reviewId: "synthetic-review",
  origin: "https://login.example",
  item: "Synthetic item",
  slots: [
    {
      slot: "branch",
      name: "Old branch",
      reason: "field-missing",
      candidates: [{ fieldId: "custom.branch", name: "New branch" }],
    },
    {
      slot: "account",
      name: "Old account",
      reason: "field-count-changed",
      candidates: [{ fieldId: "custom.account", name: "Account (1/2)" }],
    },
  ],
};
function mount(response: BindingReviewResponse = { ok: true, blocked: [], repair }) {
  const client = {
    get: vi.fn<BindingReviewClient["get"]>().mockResolvedValue(response),
    pick: vi.fn<BindingReviewClient["pick"]>().mockResolvedValue({ ok: true }),
  };
  const open = vi.fn();
  const queries = createMetadataQueryClient();
  render(
    <QueryClientProvider client={queries}>
      <BindingReviewSection client={client} tabId={7} onOpenSettings={open} />
    </QueryClientProvider>,
  );
  return { client, open, queries };
}

test("requires new choices when a fresh review replaces the one displayed", async () => {
  const { client, queries } = mount({
    ok: true,
    blocked: [],
    repair: { ...repair, slots: [repair.slots[0]!] },
  });
  const select = page.getByRole("combobox", { name: "Input 1: Old branch", exact: true });
  const retry = page.getByRole("button", { name: "Use these fields and retry", exact: true });
  await select.selectOptions("custom.branch");
  await expect.element(retry).toBeEnabled();
  client.get.mockResolvedValue({
    ok: true,
    blocked: [],
    repair: { ...repair, reviewId: "new-review", slots: [repair.slots[0]!] },
  });
  await queries.invalidateQueries({ queryKey: ["popup", "binding-review", 7] });
  await expect.element(retry).toBeDisabled();
  expect(client.pick).not.toHaveBeenCalled();
});

test("shows field names and requires every stale slot before retry, with one in-flight request", async () => {
  const { client } = mount();
  const retry = page.getByRole("button", { name: "Use these fields and retry", exact: true });
  await expect.element(retry).toBeDisabled();
  await page
    .getByRole("combobox", { name: "Input 1: Old branch", exact: true })
    .selectOptions("custom.branch");
  await expect.element(retry).toBeDisabled();
  await page
    .getByRole("combobox", { name: "Input 2: Old account", exact: true })
    .selectOptions("custom.account");
  const pending = Promise.withResolvers<{ ok: true }>();
  client.pick.mockReturnValueOnce(pending.promise);
  await retry.click();
  await expect.element(retry).toBeDisabled();
  expect(client.pick).toHaveBeenCalledExactlyOnceWith({
    tabId: 7,
    reviewId: "synthetic-review",
    picks: [
      { slot: "branch", fieldId: "custom.branch" },
      { slot: "account", fieldId: "custom.account" },
    ],
  });
  pending.resolve({ ok: true });
  await expect
    .element(page.getByRole("status"))
    .toHaveTextContent(
      "Pateat is retrying this login. The repaired fields are saved only after sign-in succeeds.",
    );
  expect(client.get).toHaveBeenCalledWith(7);
});

test("keeps retry disabled with no candidate and links to the existing settings review", async () => {
  const { open, client } = mount({
    ok: true,
    blocked: [
      { id: "synthetic-blocked", connection: "Synthetic vault", item: "Blocked synthetic item" },
    ],
    repair: { ...repair, slots: [{ ...repair.slots[0]!, candidates: [] }] },
  });
  await expect
    .element(
      page.getByText(
        "No allowed named field can fill this input. Check the item and its field exclusions in settings.",
        { exact: true },
      ),
    )
    .toBeVisible();
  await expect
    .element(page.getByRole("button", { name: "Use these fields and retry", exact: true }))
    .toBeDisabled();
  await expect
    .element(page.getByText("Blocked synthetic item — Synthetic vault", { exact: true }))
    .toBeVisible();
  await page.getByRole("button", { name: "Review fields in settings", exact: true }).click();
  expect(open).toHaveBeenCalledOnce();
  expect(client.pick).not.toHaveBeenCalled();
});

test.each(["stale-review", "not-a-candidate", "unavailable"] as const)(
  "reports %s without claiming the binding was saved",
  async (reason) => {
    const { client } = mount({
      ok: true,
      blocked: [],
      repair: { ...repair, slots: [repair.slots[0]!] },
    });
    client.pick.mockResolvedValue({ ok: false, reason });
    await page
      .getByRole("combobox", { name: "Input 1: Old branch", exact: true })
      .selectOptions("custom.branch");
    await page.getByRole("button", { name: "Use these fields and retry", exact: true }).click();
    const expected =
      reason === "stale-review"
        ? "The page, vault or settings changed. Reload the page to review its fields again."
        : reason === "not-a-candidate"
          ? "Choose a current allowed field for every input, then try again."
          : "Pateat could not restart this login. No repaired fields were saved. Try again from the page.";
    await expect.element(page.getByRole("status")).toHaveTextContent(expected);
  },
);
