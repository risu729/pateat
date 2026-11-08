import { describe, expect, it } from "vitest";
import { loginReadiness } from "./readiness";

const target = (value: string) => ({ by: "data-test" as const, value });

describe("loginReadiness (issue #1413)", () => {
  it("names the username and password targets, never a code's or another slot's", () => {
    expect(
      loginReadiness({
        kind: "fill",
        effect: "prepare",
        path: "/login",
        fields: [
          { slot: "username", target: target("email") },
          { slot: "password", target: target("password") },
          { slot: "branch", target: target("branch") },
        ],
      }),
    ).toEqual({
      path: "/login",
      require: "writable",
      targets: [target("email"), target("password"), target("branch")],
      signIn: [target("email"), target("password")],
    });
    expect(
      loginReadiness({
        kind: "fill",
        effect: "prepare",
        path: "/login",
        fields: [{ slot: "totp", target: target("code") }],
      }),
    ).toEqual({ path: "/login", require: "writable", targets: [target("code")] });
  });
});
