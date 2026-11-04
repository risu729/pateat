import { expect, it } from "vitest";
import { click, fill, walk } from "./__fixtures__/login-orders";

// A TOTP code the route itself fills (ADR 0027), whose input may submit at its last digit
// before its click; and the same page while the tab asks for an account (ADR 0021 D),
// whose login fills only the fields before the code.

const facts = { password: true, totp: true, passkey: false, discoverablePasskey: false };
const recipe = {
  id: "synthetic-code",
  slots: ["username", "password", "totp"],
  steps: [fill("username", "password"), fill("totp"), click("login", "submit")],
  maxSubmissions: 1,
};

it(
  "keeps an attempt's limits in every order of events: a code the page may submit",
  { timeout: 120_000 },
  () => {
    const { states, types, failures } = walk(recipe, { facts, focused: true });
    expect(failures).toEqual([]);
    // A guard against events that no longer reach most states, which would pass trivially.
    expect(states).toBeGreaterThan(2000);
    expect(types).toContain("AUTO_SUBMITTED");
  },
);

it(
  "keeps an attempt's limits in every order of events: only filling before a code",
  { timeout: 120_000 },
  () => {
    const { states, types, failures } = walk(recipe, { facts, fillOnly: true });
    expect(failures).toEqual([]);
    expect(states).toBeGreaterThan(2200);
    expect(types).not.toContain("AUTO_SUBMITTED");
  },
);
