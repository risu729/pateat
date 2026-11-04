import { expect, it } from "vitest";
import { click, fill, walk } from "./__fixtures__/login-orders";

// An item without a password (ADR 0036): its login stops at the step that fills the
// password, answers the page's passkey request there or enters a passkey handler before
// it, and may take the passkey route before it submitted anything (ADR 0034).

const noPassword = { password: false, totp: false, passkey: true, discoverablePasskey: true };

it(
  "keeps an attempt's limits in every order of events: a stop before the password",
  { timeout: 120_000 },
  () => {
    const { states, types, failures } = walk(
      {
        id: "synthetic-stop",
        slots: ["username", "password"],
        steps: [
          fill("username"),
          click("next", "advance"),
          fill("password"),
          click("login", "submit"),
        ],
        maxSubmissions: 2,
        handlers: [{ kind: "passkey", path: "/login", target: { by: "id", value: "key" } }],
      },
      { facts: noPassword, stopAt: 2, routes: true, focused: true },
    );
    expect(failures).toEqual([]);
    expect(states).toBeGreaterThan(5000);
    for (const type of ["STOP_ANSWERED", "STOP_JUDGING", "HANDLER", "JUDGING", "ROUTE"])
      expect(types).toContain(type);
  },
);
