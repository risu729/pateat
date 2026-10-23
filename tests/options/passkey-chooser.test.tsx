import { afterEach, expect, test, vi } from "vitest";
import { page } from "vitest/browser";
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
    .element(page.getByRole("heading", { name: "Log in to login.example.test" }))
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
    .element(
      page.getByRole("checkbox", { name: "Use this account for login.example.test from now on" }),
    )
    .toBeChecked();
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

test("hands the request to the browser", async () => {
  const value = client(view());
  await render(<ChooserApp client={value} />);
  await page.getByRole("button", { name: "Use the browser or another extension" }).click();
  expect(value.send).toHaveBeenLastCalledWith({
    version: 1,
    type: "passkey-chooser.answer",
    request: REQUEST,
    answer: { kind: "browser" },
  });
});

test("on a paused site, says so and leaves the box unticked (ADR 0062)", async () => {
  const value = client(
    view({
      entries: [
        { item: "Example", userName: "synthetic-user-1", account: "Probe" },
        { item: "Example (work)", userName: "synthetic-user-2", account: "Probe" },
      ],
      paused: true,
    }),
  );
  await render(<ChooserApp client={value} />);
  await expect
    .element(
      page.getByText(
        "Automatic login is paused on login.example.test, so Pateat logs in only with the passkey you choose.",
      ),
    )
    .toBeVisible();
  const box = page.getByRole("checkbox", {
    name: "Use this account for login.example.test from now on",
  });
  await expect.element(box).not.toBeChecked();
  await expect.element(page.getByText("Default")).not.toBeInTheDocument();
  await page.getByRole("button", { name: /synthetic-user-1/u }).click();
  expect(value.send).toHaveBeenLastCalledWith({
    version: 1,
    type: "passkey-chooser.answer",
    request: REQUEST,
    answer: { kind: "chosen", index: 0, makeDefault: false },
  });
});

/** A background that accepts only `right` as the master password. */
function checking(value: ChooserView) {
  const send = vi.fn(async (message: unknown) => {
    const sent = message as { type: string; password?: string };
    if (sent.type === "passkey-chooser.load") return { ok: true, view: value };
    if (sent.type === "passkey-chooser.verify")
      return { ok: true, matches: sent.password === "right" };
    return { ok: true };
  });
  return { request: REQUEST, send, close: vi.fn() } satisfies ChooserClient;
}

test("asks a password login's master password, says when it is wrong, and empties the field", async () => {
  const value = checking(
    view({
      purpose: "login",
      entries: [{ item: "Bank", account: "Probe", reprompt: true }],
    }),
  );
  await render(<ChooserApp client={value} />);
  await expect
    .element(page.getByText("Bitwarden asks for your master password before this item is used."))
    .toBeVisible();
  const field = page.getByLabelText("Master password");
  await expect.element(field).toHaveFocus();
  await expect.element(page.getByRole("checkbox")).not.toBeInTheDocument();
  await expect.element(page.getByRole("button", { name: "Cancel" })).toBeVisible();
  await field.fill("wrong");
  await page.getByRole("button", { name: "Log in" }).click();
  await expect.element(page.getByText("Invalid master password.")).toBeVisible();
  await expect.element(field).toHaveValue("");
  await expect.element(field).toHaveAttribute("aria-invalid", "true");
  await field.fill("right");
  await page.getByRole("button", { name: "Log in" }).click();
  await expect.element(page.getByRole("button", { name: "Log in" })).toBeDisabled();
  expect(value.send).toHaveBeenCalledWith({
    version: 1,
    type: "passkey-chooser.verify",
    request: REQUEST,
    index: 0,
    password: "right",
    makeDefault: false,
  });
});

test("asks the master password only after a re-prompt passkey is chosen, with a way back", async () => {
  const value = checking(
    view({
      entries: [
        { item: "Example", userName: "synthetic-user-1", account: "Probe", reprompt: true },
        { item: "Example (work)", userName: "synthetic-user-2", account: "Probe" },
      ],
    }),
  );
  await render(<ChooserApp client={value} />);
  const list = page.getByRole("list", { name: "Matching passkeys" });
  await expect
    .element(list.getByRole("img", { name: "Asks for the master password" }))
    .toBeVisible();
  await list.getByRole("button").nth(0).click();
  await expect.element(page.getByLabelText("Master password")).toHaveFocus();
  await page.getByRole("button", { name: "Other passkeys" }).click();
  await list.getByRole("button").nth(1).click();
  expect(value.send).toHaveBeenCalledWith(
    expect.objectContaining({
      type: "passkey-chooser.answer",
      answer: { kind: "chosen", index: 1, makeDefault: true },
    }),
  );
  expect(value.send).not.toHaveBeenCalledWith(
    expect.objectContaining({ type: "passkey-chooser.verify" }),
  );
});
