import { expect, it } from "vitest";
import { exploreLogin, recipeOf } from "./__fixtures__/login-orders";

// One file per recipe, so the test workers walk them in parallel.

it("keeps an attempt's limits in every order of events: a fill that submits", () => {
  const { states, failures } = exploreLogin(
    recipeOf({
      id: "synthetic-input",
      slots: ["password"],
      steps: [
        {
          kind: "fill",
          effect: "submit",
          event: "input",
          path: "/login",
          fields: [{ slot: "password", target: { by: "id", value: "password" } }],
        },
      ],
      maxSubmissions: 1,
    }),
  );
  expect(failures).toEqual([]);
  // A guard against events that no longer reach most states, which would pass trivially.
  expect(states).toBeGreaterThan(4000);
});
