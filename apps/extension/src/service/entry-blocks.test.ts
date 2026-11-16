import type { LoginEntryRecipe, StoredLoginRecipe, SyncRecipeChange } from "@pateat/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  createEntryBlocks,
  MAX_ENTRY_BLOCKS,
  syncedBlocksAfter,
  type SyncedEntryBlock,
} from "./entry-blocks";
import type { ServiceConnection } from "./runtime";
import type { OutcomeResult } from "./transport";

// Synthetic recipes and service only; nothing leaves the test (ADR 0031, amended 2026-11-16).

const CONNECTION: ServiceConnection = {
  origin: "https://pateat.example.com",
  deviceId: "6f1d3c1e-5d0b-4a52-9d55-3d7a8f0e2b41",
  credential: `pateat_device_${"C".repeat(43)}`,
  rejected: false,
};
const OTHER: ServiceConnection = { ...CONNECTION, deviceId: "other-device" };

const entry = (id: string, revision: number): LoginEntryRecipe => ({
  version: 1,
  id,
  revision,
  origin: "https://www.art.example",
  entry: { path: "/en/", target: { by: "text", value: "Login" } },
});

function setup(
  options: {
    connection?: ServiceConnection | undefined;
    synced?: SyncedEntryBlock[];
    answer?: () => Promise<OutcomeResult>;
  } = {},
) {
  let stored: unknown;
  const storage = {
    read: vi.fn(async () => structuredClone(stored)),
    write: vi.fn(async (value: unknown) => {
      stored = structuredClone(value);
    }),
  };
  const state = { connection: "connection" in options ? options.connection : CONNECTION };
  const reportEntryBlock = vi.fn(
    options.answer ?? (async (): Promise<OutcomeResult> => ({ kind: "kept" })),
  );
  const blocks = createEntryBlocks({
    storage,
    service: { connection: async () => state.connection },
    transport: { reportEntryBlock },
    synced: async () => options.synced ?? [],
    now: () => Date.UTC(2026, 10, 16, 9, 0),
  });
  return { blocks, storage, state, reportEntryBlock, stored: () => stored };
}

