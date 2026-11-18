import { expect, it } from "vitest";
import { click, fill, walk } from "./__fixtures__/login-orders";

// A passkey button that leads to a step asking for the account first (ADR 0060 amendment
// of 2026-11-18): after the button's click, the login runs that layout's identifier and
// Continue, and stops just past them, where the page's passkey request is answered.

const facts = { password: true, totp: false, passkey: true, discoverablePasskey: false };

it(
  "keeps an attempt's limits in every order of events: a passkey button's identifier step",
  { timeout: 120_000 },
  () => {
    const { states, types, failures } = walk(
      {
        id: "synthetic-button-layout",
        layout: "1760000000000",
        slots: ["username", "password"],
        steps: [fill("username", "password"), click("login", "submit")],
        passkey: { path: "/login", target: { by: "id", value: "passkey" } },
        maxSubmissions: 1,
      },
      { choice: { route: "passkey" }, facts, focused: true },
      [
        {
          layout: "1760000000001",
          slots: ["username"],
          steps: [fill("username"), click("continue", "advance")],
          passkey: undefined,
          completion: undefined,
          maxSubmissions: 1,
        },
      ],
    );
    expect(failures).toEqual([]);
    expect(states).toBeGreaterThan(7000);
    for (const type of ["IDENTIFIER_LAYOUT", "STOP_ANSWERED"]) expect(types).toContain(type);
  },
);
