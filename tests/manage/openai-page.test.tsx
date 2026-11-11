import { DEFAULT_MODEL_CONFIG, type ManageOpenAI } from "../../packages/contracts/src/index";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, test, vi } from "vitest";
import { page } from "vitest/browser";
import { cleanup, render } from "vitest-browser-react";
import { createManageClient, ManageApiError, type ManageClient } from "../../services/api/web/api";
import { ManageApp } from "../../services/api/web/app";

const empty: ManageOpenAI = {
  version: 1,
  configured: false,
  storage: "ready",
  storedInvalid: false,
};
const secret = "synthetic-openai-key-never-sent-to-a-provider";

function mockClient(initial: ManageOpenAI = empty) {
  let state = initial;
  const fetcher = vi.fn(async (input: string, init?: RequestInit) => {
    if (input === "/manage/api/models")
      return Response.json({
        version: 1,
        config: DEFAULT_MODEL_CONFIG,
        saved: false,
        catalog: "models-api",
        models: [],
      });
    if (input === "/manage/api/openai") {
      if (init?.method === "PUT") state = { ...empty, configured: true };
      if (init?.method === "DELETE") state = empty;
      return Response.json(state);
    }
    throw new Error(`Unexpected management request: ${input}`);
  });
  const client = createManageClient(fetcher);
  return { client, fetcher };
}

async function mount(client: ManageClient) {
  await render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <ManageApp client={client} path="/manage/openai" />
    </QueryClientProvider>,
  );
}
const field = () => page.getByLabelText("OpenAI API key", { exact: true });
const save = () => page.getByRole("button", { name: "Save key", exact: true });
const remove = () => page.getByRole("button", { name: "Remove saved key", exact: true });
afterEach(async () => {
  await cleanup();
  vi.restoreAllMocks();
});

test("shows an empty masked field, saves once, clears it and removes the saved key", async () => {
  const { client, fetcher } = mockClient();
  await mount(client);
  expect(document.title).toBe("OpenAI – Pateat");
  await expect
    .element(page.getByRole("link", { name: "OpenAI", exact: true }))
    .toHaveAttribute("aria-current", "page");
  await expect.element(field()).toHaveValue("");
  await expect.element(field()).toHaveAttribute("type", "password");
  await expect.element(save()).toBeDisabled();
  await expect.element(remove()).toBeDisabled();
  await field().fill(` ${secret} `);
  await save().click();
  await expect.element(page.getByText("OpenAI key saved", { exact: true })).toBeVisible();
  await expect.element(field()).toHaveValue("");
  expect(fetcher).toHaveBeenCalledWith("/manage/api/openai", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ version: 1, apiKey: secret }),
    credentials: "same-origin",
    redirect: "error",
  });
  await expect.element(remove()).toBeEnabled();
  await remove().click();
  await expect.element(page.getByText("OpenAI key removed", { exact: true })).toBeVisible();
  await expect.element(page.getByText("No key is saved.", { exact: true })).toBeVisible();
  await expect.element(remove()).toBeDisabled();
  expect(fetcher).toHaveBeenCalledWith("/manage/api/openai", {
    method: "DELETE",
    credentials: "same-origin",
    redirect: "error",
  });
  await vi.waitFor(() =>
    expect(fetcher.mock.calls.filter(([path]) => path === "/manage/api/models")).toHaveLength(3),
  );
});

test("permits removal of an unreadable key while operator storage is unavailable", async () => {
  const { client } = mockClient({
    ...empty,
    configured: true,
    storage: "unavailable",
    storedInvalid: true,
  });
  await mount(client);
  await expect
    .element(page.getByText("The saved key could not be opened. Replace or remove it."))
    .toBeVisible();
  await field().fill(secret);
  await expect.element(save()).toBeDisabled();
  await expect.element(remove()).toBeEnabled();
  await remove().click();
  await expect.element(page.getByText("OpenAI key removed", { exact: true })).toBeVisible();
});

test("keeps a failed save visible without claiming that a key was saved", async () => {
  const { client } = mockClient();
  vi.spyOn(client, "saveOpenAI").mockRejectedValue(new ManageApiError("network"));
  await mount(client);
  await field().fill(secret);
  await save().click();
  await expect
    .element(page.getByRole("alert"))
    .toMatchTextContent("Your sign-in may have expired.");
  await expect.element(field()).toHaveValue(secret);
  await expect.element(page.getByText("OpenAI key saved", { exact: true })).not.toBeInTheDocument();
  await expect.element(remove()).toBeDisabled();
});

test("the client rejects status answers that include a secret or unknown fields", async () => {
  const fetcher = vi.fn(async () => Response.json({ ...empty, apiKey: secret }));
  const client = createManageClient(fetcher);
  await expect(client.openai()).rejects.toMatchObject({ code: "unexpected-response" });
  await expect(client.saveOpenAI(secret)).rejects.toMatchObject({ code: "unexpected-response" });
  await expect(client.deleteOpenAI()).rejects.toMatchObject({ code: "unexpected-response" });
});
