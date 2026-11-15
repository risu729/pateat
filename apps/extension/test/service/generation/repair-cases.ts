import { expect, it } from "vitest";
import type { ServiceGenerationTestContext } from "./context";

export function registerRepairCases({
  connection,
  request,
  recipeChange,
  setup,
  repair,
}: Pick<
  ServiceGenerationTestContext,
  "connection" | "request" | "recipeChange" | "setup" | "repair"
>) {
  it("claims the repair under the revision it repairs, apart from the path's first page", async () => {
    const h = setup();
    // The page's first generation was sent minutes ago; its claim does not hold the repair.
    expect(await h.generation.generate(request)).toMatchObject({ outcome: "recipe" });
    expect(await h.generation.generate(repair)).toMatchObject({ outcome: "recipe" });
    expect(h.transport.generateRecipe).toHaveBeenLastCalledWith(
      connection.origin,
      connection.credential,
      repair,
    );
    expect(await h.generation.generate(repair)).toEqual({ outcome: "skipped", reason: "sent" });
    // A repair of the next revision is a new claim.
    expect(
      await h.generation.generate({
        ...repair,
        repair: { recipeId: recipeChange.recipeId, revision: 3 },
      }),
    ).toMatchObject({ outcome: "recipe" });
    expect(h.transport.generateRecipe).toHaveBeenCalledTimes(3);
  });
}
