import { expect, it } from "vitest";
import { MAX_GENERATED_SLOT_MAPS } from "../../../src/service/generation";
import type { ServiceGenerationTestContext } from "./context";

export function registerSlotMapCases({
  connection,
  observation,
  offered,
  customSlots,
  mapped,
  recipeId,
  idOf,
  slotSetup,
}: Pick<
  ServiceGenerationTestContext,
  | "connection"
  | "observation"
  | "offered"
  | "customSlots"
  | "mapped"
  | "recipeId"
  | "idOf"
  | "slotSetup"
>) {
  it("remembers the offered fields per recipe before reporting it", async () => {
    const h = slotSetup();
    expect(await h.generation.slotFields(recipeId)).toBeUndefined();
    expect(await h.generation.generate(offered)).toMatchObject({ outcome: "recipe" });
    expect(h.order).toEqual(["write", "sync"]);
    expect(h.stored()).toEqual({
      version: 1,
      maps: [
        { service: connection.origin, deviceId: connection.deviceId, recipeId, slots: mapped },
      ],
    });
    expect(await h.generation.slotFields(recipeId)).toEqual(mapped);
    // No value and no item reaches storage: only names, positions and counts.
    expect(JSON.stringify(h.stored())).not.toMatch(/item|value/iu);
  });

  it("answers only for the paired service, device and recipe", async () => {
    const h = slotSetup();
    await h.generation.generate(offered);
    expect(await h.generation.slotFields(idOf(7))).toBeUndefined();
    h.service.connection.mockResolvedValue({ ...connection, deviceId: "another-device" });
    expect(await h.generation.slotFields(recipeId)).toBeUndefined();
    h.service.connection.mockResolvedValue({ ...connection, origin: "https://other.example.com" });
    expect(await h.generation.slotFields(recipeId)).toBeUndefined();
    h.service.connection.mockResolvedValue(undefined);
    expect(await h.generation.slotFields(recipeId)).toBeUndefined();
    h.service.connection.mockResolvedValue(connection);
    expect(await h.generation.slotFields(recipeId)).toEqual(mapped);
  });

  it("reads maps another worker wrote and ignores a stored map for another device", async () => {
    const entry = (deviceId: string) => ({
      service: connection.origin,
      deviceId,
      recipeId,
      slots: mapped,
    });
    const h = slotSetup({ stored: { version: 1, maps: [entry("another-device")] } });
    expect(await h.generation.slotFields(recipeId)).toBeUndefined();
    const own = slotSetup({ stored: { version: 1, maps: [entry(connection.deviceId)] } });
    expect(await own.generation.slotFields(recipeId)).toEqual(mapped);
    // An unreadable record counts as no maps: a built-in slot is never a custom slot.
    const broken = slotSetup({
      stored: {
        version: 1,
        maps: [
          {
            ...entry(connection.deviceId),
            slots: [{ slot: "Password", field: { custom: "Branch number" } }],
          },
        ],
      },
    });
    expect(await broken.generation.slotFields(recipeId)).toBeUndefined();
  });

  it.each([
    ["an unknown request slot", [{ slot: "店番号", offered: "custom-9" }]],
    ["a built-in slot", [...customSlots, { slot: "secret-word", offered: "password" }]],
    ["no custom slot", []],
  ])("writes nothing for a mapping that names %s", async (_label, mapping) => {
    const h = slotSetup({ customSlots: mapping });
    expect(await h.generation.generate(offered)).toMatchObject({ outcome: "recipe" });
    expect(h.slotStorage.write).not.toHaveBeenCalled();
    expect(await h.generation.slotFields(recipeId)).toBeUndefined();
  });

  it("keeps nothing in memory that it could not write, and still reports the recipe", async () => {
    const h = slotSetup({ failWrite: true });
    expect(await h.generation.generate(offered)).toMatchObject({ outcome: "recipe" });
    expect(h.order).toEqual(["write", "sync"]);
    expect(await h.generation.slotFields(recipeId)).toBeUndefined();
  });

  it("keeps at most 200 recipes, replacing a recipe's map and dropping the oldest", async () => {
    const full = Array.from({ length: MAX_GENERATED_SLOT_MAPS }, (_, index) => ({
      service: connection.origin,
      deviceId: connection.deviceId,
      recipeId: idOf(index + 1),
      slots: [{ slot: "old-slot", field: { custom: "Old" } }],
    }));
    const h = slotSetup({ stored: { version: 1, maps: full } });
    expect(MAX_GENERATED_SLOT_MAPS).toBe(200);
    expect(await h.generation.slotFields(idOf(1))).toEqual(full[0]!.slots);
    await h.generation.generate(offered);
    const maps = (h.stored() as { maps: { recipeId: string }[] }).maps;
    expect(maps).toHaveLength(200);
    expect(maps[0]!.recipeId).toBe(idOf(2));
    expect(maps.at(-1)!.recipeId).toBe(recipeId);
    expect(await h.generation.slotFields(idOf(1))).toBeUndefined();
    expect(await h.generation.slotFields(idOf(2))).toEqual(full[1]!.slots);

    // A recipe generated again replaces its own map instead of adding one.
    const again = slotSetup({ stored: h.stored() });
    await again.generation.generate({
      ...offered,
      observation: { ...observation, path: "/other" },
    });
    await again.generation.generate(offered);
    const after = (again.stored() as { maps: { recipeId: string }[] }).maps;
    expect(after).toHaveLength(200);
    expect(after.filter((entry) => entry.recipeId === recipeId)).toHaveLength(1);
  });
}

export function registerSlotMapMergeCases({
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
}: Pick<
  ServiceGenerationTestContext,
  | "storedOf"
  | "route"
  | "offered"
  | "customSlots"
  | "mapped"
  | "recipeId"
  | "idOf"
  | "slotSetup"
  | "ownMap"
  | "continued"
  | "continuation"
>) {
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
