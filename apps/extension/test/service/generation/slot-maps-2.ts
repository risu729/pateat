import { expect, it } from "vitest";
import type { SlotMaps2Context } from "./context";

export function registerSlotMaps2(context: SlotMaps2Context) {
  const {
    storedOf,
    route,
    offered,
    customSlots,
    mapped,
    recipeId,
    idOf,
    slotSetup,
    ownMap,
    continued,
    continuation,
  } = context;

  it("adds a continuation's slots to the map of the recipe it continues", async () => {
    const other = ownMap(idOf(5), [{ slot: "old-slot", field: { custom: "Old" } }]);
    const h = slotSetup({
      stored: { version: 1, maps: [ownMap(recipeId, [mapped[0]!]), other] },
      customSlots: [customSlots[1]!],
      change: continued,
    });
    expect(await h.generation.generate(continuation)).toMatchObject({ outcome: "recipe" });
    expect(await h.generation.slotFields(recipeId)).toEqual(mapped);
    expect(await h.generation.slotFields(idOf(5))).toEqual(other.slots);
    expect((h.stored() as { maps: unknown[] }).maps).toHaveLength(2);
  });

  it("adds a repair's slots beside those of the layouts it keeps (ADR 0041)", async () => {
    const h = slotSetup({
      stored: { version: 1, maps: [ownMap(recipeId, [mapped[0]!])] },
      customSlots: [customSlots[1]!],
      change: continued,
    });
    const repair = { ...offered, repair: { recipeId, revision: 1 } };
    expect(await h.generation.generate(repair)).toMatchObject({ outcome: "recipe" });
    expect(await h.generation.slotFields(recipeId)).toEqual(mapped);
  });

  it("keeps the slots of every password variant of the recipe it answers (ADR 0027)", async () => {
    const varied = {
      ...continued,
      recipe: storedOf({
        ...route,
        revision: 2,
        alternatives: [
          {
            slots: ["店番号", "暗証番号"],
            steps: [
              {
                kind: "fill" as const,
                path: "/login",
                effect: "prepare" as const,
                fields: [
                  { slot: "店番号", target: { by: "id" as const, value: "branch" } },
                  { slot: "暗証番号", target: { by: "id" as const, value: "pin" } },
                ],
              },
              {
                kind: "click" as const,
                path: "/login",
                target: { by: "id" as const, value: "login" },
                purpose: "submit" as const,
              },
            ],
          },
        ],
      }),
    };
    const h = slotSetup({
      stored: { version: 1, maps: [ownMap(recipeId, [mapped[0]!])] },
      customSlots: [customSlots[1]!],
      change: varied,
    });
    expect(await h.generation.generate(continuation)).toMatchObject({ outcome: "recipe" });
    // The branch slot belongs to an alternative, not to the recipe's own slots.
    expect(await h.generation.slotFields(recipeId)).toEqual(mapped);
  });

  it("keeps only the continued recipe's slots and no other device's map", async () => {
    const h = slotSetup({
      stored: {
        version: 1,
        maps: [
          ownMap(recipeId, [mapped[0]!, { slot: "dropped-slot", field: { custom: "Dropped" } }]),
        ],
      },
      customSlots: [customSlots[1]!],
      change: continued,
    });
    await h.generation.generate(continuation);
    expect(await h.generation.slotFields(recipeId)).toEqual(mapped);

    const elsewhere = slotSetup({
      stored: {
        version: 1,
        maps: [{ ...ownMap(recipeId, [mapped[0]!]), deviceId: "another-device" }],
      },
      customSlots: [customSlots[1]!],
      change: continued,
    });
    await elsewhere.generation.generate(continuation);
    expect(await elsewhere.generation.slotFields(recipeId)).toEqual([mapped[1]]);
  });

  it("replaces the map when the answer starts a new recipe", async () => {
    const h = slotSetup({
      stored: {
        version: 1,
        maps: [ownMap(recipeId, [{ slot: "old-slot", field: { custom: "Old" } }])],
      },
    });
    expect(await h.generation.generate(offered)).toMatchObject({ outcome: "recipe" });
    expect(await h.generation.slotFields(recipeId)).toEqual(mapped);
  });

  it("reads the maps again after a failed read instead of keeping none", async () => {
    const other = ownMap(idOf(5), [{ slot: "old-slot", field: { custom: "Old" } }]);
    const h = slotSetup({ stored: { version: 1, maps: [other] }, failReads: 1 });
    expect(await h.generation.slotFields(idOf(5))).toBeUndefined();
    expect(await h.generation.slotFields(idOf(5))).toEqual(other.slots);
    expect(h.slotStorage.read).toHaveBeenCalledTimes(2);
  });

  it("writes nothing when the maps cannot be read, so no other map is dropped", async () => {
    const other = ownMap(idOf(5), [{ slot: "old-slot", field: { custom: "Old" } }]);
    const h = slotSetup({ stored: { version: 1, maps: [other] }, failReads: 1 });
    expect(await h.generation.generate(offered)).toMatchObject({ outcome: "recipe" });
    expect(h.order).toEqual(["sync"]);
    expect(h.slotStorage.write).not.toHaveBeenCalled();
    expect(await h.generation.slotFields(idOf(5))).toEqual(other.slots);
    expect(await h.generation.slotFields(recipeId)).toBeUndefined();
  });

  it("replaces stored maps that do not parse, since no older format is kept", async () => {
    const h = slotSetup({ stored: { version: 0, maps: "synthetic" } });
    expect(await h.generation.generate(offered)).toMatchObject({ outcome: "recipe" });
    expect(h.stored()).toEqual({ version: 1, maps: [ownMap(recipeId, mapped)] });
  });
}
