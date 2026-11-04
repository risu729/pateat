import { expect, it } from "vitest";
import { click, fill, walk } from "./__fixtures__/login-orders";

// An item without a password whose recipe ends with the advance to the password page
// (ADR 0036): the stop lies just past its plan, a continued revision adds that page, and
// the stop moves to the step there that fills the password (ADR 0018).

const noPassword = { password: false, totp: false, passkey: true, discoverablePasskey: true };

it(
  "keeps an attempt's limits in every order of events: a stop past the plan",
  { timeout: 120_000 },
  () => {
    const { states, types, failures } = walk(
      {
        id: "synthetic-stop-past",
        slots: ["username"],
        steps: [fill("username"), click("next", "advance")],
        maxSubmissions: 1,
        completion: undefined,
      },
      { facts: noPassword, stopAt: 2, focused: true },
      [
        {
          revision: 4,
          slots: ["username", "password"],
          steps: [
            fill("username"),
            click("next", "advance"),
            fill("password"),
            click("login", "submit"),
          ],
          maxSubmissions: 2,
        },
      ],
    );
    expect(failures).toEqual([]);
    expect(states).toBeGreaterThan(2000);
    for (const type of ["CONTINUED", "STOP_ANSWERED"]) expect(types).toContain(type);
  },
);
