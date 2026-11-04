import { describe, expect, it } from "vitest";
import { click, fill, walk } from "./__fixtures__/login-orders";

// Logins that start apart from a plain one: on a chooser's list (ADR 0028), only filling
// while the tab asks for an account (ADR 0021 D), in a frame (ADR 0022), and after an
// account switch.

const recipe = {
  id: "synthetic-starts",
  slots: ["username", "password"],
  steps: [fill("username"), click("next", "advance"), fill("password"), click("login", "submit")],
  maxSubmissions: 2,
};

describe("keeps an attempt's limits in every order of events", () => {
  it("on a chooser's list", { timeout: 120_000 }, () => {
    const { states, types, failures } = walk(recipe, { chooser: "entry", focused: true });
    expect(failures).toEqual([]);
    expect(states).toBeGreaterThan(3000);
    expect(types).toContain("NOT_LISTED");
  });

  it("only filling", { timeout: 120_000 }, () => {
    const { states, failures } = walk(recipe, { fillOnly: true, focused: true });
    expect(failures).toEqual([]);
    expect(states).toBeGreaterThan(50);
  });

  it("in a frame", { timeout: 120_000 }, () => {
    const { states, failures } = walk(recipe, { frame: true, focused: true });
    expect(failures).toEqual([]);
    expect(states).toBeGreaterThan(1000);
  });

  it("after an account switch", { timeout: 120_000 }, () => {
    const { states, types, failures } = walk(recipe, { accountSwitched: true, focused: true });
    expect(failures).toEqual([]);
    expect(states).toBeGreaterThan(3000);
    expect(types).toContain("WRONG_ACCOUNT");
  });
});
