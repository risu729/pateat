import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, test, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { cleanup, render } from "vitest-browser-react";
import {
  DEFAULT_MODEL_CONFIG,
  type ManageClaude,
  type ManageClaudeTest,
  type WifIdentifiers,
} from "../../packages/contracts/src/index";
import { createManageClient, ManageApiError, type ManageClient } from "../../services/api/web/api";
import { ManageApp } from "../../services/api/web/app";
import { describeTestResult } from "../../services/api/web/claude";

// Synthetic federation identifiers only; the client is replaced, so nothing leaves the page.

const OWNER = "4f3c2b1a-0e9d-4c8b-a7f6-e5d4c3b2a190";
const ids: WifIdentifiers = {
  federationRuleId: "fdrl_01SyntheticRule",
  organizationId: "00000000-0000-4000-8000-000000000000",
  serviceAccountId: "svac_01SyntheticAccount",
  workspaceId: "wrkspc_01SyntheticWorkspace",
};
const STORED_INVALID = "The saved identifiers are no longer valid. Enter them again.";
const LABELS = {
  federationRuleId: "Federation rule ID",
  organizationId: "Organization ID",
  serviceAccountId: "Service account ID",
  workspaceId: "Workspace ID",
} as const;

function stateOf(
  identifiers: WifIdentifiers | null,
  parts: { issuer?: string | null; storedInvalid?: boolean } = {},
): ManageClaude {
  return {
    version: 1,
    console: {
      issuer: parts.issuer === undefined ? "https://pateat.example" : parts.issuer,
      subject: `owner:${OWNER}`,
      audience: "https://api.anthropic.com",
    },
    identifiers,
    storedInvalid: parts.storedInvalid ?? false,
  };
}

function mockClient(initial: ManageClaude = stateOf(null)) {
  let state = initial;
  return {
    dashboard: vi.fn<ManageClient["dashboard"]>(),
    devices: vi.fn<ManageClient["devices"]>(async () => ({ version: 1, devices: [] })),
    revokeDevice: vi.fn<ManageClient["revokeDevice"]>(),
    settings: vi.fn<ManageClient["settings"]>(async () => ({
      version: 1,
      revision: 0,
      settings: null,
    })),
    saveSettings: vi.fn<ManageClient["saveSettings"]>(),
    recipes: vi.fn<ManageClient["recipes"]>(async () => ({
      version: 1,
      recipes: [],
      unreadable: [],
    })),
    revokeRecipe: vi.fn<ManageClient["revokeRecipe"]>(),
    requestLog: vi.fn<ManageClient["requestLog"]>(),
    deleteRequestLog: vi.fn<ManageClient["deleteRequestLog"]>(),
    models: vi.fn<ManageClient["models"]>(async () => ({
      version: 1,
      config: DEFAULT_MODEL_CONFIG,
      saved: false,
      catalog: "models-api",
      models: [],
    })),
    saveModels: vi.fn<ManageClient["saveModels"]>(),
    claude: vi.fn<ManageClient["claude"]>(async () => structuredClone(state)),
    saveClaude: vi.fn<ManageClient["saveClaude"]>(async (identifiers) => {
      state = { ...state, identifiers: structuredClone(identifiers), storedInvalid: false };
      return structuredClone(state);
    }),
    testClaude: vi.fn<ManageClient["testClaude"]>(async () => ({
      version: 1,
      result: { status: "ready", expiresInSeconds: 600 },
    })),
    replace(next: ManageClaude) {
      state = next;
    },
  } satisfies ManageClient & { replace(next: ManageClaude): void };
}

async function mount(client: ManageClient) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await render(
    <QueryClientProvider client={queryClient}>
      <ManageApp client={client} path="/manage/claude" />
    </QueryClientProvider>,
  );
}

/** Asserts every field's value at once. */
async function expectValues(values: Record<keyof typeof LABELS, string>) {
  await Promise.all(
    (Object.keys(LABELS) as (keyof typeof LABELS)[]).map((name) =>
      expect.element(field(name)).toHaveValue(values[name]),
    ),
  );
}

