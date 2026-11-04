import { expect, it } from "vitest";
import { click, fill, walk } from "./__fixtures__/login-orders";

// The passkey route (ADR 0034): a login that starts on it, answering the start page's own
// request and falling back to the password once, and a recipe with a passkey button.

const facts = { password: true, totp: false, passkey: true, discoverablePasskey: true };
const recipe = {
  id: "synthetic-routes",
  slots: ["username", "password"],
  steps: [fill("username", "password"), click("login", "submit")],
  maxSubmissions: 1,
};

it(
  "keeps an attempt's limits in every order of events: a login on the passkey route",
  { timeout: 120_000 },
  () => {
    const { states, types, failures } = walk(recipe, {
      choice: { route: "passkey" },
      fallback: 0,
      facts,
      routes: true,
      focused: true,
    });
    expect(failures).toEqual([]);
    expect(states).toBeGreaterThan(3000);
    expect(types).toContain("ROUTE");
  },
);

it(
  "keeps an attempt's limits in every order of events: a recipe with a passkey button",
  { timeout: 120_000 },
  () => {
    const { states, types, failures } = walk(
      { ...recipe, passkey: { path: "/login", target: { by: "id", value: "passkey" } } },
      { facts, routes: true, focused: true },
    );
    expect(failures).toEqual([]);
    expect(states).toBeGreaterThan(3000);
    expect(types).toContain("ROUTE");
  },
);
