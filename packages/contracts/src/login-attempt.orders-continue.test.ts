import { expect, it } from "vitest";
import { click, fill, walk } from "./__fixtures__/login-orders";

// A recipe of its first page only, which ends with an advance (ADR 0018): a continued
// revision adds the password page after it, and another replaces the advance with the
// password field and the same button, for a button that stayed disabled while the password
// input opened (amendment of 2026-11-03).

it(
  "keeps an attempt's limits in every order of events: a continued recipe",
  { timeout: 120_000 },
  () => {
    const { states, types, failures } = walk(
      {
        id: "synthetic-continue",
        slots: ["username"],
        steps: [fill("username"), click("next", "advance")],
        maxSubmissions: 1,
        // A recipe that has signed in once has markers, and is no longer continued.
        completion: undefined,
      },
      { focused: true },
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
        {
          revision: 5,
          slots: ["username", "password"],
          steps: [fill("username"), fill("password"), click("next", "submit")],
          maxSubmissions: 1,
        },
      ],
    );
    expect(failures).toEqual([]);
    expect(states).toBeGreaterThan(5000);
    for (const type of ["CONTINUING", "UNCONTINUED", "CONTINUED"]) expect(types).toContain(type);
  },
);