/** Types each identifier into its field, in the form's order. */
async function fillForm(values: Record<keyof typeof LABELS, string>) {
  await field("federationRuleId").fill(values.federationRuleId);
  await field("organizationId").fill(values.organizationId);
  await field("serviceAccountId").fill(values.serviceAccountId);
  await field("workspaceId").fill(values.workspaceId);
}

const field = (name: keyof typeof LABELS) => page.getByLabelText(LABELS[name], { exact: true });
const identifiersPanel = () => page.getByRole("region", { name: "Federation identifiers" });
const testPanel = () => page.getByRole("region", { name: "Test the connection" });
const saveButton = () => page.getByRole("button", { name: "Save identifiers", exact: true });
const testButton = () => page.getByRole("button", { name: "Test the token exchange" });

afterEach(async () => {
  await cleanup();
});

test("shows the Claude tab and the values to enter in the Claude Console", async () => {
  const client = mockClient();
  await mount(client);
  expect(document.title).toBe("Claude – Pateat");
  await expect
    .element(page.getByRole("link", { name: "Claude" }))
    .toHaveAttribute("aria-current", "page");
  await expect
    .element(page.getByRole("link", { name: "Claude" }))
    .toHaveAttribute("href", "/manage/claude");
  await expect.element(page.getByRole("heading", { level: 1, name: "Claude" })).toBeVisible();
  const consolePanel = page.getByRole("region", { name: "Claude Console" });
  await expect.element(consolePanel.getByText("https://pateat.example")).toBeVisible();
  await expect.element(consolePanel.getByText(`owner:${OWNER}`)).toBeVisible();
  await expect.element(consolePanel.getByText("https://api.anthropic.com")).toBeVisible();
  await expect
    .element(consolePanel)
    .toMatchTextContent(
      "workspace:inference if the Console offers it, otherwise workspace:developer",
    );
  await expect
    .element(page.getByText(/^To stop Pateat.s access to Claude, archive the federation rule/))
    .toBeVisible();
  // Only the page's own data is read.
  expect(client.claude).toHaveBeenCalledTimes(1);
  expect(client.devices).not.toHaveBeenCalled();
  expect(client.testClaude).not.toHaveBeenCalled();
});

test("says when the service has no OIDC issuer", async () => {
  await mount(mockClient(stateOf(null, { issuer: null })));
  await expect
    .element(page.getByRole("region", { name: "Claude Console" }))
    .toMatchTextContent("Issuer URLNot configured on this service");
});

test("starts with an empty form and no test while nothing is saved", async () => {
  await mount(mockClient());
  await expect.element(identifiersPanel()).toMatchTextContent("None are saved yet.");
  await expectValues({
    federationRuleId: "",
    organizationId: "",
    serviceAccountId: "",
    workspaceId: "",
  });
  await expect.element(testButton()).toBeDisabled();
});

test("prefills the saved identifiers", async () => {
  await mount(mockClient(stateOf(ids)));
  await expect.element(identifiersPanel()).toMatchTextContent("These identifiers are saved.");
  await expectValues(ids);
  await expect.element(testButton()).toBeEnabled();
});

