import { expect, it } from "vitest";
import { click, fill, walk } from "./__fixtures__/login-orders";

// One file per recipe, so the test workers walk them in parallel. Each walk takes seconds,
// so CI runs these files in their own job (`test:orders`).

it(
  "keeps an attempt's limits in every order of events: a fill, then a click",
  { timeout: 120_000 },
  () => {
    const { states, types, failures } = walk({
      id: "synthetic-click",
      slots: ["username", "password"],
      steps: [fill("username", "password"), click("login", "submit")],
      maxSubmissions: 2,
    });
    expect(failures).toEqual([]);
    // A guard against events that no longer reach most states, which would pass trivially.
    expect(states).toBeGreaterThan(9000);
    for (const type of ["WRONG_ACCOUNT", "VALUE_REJECTED", "POLICY_REVISED", "WATCH_ENDED"])
      expect(types).toContain(type);
  },
);
