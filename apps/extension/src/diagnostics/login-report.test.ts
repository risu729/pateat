import { problemEntrySchema } from "@pateat/contracts";
import * as v from "valibot";
import { describe, expect, it, vi } from "vitest";
import type { LoginReport } from "../login/runtime/report";
import { problemLine } from "./log-format";
import { createLoginReporter } from "./login-report";

describe("a login's login.attempt line", () => {
  // As Qantas's login on 2026-11-18 at 11:17 UTC: its end said neither how it stopped nor
  // that the item's passkey signed it in.
  it("names the stop and the sign-in methods of a login that ended", () => {
    const log = vi.fn(async () => undefined);
    createLoginReporter({ log })({
      type: "attempt",
      tabId: 7,
      origin: "https://member.example",
      recipeId: "gen-0123",
      recipeRevision: 2,
      branch: "1794922960578",
      route: "password",
      variant: 0,
      state: "authenticated",
      stepIndex: 2,
      stepCount: 2,
      outcome: "authenticated",
      stop: "passkey-button",
      times: {
        totalMs: 9000,
        serviceMs: 0,
        networkMs: 0,
        personMs: 0,
        pageMs: 5000,
        otherMs: 4000,
      },
      methods: { route: "password", used: "passkey", held: "passkey.password" },
    } satisfies LoginReport);
    expect(log).toHaveBeenCalledWith(
      "login.attempt",
      expect.objectContaining({
        route: "password",
        stop: "passkey-button",
        used: "passkey",
        held: "passkey.password",
        why: undefined,
        totalMs: 9000,
      }),
      expect.anything(),
    );
  });

  // A service deployed before this build refuses a line with a field it does not know
  // (`problemEntrySchema`), and the server may deploy after the build reaches a device.
  it("keeps the methods on the device, so a failed login's line passes any service", () => {
    const line = problemLine({
      time: 1_795_000_000_000,
      level: "warn",
      event: "login.attempt",
      fields: {
        origin: "https://member.example",
        route: "password",
        state: "blocked",
        outcome: "challenge",
        stop: "passkey-button",
        used: "none",
        held: "passkey.password",
        why: "not-answered",
      },
    });
    expect(line?.fields).toEqual({
      origin: "https://member.example",
      route: "password",
      state: "blocked",
      outcome: "challenge",
      stop: "passkey-button",
    });
    expect(v.is(problemEntrySchema, { seq: 1, ...line })).toBe(true);
  });
});