describe("entry blocks", () => {
  it("sends a paired device's block to the service once, and holds it at once", async () => {
    const { blocks, reportEntryBlock, stored } = setup();
    expect(await blocks.block({ id: "art-entry", revision: 2 }, "sign-up")).toBe(true);
    expect(await blocks.blocked({ id: "art-entry", revision: 2 })).toBe(true);
    expect(await blocks.blocked({ id: "art-entry", revision: 3 })).toBe(false);
    await vi.waitFor(() => expect(stored()).toEqual([expect.objectContaining({ sent: true })]));
    expect(reportEntryBlock).toHaveBeenCalledExactlyOnceWith(
      CONNECTION.origin,
      CONNECTION.credential,
      "art-entry",
      { version: 1, revision: 2, reason: "sign-up" },
    );
    expect(stored()).toEqual([
      {
        recipeId: "art-entry",
        revision: 2,
        reason: "sign-up",
        blockedAt: "2026-11-16T09:00:00.000Z",
        service: { origin: CONNECTION.origin, deviceId: CONNECTION.deviceId },
        sent: true,
      },
    ]);
    await blocks.flush();
    expect(reportEntryBlock).toHaveBeenCalledOnce();
  });

  it("keeps a report the service could not take for the next flush", async () => {
    const answers: OutcomeResult[] = [{ kind: "failed", error: "unreachable" }, { kind: "kept" }];
    const { blocks, reportEntryBlock, stored } = setup({
      answer: async () => answers.shift()!,
    });
    await blocks.block({ id: "art-entry", revision: 2 }, "left-site");
    await vi.waitFor(() => expect(reportEntryBlock).toHaveBeenCalledOnce());
    await blocks.flush();
    expect(reportEntryBlock).toHaveBeenCalledTimes(2);
    expect(stored()).toEqual([expect.objectContaining({ sent: true })]);
  });

  it("holds a block the service sent for every device's recipe sync", async () => {
    const { blocks } = setup({
      synced: [{ recipeId: "art-entry", revision: 4, reason: "no-sign-in", blockedAt: 1 }],
    });
    expect(await blocks.blocked({ id: "art-entry", revision: 4 })).toBe(true);
    expect(await blocks.blocked({ id: "art-entry", revision: 5 })).toBe(false);
  });

  it("keeps an unpaired device's block for its own recipes and uploads it with them", async () => {
    const { blocks, state, reportEntryBlock, stored } = setup({ connection: undefined });
    await blocks.block({ id: "art-entry", revision: 3 }, "sign-up");
    expect(await blocks.blocked({ id: "art-entry", revision: 3 })).toBe(true);
    expect(reportEntryBlock).not.toHaveBeenCalled();
    // Once paired, it holds only for the recipe the upload wrote, at the service's revision.
    state.connection = CONNECTION;
    expect(await blocks.blocked({ id: "art-entry", revision: 3 })).toBe(false);
    await blocks.uploaded(entry("art-entry", 3), 1, CONNECTION);
    expect(await blocks.blocked({ id: "art-entry", revision: 1 })).toBe(true);
    await blocks.flush();
    expect(reportEntryBlock).toHaveBeenCalledExactlyOnceWith(
      CONNECTION.origin,
      CONNECTION.credential,
      "art-entry",
      { version: 1, revision: 1, reason: "sign-up" },
    );
    expect(stored()).toEqual([
      expect.objectContaining({ revision: 1, service: expect.any(Object), sent: true }),
    ]);
  });

  it("never applies or sends a block made under another pairing", async () => {
    const { blocks, state, reportEntryBlock } = setup({
      answer: async () => ({ kind: "rejected" }),
    });
    await blocks.block({ id: "art-entry", revision: 2 }, "sign-up");
    state.connection = OTHER;
    expect(await blocks.blocked({ id: "art-entry", revision: 2 })).toBe(false);
    reportEntryBlock.mockClear();
    await blocks.flush();
    expect(reportEntryBlock).not.toHaveBeenCalled();
  });

  it("keeps the synced and own blocks as the device's own when it disconnects", async () => {
    const { blocks, state } = setup();
    await blocks.block({ id: "own-entry", revision: 2 }, "left-site");
    await blocks.keep([{ recipeId: "art-entry", revision: 4, reason: "sign-up", blockedAt: 1 }]);
    state.connection = undefined;
    expect(await blocks.blocked({ id: "own-entry", revision: 2 })).toBe(true);
    expect(await blocks.blocked({ id: "art-entry", revision: 4 })).toBe(true);
  });

  it("replaces an older revision's block of the same recipe and keeps at most the newest", async () => {
    const { blocks, stored } = setup({ connection: undefined });
    await blocks.block({ id: "art-entry", revision: 1 }, "sign-up");
    await blocks.block({ id: "art-entry", revision: 2 }, "left-site");
    expect(stored()).toEqual([expect.objectContaining({ recipeId: "art-entry", revision: 2 })]);
    for (let index = 0; index < MAX_ENTRY_BLOCKS + 1; index += 1)
      // oxlint-disable-next-line no-await-in-loop -- in order, as presses come
      await blocks.block({ id: `entry-${index}`, revision: 1 }, "sign-up");
    expect(stored()).toHaveLength(MAX_ENTRY_BLOCKS);
    expect(await blocks.blocked({ id: "entry-0", revision: 1 })).toBe(false);
  });

  it("answers that a block could not be stored, and rejects a check that cannot read them", async () => {
    const { blocks, storage } = setup();
    storage.read.mockRejectedValue(new Error("storage unavailable"));
    expect(await blocks.block({ id: "art-entry", revision: 2 }, "sign-up")).toBe(false);
    await expect(blocks.blocked({ id: "art-entry", revision: 2 })).rejects.toThrow();
  });
});

describe("synced blocks after a page of changes", () => {
  const held = (...recipes: StoredLoginRecipe[]) =>
    new Map(recipes.map((recipe) => [recipe.id, recipe]));
  const active = (revision: number, block?: "sign-up" | "left-site"): SyncRecipeChange => ({
    recipeId: "art-entry",
    revision,
    state: "active",
    recipe: entry("art-entry", revision),
    ...(block ? { entryBlock: { reason: block, blockedAt: revision } } : {}),
  });

  it("takes the block of a revision held, also from a change of that same revision", () => {
    expect(
      syncedBlocksAfter(undefined, [active(2, "sign-up")], held(entry("art-entry", 2))),
    ).toEqual([{ recipeId: "art-entry", revision: 2, reason: "sign-up", blockedAt: 2 }]);
  });

  it("keeps the first block of a revision, and drops it with a newer revision or a removal", () => {
    const first = [
      { recipeId: "art-entry", revision: 2, reason: "sign-up" as const, blockedAt: 2 },
    ];
    expect(syncedBlocksAfter(first, [active(2, "left-site")], held(entry("art-entry", 2)))).toEqual(
      first,
    );
    expect(syncedBlocksAfter(first, [active(3)], held(entry("art-entry", 3)))).toBeUndefined();
    expect(
      syncedBlocksAfter(first, [{ recipeId: "art-entry", revision: 3, state: "revoked" }], held()),
    ).toBeUndefined();
  });
});
