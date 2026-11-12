import { expect, it, vi } from "vitest";
import { type ServiceTransport } from "../../../src/service/transport";
import type { Popup1Context } from "./context";

export function registerPopup1(context: Popup1Context) {
  const { observation, request, recipeChange, setup } = context;

  it("retries a sent first page while ordinary generation stays held", async () => {
    const h = setup();
    expect(await h.generation.generate(request)).toMatchObject({ outcome: "recipe" });
    expect(await h.generation.available(observation.origin, "/login")).toBe("sent");
    expect(
      await h.generation.available(observation.origin, "/login", undefined, undefined, true),
    ).toBe(true);
    expect(await h.generation.generate({ ...request, manual: true })).toMatchObject({
      outcome: "recipe",
    });
    expect(h.transport.generateRecipe).toHaveBeenCalledTimes(2);
    expect(h.transport.generateRecipe.mock.calls[1]![2]).toMatchObject({ manual: true });
    expect(await h.generation.generate(request)).toEqual({ outcome: "skipped", reason: "sent" });
  });

  it("does not bypass a generation call still sending", async () => {
    const h = setup();
    const answer = Promise.withResolvers<Awaited<ReturnType<ServiceTransport["generateRecipe"]>>>();
    h.transport.generateRecipe.mockReturnValue(answer.promise);
    const first = h.generation.generate(request);
    await vi.waitFor(() => expect(h.transport.generateRecipe).toHaveBeenCalledTimes(1));
    expect(
      await h.generation.available(observation.origin, "/login", undefined, undefined, true),
    ).toBe("sending");
    expect(await h.generation.generate({ ...request, manual: true })).toEqual({
      outcome: "skipped",
      reason: "sending",
      retry: true,
    });
    expect(h.transport.generateRecipe).toHaveBeenCalledTimes(1);
    answer.resolve({
      kind: "result",
      result: { version: 1, status: "recipe", change: recipeChange },
    });
    expect(await first).toMatchObject({ outcome: "recipe" });
  });
}
