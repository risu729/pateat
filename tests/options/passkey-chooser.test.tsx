import { afterEach, expect, test, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { cleanup, render } from "vitest-browser-react";
// oxlint-disable-next-line import/no-unassigned-import -- Apply the options page stylesheet.
import "../../apps/extension/entrypoints/options/style.css";
import type { ChooserView } from "../../apps/extension/src/passkeys/chooser";
import { ChooserApp, type ChooserClient } from "../../apps/extension/src/passkeys/chooser-app";

// The passkey chooser window with a synthetic background.

const REQUEST = "6f1c1f0e-8a52-4c2e-9d4b-0b7e3f1a2c3d";

function view(overrides: Partial<ChooserView> = {}): ChooserView {
  return {
    origin: "https://login.example.test",
    rpId: "example.test",
    entries: [
      { item: "Example", userName: "synthetic-user-1", account: "Probe", preferred: true },
      { item: "Example (work)", userName: "synthetic-user-2", account: "Probe" },
      // A vault item without a name; the picker names it in the UI language.
      {},
    ],
    replacesDefault: false,
    again: false,
    ...overrides,
  };
}

function client(value: ChooserView) {
  const send = vi.fn(async (message: unknown) =>
    (message as { type: string }).type === "passkey-chooser.load"
      ? { ok: true, view: value }
      : { ok: true },
  );
  return { request: REQUEST, send, close: vi.fn() } satisfies ChooserClient;
}

afterEach(async () => {
  await cleanup();
});

test("names the site and lists each passkey by its user name, item and connection", async () => {
  await render(<ChooserApp client={client(view())} />);
  await expect
    .element(page.getByRole("heading", { name: "Sign in to login.example.test" }))
    .toBeVisible();
  const list = page.getByRole("list", { name: "Matching passkeys" });
  await expect
    .element(list.getByRole("button").nth(0))
    .toHaveTextContent("synthetic-user-1Example in ProbeDefault");
  await expect
    .element(list.getByRole("button").nth(1))
    .toHaveTextContent("synthetic-user-2Example (work) in Probe");
  await expect.element(list.getByRole("button").nth(2)).toHaveTextContent("Unnamed item");
  await expect
    .element(page.getByText("Pateat signed in here from this tab before"))
    .not.toBeInTheDocument();
  await expect
    .element(
      page.getByRole("checkbox", { name: "Use this account for login.example.test from now on" }),
    )
    .toBeChecked();
});

test("says why it asks again: Pateat's sign-in in the tab, or a logout clicked there", async () => {
  await render(<ChooserApp client={client(view({ again: true }))} />);
  await expect.element(page.getByText("Pateat signed in here from this tab before")).toBeVisible();
  await cleanup();
  await render(<ChooserApp client={client(view({ again: true, loggedOut: true }))} />);
  await expect.element(page.getByText("You logged out of this site in this tab")).toBeVisible();
  await expect
    .element(page.getByText("Pateat signed in here from this tab before"))
    .not.toBeInTheDocument();
});

test("offers to replace an existing default, unticked", async () => {
  const value = client(view({ replacesDefault: true }));
  await render(<ChooserApp client={value} />);
  const box = page.getByRole("checkbox", {
    name: "Replace the default account for login.example.test with this one",
  });
  await expect.element(box).not.toBeChecked();
  await page.getByRole("button", { name: /synthetic-user-2/u }).click();
  expect(value.send).toHaveBeenLastCalledWith({
    version: 1,
    type: "passkey-chooser.answer",
    request: REQUEST,
    answer: { kind: "chosen", index: 1, makeDefault: false },
  });
});

test("hands the request to the browser just once", async () => {
  const value = client(view());
  await render(<ChooserApp client={value} />);
  await page.getByRole("button", { name: "Use the browser or another extension" }).click();
  // Opening the menu answers nothing yet.
  expect(value.send).toHaveBeenCalledOnce();
  await page.getByRole("menuitem", { name: "Just once" }).click();
  expect(value.send).toHaveBeenLastCalledWith({
    version: 1,
    type: "passkey-chooser.answer",
    request: REQUEST,
    answer: { kind: "browser" },
  });
});

test("hands this and every later request of the site to the browser", async () => {
  const value = client(view({ origin: "https://login.example.test:8443" }));
  await render(<ChooserApp client={value} />);
  await page.getByRole("button", { name: "Use the browser or another extension" }).click();
  const always = page.getByRole("menuitem", { name: /^Always for this site/u });
  // It names the hostname it covers, without the port, and how to undo it.
  await expect
    .element(always)
    .toHaveTextContent(
      "Always for this sitePateat leaves passkeys on login.example.test to the browser. Undo it in Pateat's settings.",
    );
  await always.click();
  expect(value.send).toHaveBeenLastCalledWith({
    version: 1,
    type: "passkey-chooser.answer",
    request: REQUEST,
    answer: { kind: "browser-site" },
  });
});

test("closes only the menu on Escape", async () => {
  const value = client(view());
  await render(<ChooserApp client={value} />);
  await page.getByRole("button", { name: "Use the browser or another extension" }).click();
  await expect.element(page.getByRole("menuitem", { name: "Just once" })).toBeVisible();
  await userEvent.keyboard("{Escape}");
  await expect.element(page.getByRole("menuitem", { name: "Just once" })).not.toBeInTheDocument();
  expect(value.send).toHaveBeenCalledOnce();
  // Only the menu closes; a second Escape closes the window, which hands the request on.
  expect(value.close).not.toHaveBeenCalled();
  await userEvent.keyboard("{Escape}");
  expect(value.close).toHaveBeenCalledOnce();
});
