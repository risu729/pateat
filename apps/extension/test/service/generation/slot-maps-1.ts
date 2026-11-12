import { expect, it } from "vitest";
import { MAX_GENERATED_SLOT_MAPS } from "../../../src/service/generation";
import type { SlotMaps1Context } from "./context";

export function registerSlotMaps1(context: SlotMaps1Context) {
  const { connection, observation, offered, customSlots, mapped, recipeId, idOf, slotSetup } =
    context;

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
