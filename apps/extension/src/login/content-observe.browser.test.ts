import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installLoginContent } from "./content";

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

/** The page's answer to a `login.observe` with these targets and flags. */
async function observe(command: Record<string, unknown>) {
  const token = sent.find((message) => typeof message["token"] === "string")?.["token"];
  let answer: unknown;
  for (const listener of listeners)
    listener(
      { version: 1, type: "login.observe", token, path: location.pathname, ...command },
      { id: "synthetic-extension" },
      (value) => (answer = value),
    );
  return answer as { targets: string[] };
}

describe("login.observe's hidden flags (ADR 0037 amendment of 2026-10-22)", () => {
  it("counts a hidden copy only for a target flagged hidden, as a marker", async () => {
    document.body.innerHTML = `<header><a name="account" href="/account">Account</a></header>
      <div hidden><a name="account" href="/account">Account</a>
        <input name="pw" type="password"><input name="pw" type="password"></div>`;
    uninstall = installLoginContent();
    await vi.advanceTimersByTimeAsync(200);
    const account = { by: "name", value: "account" };
    const pw = { by: "name", value: "pw" };
    expect(await observe({ targets: [account, pw], require: ["shown", "present"] })).toMatchObject({
      targets: ["unique", "missing"],
    });
    // A marker and the element it needs missing count every copy.
    expect(
      await observe({
        targets: [account, pw],
        require: ["shown", "present"],
        hidden: [true, true],
      }),
    ).toMatchObject({ targets: ["ambiguous", "ambiguous"] });
  });
});

describe("login.observe's sign-in inputs after an advance (ADR 0018)", () => {
  const field = { by: "data-test", value: "input__inner" };
  it("leaves out the recipe's own field the target finds alone", async () => {
    document.body.innerHTML = `<form><input id="email" autocomplete="username" aria-label="Email" data-test="input__inner"><button data-test="button">Continue</button></form>`;
    uninstall = installLoginContent();
    await vi.advanceTimersByTimeAsync(200);
    expect(await observe({ targets: [field], require: ["writable"], signIn: true })).toMatchObject({
      targets: ["unique"],
      signIn: { password: false, identifier: false },
    });
  });
  it("counts a password input sharing the recipe's test attribute (issue #1413)", async () => {
    // JetBrains Account keeps the email input above the password input it adds, both
    // `data-test="input__inner"`: the target names neither alone.
    document.body.innerHTML = `<form><input id="email" autocomplete="username" aria-label="Email" data-test="input__inner"><input id="password" type="password" autocomplete="current-password" aria-label="Password" data-test="input__inner"><button data-test="button">Log in</button><button type="button">Forgot password?</button></form>`;
    uninstall = installLoginContent();
    await vi.advanceTimersByTimeAsync(200);
    expect(await observe({ targets: [field], require: ["writable"], signIn: true })).toMatchObject({
      targets: ["ambiguous"],
      signIn: { password: true },
    });
  });
});

describe("login.observe's identifier that asks for the account (ADR 0026, 2026-11-20)", () => {
  const read = async (html: string) => {
    document.body.innerHTML = html;
    uninstall = installLoginContent();
    await vi.advanceTimersByTimeAsync(200);
    return observe({ targets: [], signIn: true });
  };
  it("counts an email input that is the page's only input, as an email-first page", async () => {
    expect(
      await read(
        `<form><input type="email" aria-label="Work email"><button>Continue</button></form>`,
      ),
    ).toMatchObject({ signIn: { identifier: true, signInIdentifier: true } });
  });
  it("counts an identifier input with a password input in its form", async () => {
    expect(
      await read(
        `<input type="search" aria-label="Search"><form><input autocomplete="username" aria-label="User"><input type="password" aria-label="Password"><button>Sign in</button></form>`,
      ),
    ).toMatchObject({ signIn: { identifier: true, signInIdentifier: true } });
  });
  it("leaves out an email input beside the page's other inputs, as a newsletter field", async () => {
    expect(
      await read(
        `<input type="search" aria-label="Search"><footer><form><input type="email" aria-label="Newsletter"><button>Subscribe</button></form></footer>`,
      ),
    ).toMatchObject({ signIn: { identifier: true, signInIdentifier: false } });
  });
});

describe("login.observe's page that shows no text yet (ADR 0026, 2026-11-20)", () => {
  const read = async (html: string) => {
    document.body.innerHTML = html;
    uninstall = installLoginContent();
    await vi.advanceTimersByTimeAsync(200);
    return observe({ targets: [], signIn: true });
  };
  it("reads a page with only an empty root or hidden text as blank", async () => {
    expect(
      await read(`<div id="root"></div><p hidden>Signed in</p><div style="display:none">x</div>`),
    ).toMatchObject({ signIn: { blank: true } });
  });
  it("reads a page with a visible heading as one that shows something", async () => {
    expect(await read(`<h1>Returned to relying party</h1>`)).toMatchObject({
      signIn: { blank: false },
    });
  });
});

describe("login.entry.check's list of accounts (ADR 0079)", () => {
  async function check() {
    const token = sent.find((message) => typeof message["token"] === "string")?.["token"];
    const answers: Promise<unknown>[] = [];
    for (const listener of listeners)
      answers.push(
        new Promise((resolve) =>
          listener(
            { version: 1, type: "login.entry.check", token, starts: [], timeoutMs: 0 },
            { id: "synthetic-extension" },
            resolve,
          ),
        ),
      );
    await vi.advanceTimersByTimeAsync(0);
    return Promise.race(answers);
  }
  it("names the list a page without a sign-in input shows beside its passkey button", async () => {
    document.body.innerHTML = `<h1>Welcome back</h1>
      <div><span>taro.yamada</span><button>Continue</button></div>
      <button>Use another profile</button>
      <button>Sign in with a passkey</button>`;
    uninstall = installLoginContent();
    await vi.advanceTimersByTimeAsync(200);
    expect(await check()).toEqual({
      ok: true,
      signIn: false,
      start: false,
      signUp: false,
      list: { names: expect.arrayContaining(["taro.yamada"]), other: true },
    });
  });
  it("sends no list beside a sign-in input", async () => {
    document.body.innerHTML = `<div><span>taro.yamada</span><button>Continue</button></div>
      <input type="password" aria-label="Password"><button>Sign in</button>`;
    uninstall = installLoginContent();
    await vi.advanceTimersByTimeAsync(200);
    expect(await check()).toEqual({ ok: true, signIn: true, start: false, signUp: false });
  });
});
