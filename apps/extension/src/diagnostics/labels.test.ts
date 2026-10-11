import { describe, expect, it } from "vitest";
import { age, installLabel, plural, serverLabel, syncSignIn } from "./labels";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

describe("diagnostics labels", () => {
  it("uses the singular noun only for one", () => {
    expect(plural(0, "recipe")).toBe("0 recipes");
    expect(plural(1, "recipe")).toBe("1 recipe");
    expect(plural(2, "granted site")).toBe("2 granted sites");
    expect(plural(1, "entry", "entries")).toBe("1 entry");
    expect(plural(5, "entry", "entries")).toBe("5 entries");
  });

  it("rounds an age down at the unit boundaries", () => {
    expect(age(-5 * MINUTE)).toBe("0 min");
    expect(age(59 * MINUTE + 59_999)).toBe("59 min");
    expect(age(HOUR)).toBe("1 h");
    expect(age(48 * HOUR - 1)).toBe("47 h");
    expect(age(48 * HOUR)).toBe("2 d");
  });

  it("names install types without trusting inherited keys", () => {
    expect(installLabel("development")).toBe("unpacked install");
    expect(installLabel("normal")).toBe("Web Store install");
    expect(installLabel("toString")).toBe("toString install");
    expect(installLabel("other")).toBe("other install");
  });

  it("keeps the raw session code beside each reworded state", () => {
    expect(syncSignIn("active")).toBe("sync sign-in active");
    expect(syncSignIn("none")).toBe("no sync sign-in (none)");
    expect(syncSignIn("unavailable")).toBe("sync sign-in unreadable (unavailable)");
  });

  it("labels a third-party server by the Bitwarden version it reports", () => {
    expect(serverLabel({ ok: true, version: "2026.9.2", kind: "third-party" })).toBe(
      "third-party server, compatible with Bitwarden 2026.9.2",
    );
  });
});
