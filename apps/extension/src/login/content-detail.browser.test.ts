import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installLoginContent } from "./content";

// The popup's fill of a personal detail (ADR 0061) in a real Chromium document. Synthetic
// values only.
type Listener = (
  message: unknown,
  sender: { id: string },
  respond: (value: unknown) => void,
) => boolean | undefined;
const { sent, listeners } = vi.hoisted(() => ({
  sent: [] as Record<string, unknown>[],
  listeners: [] as Listener[],
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
    return { ok: false, reason: "stale-document" };
  },
}));

let uninstall: (() => void) | undefined;
beforeEach(() => {
  sent.length = 0;
  listeners.length = 0;
  vi.useFakeTimers();
});
afterEach(() => {
  uninstall?.();
  uninstall = undefined;
  vi.useRealTimers();
  document.body.innerHTML = "";
});

/** The page's answer to the popup's `login.detail.fill` of `input` with these values. */
async function fill(command: Record<string, unknown>) {
  const token = sent.find((message) => typeof message["token"] === "string")?.["token"];
  const answer: { value?: unknown } = {};
  for (const listener of listeners)
    listener(
      {
        version: 1,
        type: "login.detail.fill",
        token,
        path: location.pathname,
        target: { by: "name", value: "asked" },
        ...command,
      },
      { id: "synthetic-extension" },
      (value) => (answer.value = value),
    );
  // Typing waits between characters.
  for (let wait = 0; answer.value === undefined && wait < 200; wait += 1)
    // eslint-disable-next-line no-await-in-loop
    await vi.advanceTimersByTimeAsync(50);
  return answer.value;
}
/** A page whose form asks for one value in `input`, with `text` above it. */
async function page(input: string, text = "Confirm it's you") {
  uninstall?.();
  sent.length = 0;
  listeners.length = 0;
  document.body.innerHTML = `<main><h1>Verify</h1><form action="/verify">
    <p>${text}</p><label>Value ${input}</label><button id="next">Next</button></form></main>`;
  uninstall = installLoginContent();
  await vi.advanceTimersByTimeAsync(200);
  return document.querySelector<HTMLInputElement>('[name="asked"]')!;
}

describe("the popup's fill of a card value or a PIN (ADR 0061)", () => {
  it("fills a whole card number into a tel input that holds it", async () => {
    const input = await page('<input name="asked" type="tel" maxlength="19">');
    expect(await fill({ value: "4000000000000002", secret: "card-number" })).toEqual({ ok: true });
    expect(input.value).toBe("4000000000000002");
  });

  it("refuses a card number longer than the input's maxlength", async () => {
    const input = await page('<input name="asked" type="tel" maxlength="12">');
    expect(await fill({ value: "4000000000000002", secret: "card-number" })).toEqual({
      ok: false,
    });
    expect(input.value).toBe("");
  });

  it("fills a PIN into a password input, never into the account's password field", async () => {
    const input = await page('<input name="asked" type="password" maxlength="4">');
    expect(await fill({ value: "0123", secret: "pin" })).toEqual({ ok: true });
    expect(input.value).toBe("0123");
    const own = await page('<input name="asked" type="password" autocomplete="current-password">');
    expect(await fill({ value: "0123", secret: "pin" })).toEqual({ ok: false });
    expect(own.value).toBe("");
  });

  it.each([
    ["username", "card-number", "4000000000000002"],
    ["email", "pin", "0123"],
    ["one-time-code", "detail", "04/31"],
    ["new-password", "pin", "0123"],
  ])("refuses an input marked %s for a %s", async (token, secret, value) => {
    const input = await page(`<input name="asked" type="text" autocomplete="${token}">`);
    expect(await fill({ value, secret })).toEqual({ ok: false });
    expect(input.value).toBe("");
  });

  it("fills a card's expiry date as a detail into a text input, not a password input", async () => {
    const input = await page('<input name="asked" type="text" maxlength="5">');
    expect(await fill({ value: "04/31", secret: "detail" })).toEqual({ ok: true });
    expect(input.value).toBe("04/31");
    const hidden = await page('<input name="asked" type="password" maxlength="5">');
    expect(await fill({ value: "04/31", secret: "detail" })).toEqual({ ok: false });
    expect(hidden.value).toBe("");
  });

  it("fills nothing when the page shows another account than the login item's", async () => {
    const input = await page(
      '<input name="asked" type="tel" maxlength="19">',
      "Signed in as other@example.test",
    );
    expect(
      await fill({
        value: "4000000000000002",
        secret: "card-number",
        account: { username: "synthetic@example.test" },
      }),
    ).toEqual({ ok: false, reason: "other-account" });
    expect(input.value).toBe("");
    // The login item's own account is filled.
    expect(
      await fill({
        value: "4000000000000002",
        secret: "card-number",
        account: { username: "other@example.test" },
      }),
    ).toEqual({ ok: true });
    expect(input.value).toBe("4000000000000002");
  });
});
