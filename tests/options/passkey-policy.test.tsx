import { QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, test, vi } from "vitest";
import { page } from "vitest/browser";
import { cleanup, render } from "vitest-browser-react";
import { createMetadataQueryClient } from "../../apps/extension/src/options/client";
import {
  PasskeyPolicyPanel,
  type PasskeyPolicyClient,
} from "../../apps/extension/src/options/passkey-policy";
import {
  INITIAL_PASSKEY_POLICY,
  type PasskeyPolicy,
} from "../../apps/extension/src/passkeys/policy";

afterEach(async () => {
  await cleanup();
  vi.restoreAllMocks();
});

function policyClient(initial: PasskeyPolicy = INITIAL_PASSKEY_POLICY) {
  let stored = initial;
  return {
    read: vi.fn(async () => stored),
    write: vi.fn(async (value: PasskeyPolicy) => {
      stored = value;
    }),
  } satisfies PasskeyPolicyClient;
}

async function mount(client: PasskeyPolicyClient) {
  await render(
    <QueryClientProvider client={createMetadataQueryClient()}>
      <PasskeyPolicyPanel client={client} />
    </QueryClientProvider>,
  );
}

const presence = () =>
  page.getByLabelText("Answer passkey requests without a click on the page", { exact: true });
const verification = () =>
  page.getByLabelText("Tell sites that you were verified", { exact: true });
const status = () => document.querySelector("#passkey-policy-status")?.textContent;

test("both are on by default, and each turns off on its own on this device", async () => {
  const client = policyClient();
  await mount(client);
  await expect.element(presence()).toBeChecked();
  await expect.element(verification()).toBeChecked();
  await presence().click();
  await vi.waitFor(() =>
    expect(client.write).toHaveBeenLastCalledWith({
      presence: "activation",
      verification: "always",
    }),
  );
  await vi.waitFor(() => expect(status()).toBe("Saved on this device."));
  await verification().click();
  await vi.waitFor(() =>
    expect(client.write).toHaveBeenLastCalledWith({
      presence: "activation",
      verification: "never",
    }),
  );
  await expect.element(presence()).not.toBeChecked();
  await expect.element(verification()).not.toBeChecked();
  await presence().click();
  await vi.waitFor(() =>
    expect(client.write).toHaveBeenLastCalledWith({ presence: "always", verification: "never" }),
  );
});

test("a setting that cannot be read shows Unavailable and offers no change", async () => {
  await mount({ read: vi.fn(() => Promise.reject(new Error("storage"))), write: vi.fn() });
  await vi.waitFor(() => expect(status()).toBe("Unavailable"));
  await expect.element(presence()).toBeDisabled();
  await expect.element(verification()).toBeDisabled();
});

test("a failed save says so", async () => {
  const client = policyClient();
  client.write.mockRejectedValueOnce(new Error("storage"));
  await mount(client);
  await verification().click();
  await vi.waitFor(() =>
    expect(status()).toBe("The passkey setting could not be saved. Try again."),
  );
});
