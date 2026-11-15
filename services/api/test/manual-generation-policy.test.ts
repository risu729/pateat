import { describe, expect, it, vi } from "vitest";
import {
  attemptWindow,
  ATTEMPT_WINDOW_MS,
  repairWindow,
  utcDayStart,
} from "../../../packages/generation/src/generate/policy";
import type { GenerationBackend } from "@pateat/generation";

const key = {
  recipeId: "recipe",
  branch: "",
  origin: "https://login.example",
  path: "/login",
  baseRevision: 0,
};
const now = 2_000_000;
function backend() {
  return {
    attemptedSince: vi.fn(async () => true),
    recordAttempt: vi.fn(async () => undefined),
    repairedSince: vi.fn(async () => true),
    recordRepair: vi.fn(async () => undefined),
  };
}

describe("the explicit first-page retry gate", () => {
  it("bypasses only the automatic attempt cooldown and still records before sending", async () => {
    const b = backend();
    const head = vi.fn(async () => undefined);
    const automatic = attemptWindow(b as unknown as GenerationBackend, key, head);
    expect(await automatic.gate(now)).toBe("recently-tried");
    const manual = attemptWindow(b as unknown as GenerationBackend, key, head, true);
    expect(await manual.gate(now)).toBeUndefined();
    expect(head).toHaveBeenCalledTimes(2);
    expect(b.attemptedSince).toHaveBeenCalledTimes(1);
    await manual.beforeSend(now);
    expect(b.recordAttempt).toHaveBeenCalledExactlyOnceWith(key, now, now - ATTEMPT_WINDOW_MS);
  });

  it("rechecks the recipe head even for an explicit retry", async () => {
    const b = backend();
    const manual = attemptWindow(
      b as unknown as GenerationBackend,
      key,
      async () => "recipe-conflict",
      true,
    );
    expect(await manual.gate(now)).toBe("recipe-conflict");
    expect(b.attemptedSince).not.toHaveBeenCalled();
    expect(b.recordAttempt).not.toHaveBeenCalled();
  });

  it("keeps the daily repair gate and its accounting separate", async () => {
    const b = backend();
    const repair = repairWindow(
      b as unknown as GenerationBackend,
      { recipeId: "recipe", baseRevision: 1 },
      async () => undefined,
    );
    expect(await repair.gate(now)).toBe("repair-limit");
    expect(b.repairedSince).toHaveBeenCalledExactlyOnceWith("recipe", utcDayStart(now));
    await repair.beforeSend(now);
    expect(b.recordRepair).toHaveBeenCalledExactlyOnceWith("recipe", 1, now, utcDayStart(now));
  });
});
