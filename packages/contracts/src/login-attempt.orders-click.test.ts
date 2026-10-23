import { expect, it } from "vitest";
import { exploreLogin, recipeOf } from "./__fixtures__/login-orders";

// One file per recipe, so the test workers walk them in parallel. Each walk takes seconds,
// so CI runs these files in their own job (`test:orders`).

it(
  "keeps an attempt's limits in every order of events: a fill, then a click",
  { timeout: 60_000 },
  () => {
    const { states, failures } = exploreLogin(
      recipeOf({
        id: "synthetic-click",
        slots: ["username", "password"],
        steps: [
          {
            kind: "fill",
            effect: "prepare",
            path: "/login",
            fields: [
              { slot: "username", target: { by: "id", value: "username" } },
              { slot: "password", target: { by: "id", value: "password" } },
            ],
          },
          {
            kind: "click",
            path: "/login",
            target: { by: "id", value: "login" },
            purpose: "submit",
          },
        ],
        maxSubmissions: 2,
      }),
    );
    expect(failures).toEqual([]);
    // A guard against events that no longer reach most states, which would pass trivially.
    expect(states).toBeGreaterThan(3500);
  },
);