test("marks each invalid field, focuses the first and saves nothing", async () => {
  const client = mockClient();
  await mount(client);
  await field("federationRuleId").fill("rule_01");
  await field("organizationId").fill(ids.organizationId);
  await field("serviceAccountId").fill(ids.serviceAccountId);
  await field("workspaceId").fill("wrkspc_bad!");
  await saveButton().click();

  await expect.element(field("federationRuleId")).toHaveAttribute("aria-invalid", "true");
  await expect.element(field("workspaceId")).toHaveAttribute("aria-invalid", "true");
  await expect.element(field("organizationId")).not.toHaveAttribute("aria-invalid");
  await expect.element(field("serviceAccountId")).not.toHaveAttribute("aria-invalid");
  await expect.element(field("federationRuleId")).toHaveFocus();
  await expect
    .element(field("federationRuleId"))
    .toHaveAccessibleDescription(
      "This is not a federation rule ID. Enter the rule's ID, which starts with fdrl_.",
    );
  await expect
    .element(field("workspaceId"))
    .toHaveAccessibleDescription(
      "This is not a workspace ID. Enter the workspace's ID, which starts with wrkspc_.",
    );
  await expect
    .element(field("organizationId"))
    .toHaveAccessibleDescription("Enter the organization's UUID.");
  await expect
    .element(page.getByRole("alert").first())
    .toHaveTextContent("This is not a federation rule ID.");
  expect(client.saveClaude).not.toHaveBeenCalled();

  // An empty form marks every field.
  await cleanup();
  await mount(client);
  await saveButton().click();
  await expect
    .element(field("organizationId"))
    .toHaveAccessibleDescription("This is not an organization ID. Enter the organization's UUID.");
  await expect
    .element(field("serviceAccountId"))
    .toHaveAccessibleDescription(
      "This is not a service account ID. Enter the service account's ID, which starts with svac_.",
    );
  await expect.element(field("federationRuleId")).toHaveFocus();
  expect(client.saveClaude).not.toHaveBeenCalled();
});

test("trims the identifiers, saves them and shows what was stored", async () => {
  const client = mockClient();
  await mount(client);
  await field("federationRuleId").fill(`  ${ids.federationRuleId}`);
  await field("organizationId").fill(`${ids.organizationId}\t`);
  await field("serviceAccountId").fill(` ${ids.serviceAccountId} `);
  await field("workspaceId").fill(ids.workspaceId);
  await userEvent.keyboard("{Enter}");

  await expect.element(page.getByText("Identifiers saved")).toBeVisible();
  expect(client.saveClaude).toHaveBeenCalledTimes(1);
  expect(client.saveClaude).toHaveBeenCalledWith(ids);
  await expect.element(identifiersPanel()).toMatchTextContent("These identifiers are saved.");
  await expect.element(field("federationRuleId")).toHaveValue(ids.federationRuleId);
  await expect.element(field("serviceAccountId")).toHaveValue(ids.serviceAccountId);
  await expect.element(testButton()).toBeEnabled();
  // The model list is read again with the new credential.
  await vi.waitFor(() => expect(client.models).toHaveBeenCalledTimes(2));
});

test("asks for the identifiers again when the saved row is no longer valid", async () => {
  const client = mockClient(stateOf(null, { storedInvalid: true }));
  await mount(client);
  await expect.element(identifiersPanel().getByRole("alert")).toHaveTextContent(STORED_INVALID);
  await expect.element(field("workspaceId")).toHaveValue("");
  await expect.element(testButton()).toBeDisabled();

  await fillForm(ids);
  await saveButton().click();
  await expect.element(page.getByText("Identifiers saved")).toBeVisible();
  await expect.element(page.getByText(STORED_INVALID)).not.toBeInTheDocument();
  await expect.element(testButton()).toBeEnabled();
  // The form is not rebuilt, so focus stays where the owner left it.
  await expect.element(saveButton()).toHaveFocus();
});

test.each([
  [
    new ManageApiError("bad_request"),
    "The service refused the identifiers. Check them and save again.",
  ],
  [new ManageApiError("not_paired"), /^No device is paired with this account yet\./],
  [
    new ManageApiError("network"),
    "Your sign-in may have expired. Reload the page to sign in again.",
  ],
])("reports a failed save (%s) and keeps the entered values", async (error, message) => {
  const client = mockClient();
  client.saveClaude.mockRejectedValue(error);
  await mount(client);
  await fillForm(ids);
  await saveButton().click();
  await expect.element(identifiersPanel().getByRole("alert")).toMatchTextContent(message);
  await expect.element(page.getByText("Identifiers saved")).not.toBeInTheDocument();
  await expect.element(field("workspaceId")).toHaveValue(ids.workspaceId);
  await expect.element(saveButton()).toBeEnabled();
});

