import { expect, it } from "vitest";
import { click, fill, walk } from "./__fixtures__/login-orders";

// A recipe of two layouts (ADR 0060): the login runs one, and switches to the other where
// that one's step shows on the page instead.

it(
  "keeps an attempt's limits in every order of events: another layout",
  { timeout: 120_000 },
  () => {
    const { states, types, failures } = walk(
      {
        id: "synthetic-layout",
        layout: "1760000000000",
        slots: ["username", "password"],
        steps: [
          fill("username"),
          click("next", "advance"),
          fill("password"),
          click("login", "submit"),
        ],
        maxSubmissions: 2,
      },
      { focused: true },
      [
        {
          layout: "1760000000001",
          revision: 3,
          steps: [
            fill("username"),
            click("next", "advance"),
            fill("password"),
            click("sign-in", "submit"),
          ],
          maxSubmissions: 2,
        },
      ],
    );
    expect(failures).toEqual([]);
    expect(states).toBeGreaterThan(3000);
    expect(types).toContain("LAYOUT");
  },
);
