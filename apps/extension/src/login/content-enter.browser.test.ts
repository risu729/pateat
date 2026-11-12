import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { observedPath } from "../observation/path";
import { installLoginContent } from "./content";

type Listener = (
  message: unknown,
  sender: { id: string },
  respond: (value: unknown) => void,
) => boolean | undefined;
const { sent, listeners, onDestination } = vi.hoisted(() => ({
  sent: [] as Record<string, unknown>[],
  listeners: [] as Listener[],
  onDestination: { run: undefined as (() => void) | undefined },
}));
vi.mock("wxt/browser", () => ({
  browser: {
    runtime: {
      id: "synthetic-extension",
      onMessage: {
        addListener: (listener: Listener) => listeners.push(listener),
        removeListener: () => undefined,
      },
    },
  },
}));
vi.mock("../messaging/protocol", () => ({
  sendMessage: async (_channel: string, message: Record<string, unknown>) => {
    sent.push(message);
    if (message["type"] === "login.destination.check") {
      onDestination.run?.();
      return { ok: true };
    }
    return message["type"] === "login.operation.authorize"
      ? true
      : { ok: false, reason: "stale-document" };
  },
}));

let uninstall: (() => void) | undefined;
let operations = 0;
beforeEach(() => {
  sent.length = 0;
  listeners.length = 0;
  operations = 0;
  onDestination.run = undefined;
  vi.useFakeTimers();
});
afterEach(() => {
  uninstall?.();
  uninstall = undefined;
  vi.useRealTimers();
  document.body.innerHTML = "";
});

const target = { by: "id" as const, value: "password" };
async function execute(kind: "fill" | "click") {
  const token = sent.find((message) => typeof message["token"] === "string")?.["token"];
  const path = observedPath(location.pathname);
  const operationId = `operation-enter-${++operations}`;
  const message = {
    version: 1,
    type: "login.execute",
    token,
    operation: {
      version: 1,
      attemptId: "attempt-enter",
      operationId,
      policyRevision: 1,
      expiresAt: Date.now() + 60_000,
      document: { origin: self.origin, tabId: 1, frameId: 0, documentId: "document-enter" },
      stepIndex: kind === "fill" ? 0 : 1,
      step:
        kind === "fill"
          ? { kind, effect: "prepare", path, fields: [{ slot: "password", target }] }
          : { kind, path, target, purpose: "submit", press: "enter" },
    },
    values: kind === "fill" ? [{ slot: "password", value: "synthetic-secret" }] : [],
  };
  const answer: { value?: unknown } = {};
  for (const listener of listeners)
    listener(message, { id: "synthetic-extension" }, (value) => (answer.value = value));
  for (let tick = 0; tick < 100 && answer.value === undefined; tick += 1)
    // eslint-disable-next-line no-await-in-loop
    await vi.advanceTimersByTimeAsync(100);
  expect(answer.value).toMatchObject({ operationId, documentId: "document-enter" });
  return answer.value;
}

async function formWith(
  names: string[],
  { invalid = false, noValidate = false, action = "" } = {},
) {
  document.body.innerHTML = `<form ${noValidate ? "novalidate" : ""} ${action ? `action="${action}"` : ""}>
    <input id="password" type="password" required>
    ${names.map((name) => `<input type="hidden" name="${name}" value="synthetic">`).join("")}
  </form>`;
  const form = document.querySelector("form")!;
  const submitted = vi.fn((event: SubmitEvent) => event.preventDefault());
  form.addEventListener("submit", submitted);
  uninstall = installLoginContent();
  await vi.advanceTimersByTimeAsync(200);
  expect(await execute("fill")).toMatchObject({ ok: true, mutation: "possible" });
  const input = document.querySelector<HTMLInputElement>("#password")!;
  expect(input.value).toBe("synthetic-secret");
  if (invalid) input.pattern = "different";
  return { form, submitted };
}

describe("Enter submission with form properties shadowed by named controls", () => {
  it.each(["checkValidity", "requestSubmit", "noValidate", "contains", "isConnected"])(
    "submits a valid filled form with a hidden control named %s",
    async (name) => {
      const { form, submitted } = await formWith([name]);
      expect(Reflect.get(form, name)).toBeInstanceOf(HTMLInputElement);
      expect(await execute("click")).toMatchObject({ ok: true, mutation: "possible" });
      expect(submitted).toHaveBeenCalledOnce();
    },
  );

  it("refuses an invalid form even when a hidden noValidate control is present", async () => {
    const { form, submitted } = await formWith(["noValidate", "checkValidity"], { invalid: true });
    expect(form.hasAttribute("novalidate")).toBe(false);
    expect(Reflect.get(form, "noValidate")).toBeInstanceOf(HTMLInputElement);
    expect(await execute("click")).toMatchObject({
      ok: false,
      reason: "fill-rejected",
      detail: "form-invalid",
      mutation: "none",
    });
    expect(submitted).not.toHaveBeenCalled();
  });

  it("honors the actual novalidate attribute despite every shadowing name", async () => {
    const { form, submitted } = await formWith(["checkValidity", "requestSubmit", "noValidate"], {
      invalid: true,
      noValidate: true,
    });
    expect(HTMLFormElement.prototype.checkValidity.call(form)).toBe(false);
    expect(await execute("click")).toMatchObject({ ok: true, mutation: "possible" });
    expect(submitted).toHaveBeenCalledOnce();
  });

  it("honors formnovalidate on the default button that appears after filling", async () => {
    const { form, submitted } = await formWith(["checkValidity", "noValidate"], { invalid: true });
    form.insertAdjacentHTML("beforeend", '<button type="submit" formnovalidate>Sign in</button>');
    expect(HTMLFormElement.prototype.checkValidity.call(form)).toBe(false);
    expect(await execute("click")).toMatchObject({ ok: true, mutation: "possible" });
    expect(submitted).toHaveBeenCalledOnce();
  });

  it("submits through a default button added after filling despite a control named contains", async () => {
    const { form, submitted } = await formWith(["contains", "isConnected"]);
    form.insertAdjacentHTML("beforeend", '<button type="submit">Sign in</button>');
    expect(Reflect.get(form, "contains")).toBeInstanceOf(HTMLInputElement);
    expect(await execute("click")).toMatchObject({ ok: true, mutation: "possible" });
    expect(submitted).toHaveBeenCalledOnce();
  });

  it("refuses a form removed while its destination is checked despite a control named isConnected", async () => {
    const { form, submitted } = await formWith(["isConnected"], {
      action: "https://elsewhere.example/sign-in",
    });
    onDestination.run = () => form.remove();
    expect(await execute("click")).toMatchObject({
      ok: false,
      reason: "structural-mismatch",
      detail: "form-changed",
      mutation: "none",
    });
    expect(Reflect.get(form, "isConnected")).toBeInstanceOf(HTMLInputElement);
    expect(submitted).not.toHaveBeenCalled();
  });
});
