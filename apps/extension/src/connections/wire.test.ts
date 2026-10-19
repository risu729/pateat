import * as v from "valibot";
import { describe, expect, it } from "vitest";
import { setupBeginSchema } from "./wire";

function begin(email: string) {
  return {
    kind: "new",
    environment: { kind: "cloud", region: "us" },
    label: "Synthetic vault",
    email,
    password: "synthetic-password",
    enabled: true,
  };
}
describe("setup begin email", () => {
  it.each(["o'brien@example.test", "tom&jerry@example.test", "name@example.x"])(
    "accepts %s, which the official Bitwarden login accepts",
    (email) => {
      expect(v.is(setupBeginSchema, begin(email))).toBe(true);
    },
  );
  it.each(["first..last@example.test", "名前@example.test", " user@example.test"])(
    "refuses %j, which Angular's Validators.email refuses",
    (email) => {
      expect(v.is(setupBeginSchema, begin(email))).toBe(false);
    },
  );
});
