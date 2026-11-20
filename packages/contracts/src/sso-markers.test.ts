import * as v from "valibot";
import { describe, expect, it } from "vitest";
import { loginSsoRoutesSchema } from "./login/document-schema";

// An SSO layout's RP-return markers may be learned on another origin of the RP's site, as a
// broker's portal (ADR 0026, amendment of 2026-11-20).
const routes = (completion: unknown[]) => ({
  path: "/signin",
  layouts: [
    {
      key: "1000",
      createdAt: 1000,
      entries: [{ label: "Synthetic provider", target: { by: "id", value: "provider" } }],
      completion,
    },
  ],
});
const menu = { by: "id", value: "account-menu" };
const portal = "https://portal.example.test";

describe("an SSO layout's markers of another origin", () => {
  it("keeps a marker's origin, and one target on two origins as two markers", () => {
    const parsed = v.parse(
      loginSsoRoutesSchema,
      routes([{ target: menu }, { target: menu, origin: portal }]),
    );
    expect(parsed.layouts[0]!.completion).toEqual([
      { target: menu },
      { target: menu, origin: portal },
    ]);
  });
  it("refuses one target twice on one origin", () => {
    expect(
      v.safeParse(
        loginSsoRoutesSchema,
        routes([
          { target: menu, origin: portal },
          { target: menu, origin: portal },
        ]),
      ).success,
    ).toBe(false);
  });
});
