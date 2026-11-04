import { expect, it } from "vitest";
import { click, fill, walk } from "./__fixtures__/login-orders";

// Handlers after the submission (ADR 0027): a code with its button, which the page may
// submit by itself at its last digit, and an authenticator app's choice that a later
// revision adds, which the login takes over.

const facts = { password: true, totp: true, passkey: false, discoverablePasskey: false };
const recipe = {
  id: "synthetic-handlers",
  slots: ["username", "password"],
  steps: [fill("username", "password"), click("login", "submit")],
  maxSubmissions: 1,
};

it(
  "keeps an attempt's limits in every order of events: a code handler after a click",
  { timeout: 120_000 },
  () => {
    const { states, types, failures } = walk(
      {
        ...recipe,
        handlers: [
          {
            kind: "totp",
            path: "/verify",
            field: { by: "id", value: "code" },
            target: { by: "id", value: "verify" },
          },
        ],
      },
      { facts, focused: true },
    );
    expect(failures).toEqual([]);
    // A guard against events that no longer reach most states, which would pass trivially.
    expect(states).toBeGreaterThan(3000);
    for (const type of ["HANDLER", "AUTO_SUBMITTED"]) expect(types).toContain(type);
  },
);

it(
  "keeps an attempt's limits in every order of events: a handler a later revision adds",
  { timeout: 120_000 },
  () => {
    const { states, types, failures } = walk(recipe, { facts, focused: true }, [
      {
        revision: 3,
        handlers: [{ kind: "authenticator", path: "/verify", target: { by: "id", value: "app" } }],
      },
    ]);
    expect(failures).toEqual([]);
    expect(states).toBeGreaterThan(3000);
    for (const type of ["HANDLER", "REVISED"]) expect(types).toContain(type);
  },
);