test("tests the token exchange and shows how long the token lasts", async () => {
  const client = mockClient(stateOf(ids));
  let finish: (value: ManageClaudeTest) => void = () => {};
  client.testClaude.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await mount(client);
  await testButton().click();
  await expect.element(page.getByRole("button", { name: "Testing…" })).toBeDisabled();
  finish({ version: 1, result: { status: "ready", expiresInSeconds: 600 } });
  await expect
    .element(testPanel().getByText("Anthropic issued a token valid for 10 minutes."))
    .toBeVisible();
  await expect.element(testPanel().getByRole("alert")).not.toBeInTheDocument();
  expect(client.testClaude).toHaveBeenCalledTimes(1);
});

test.each<[ManageClaudeTest["result"], string]>([
  [
    { status: "rejected", httpStatus: 401 },
    "Anthropic refused the assertion (HTTP 401). Check the identifiers and the rule, then look at the authentication history in the Claude Console for the reason.",
  ],
  [
    { status: "failed", httpStatus: 500 },
    "The token exchange did not complete (HTTP 500). Try again later.",
  ],
  [{ status: "failed" }, "The token exchange did not complete. Try again later."],
  [
    { status: "issuer_unavailable" },
    "This service's OIDC issuer is not configured, so nothing can be signed.",
  ],
])("shows a test that did not get a token: %o", async (result, message) => {
  const client = mockClient(stateOf(ids));
  client.testClaude.mockResolvedValue({ version: 1, result });
  await mount(client);
  await testButton().click();
  await expect.element(testPanel().getByRole("alert")).toHaveTextContent(message);
  await expect.element(page.getByText(/Anthropic issued a token/)).not.toBeInTheDocument();
  await expect.element(testButton()).toBeEnabled();
});

test("reloads the page's state when the test finds the saved row invalid", async () => {
  const client = mockClient(stateOf(ids));
  client.testClaude.mockImplementation(async () => {
    client.replace(stateOf(null, { storedInvalid: true }));
    return { version: 1, result: { status: "stored_invalid" } };
  });
  await mount(client);
  await testButton().click();
  await expect.element(identifiersPanel().getByRole("alert")).toHaveTextContent(STORED_INVALID);
  // The form keeps its values, so the owner can save them again.
  await expect.element(field("workspaceId")).toHaveValue(ids.workspaceId);
  await expect.element(testButton()).toBeDisabled();
  // Focus stays on the button the owner used.
  await expect.element(testButton()).toHaveFocus();
  expect(client.claude).toHaveBeenCalledTimes(2);
});

test("keeps the page and what the owner typed when a refetch fails", async () => {
  const client = mockClient(stateOf(ids));
  client.testClaude.mockImplementation(async () => {
    client.claude.mockRejectedValue(new ManageApiError("network"));
    return { version: 1, result: { status: "stored_invalid" } };
  });
  await mount(client);
  await field("workspaceId").fill("wrkspc_02Typed");
  await testButton().click();
  await expect
    .element(page.getByText("Your sign-in may have expired. Reload the page to sign in again."))
    .toBeVisible();
  await expect.element(field("workspaceId")).toHaveValue("wrkspc_02Typed");
  await expect.element(saveButton()).toBeVisible();
  expect(client.claude).toHaveBeenCalledTimes(2);
});

test("reports a test request that got no answer", async () => {
  const client = mockClient(stateOf(ids));
  client.testClaude.mockRejectedValue(new ManageApiError("network"));
  await mount(client);
  await testButton().click();
  await expect
    .element(testPanel().getByRole("alert"))
    .toHaveTextContent("Your sign-in may have expired. Reload the page to sign in again.");
});

test("asks for a reload when the settings cannot be read", async () => {
  const client = mockClient();
  client.claude.mockRejectedValue(new ManageApiError("network"));
  await mount(client);
  await expect
    .element(page.getByRole("alert"))
    .toHaveTextContent("Your sign-in may have expired. Reload the page to sign in again.");
  await expect.element(field("workspaceId")).not.toBeInTheDocument();
  await expect.element(testButton()).not.toBeInTheDocument();

  await cleanup();
  client.claude.mockRejectedValue(new ManageApiError("not_paired"));
  await mount(client);
  await expect.element(page.getByRole("alert")).toMatchTextContent(/Pair a device first/);
  // Without a paired device the models cannot be read either, so they are not shown.
  await expect.element(page.getByRole("region", { name: "Models" })).not.toBeInTheDocument();
});

test("still shows the models when the identifiers cannot be read", async () => {
  const client = mockClient();
  client.claude.mockRejectedValue(new ManageApiError("network"));
  await mount(client);
  await expect.element(page.getByRole("region", { name: "Models" })).toBeVisible();
});

test.each<[ManageClaudeTest["result"], string]>([
  [{ status: "ready", expiresInSeconds: 600 }, "Anthropic issued a token valid for 10 minutes."],
  [{ status: "ready", expiresInSeconds: 119 }, "Anthropic issued a token valid for 119 seconds."],
  [{ status: "ready", expiresInSeconds: 1 }, "Anthropic issued a token valid for 1 second."],
  [{ status: "ready", expiresInSeconds: 3599 }, "Anthropic issued a token valid for 60 minutes."],
  [{ status: "not_configured" }, "Save the identifiers first."],
  [{ status: "stored_invalid" }, STORED_INVALID],
])("describes %o", (result, message) => {
  expect(describeTestResult(result)).toBe(message);
});

test("the client calls the Claude routes and never accepts a token in a test answer", async () => {
  const saved = stateOf(ids);
  const fetcher = vi.fn(async (input: string, init?: RequestInit) => {
    if (input === "/manage/api/claude/test")
      return Response.json({ version: 1, result: { status: "ready", expiresInSeconds: 600 } });
    if (input === "/manage/api/claude" && init?.method === "PUT") return Response.json(saved);
    if (input === "/manage/api/claude") return Response.json(stateOf(null));
    return Response.json({ error: "not_found" }, { status: 404 });
  });
  const client = createManageClient(fetcher);

  expect(await client.claude()).toEqual(stateOf(null));
  expect(fetcher).toHaveBeenLastCalledWith("/manage/api/claude", {
    credentials: "same-origin",
    redirect: "error",
  });
  expect(await client.saveClaude(ids)).toEqual(saved);
  expect(fetcher).toHaveBeenLastCalledWith("/manage/api/claude", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ version: 1, identifiers: ids }),
    credentials: "same-origin",
    redirect: "error",
  });
  expect(await client.testClaude()).toEqual({
    version: 1,
    result: { status: "ready", expiresInSeconds: 600 },
  });
  expect(fetcher).toHaveBeenLastCalledWith("/manage/api/claude/test", {
    method: "POST",
    credentials: "same-origin",
    redirect: "error",
  });

  fetcher.mockResolvedValueOnce(
    Response.json({
      version: 1,
      result: { status: "ready", expiresInSeconds: 600, token: "sk-ant-oat01-synthetic" },
    }),
  );
  await expect(client.testClaude()).rejects.toMatchObject({ code: "unexpected-response" });
  fetcher.mockResolvedValueOnce(Response.json({ ...saved, identifiers: { ...ids, extra: "x" } }));
  await expect(client.claude()).rejects.toMatchObject({ code: "unexpected-response" });
  fetcher.mockResolvedValueOnce(Response.json({ error: "bad_request" }, { status: 400 }));
  await expect(client.saveClaude(ids)).rejects.toMatchObject({ code: "bad_request" });
  fetcher.mockResolvedValueOnce(Response.json({ error: "not_paired" }, { status: 404 }));
  await expect(client.claude()).rejects.toMatchObject({ code: "not_paired" });
});
