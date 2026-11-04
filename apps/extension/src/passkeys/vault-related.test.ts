import { describe, expect, it, vi } from "vitest";
import type { PasskeySource } from "./runtime";
import { itemPasskeyFacts } from "./vault";

const first = "44444444-4444-4444-8444-444444444444";
const origin = "https://github.com";
const only = { connectionId: "live", itemId: first };
/** A stored passkey the vault search found for the login's item. */
const stored = (itemId: string) => ({
  connectionId: "live",
  userId: "33333333-3333-4333-8333-333333333333",
  snapshotId: "11111111-1111-4111-8111-111111111111",
  itemId,
  credentialId: `cred-${itemId.slice(0, 4)}`,
  rpId: "github.com",
  userHandle: "dXNlcg",
  discoverable: true,
  counter: 0,
  userName: "synthetic-user",
});

describe("a login item's passkeys of related origins (ADR 0084)", () => {
  it("counts the item's passkey of a related RP ID that lists the origin (ADR 0084)", async () => {
    // ChatGPT's passkeys belong to openai.com, whose list names https://chatgpt.com.
    const candidates = vi.fn<PasskeySource["candidates"]>(async (_origin, candidateRpId) => ({
      complete: true,
      candidates:
        candidateRpId === "openai.com"
          ? [{ ...stored(first), rpId: "openai.com", discoverable: false, userHandle: null }]
          : [],
    }));
    const rpIds = vi.fn<NonNullable<PasskeySource["rpIds"]>>(async () => [
      "chatgpt.com",
      "openai.com",
      "auth.openai.com",
      "example.net",
    ]);
    const allows = vi.fn(
      async (_origin: string, related: string) =>
        related === "openai.com" || related === "auth.openai.com",
    );
    const account = { origin: "https://chatgpt.com", ...only };
    // Without the related origins check, only the page's own RP ID is searched.
    expect(await itemPasskeyFacts({ candidates, rpIds }, account)).toEqual({
      passkey: false,
      discoverable: false,
    });
    expect(rpIds).not.toHaveBeenCalled();
    candidates.mockClear();
    expect(await itemPasskeyFacts({ candidates, rpIds }, account, { allows })).toEqual({
      passkey: true,
      discoverable: false,
    });
    expect(rpIds).toHaveBeenCalledWith(only);
    // The page's own RP ID is not asked about; each other one is, and only listed ones are
    // searched, for the login's item only.
    expect(allows.mock.calls.map(([, related]) => related)).toEqual([
      "openai.com",
      "auth.openai.com",
      "example.net",
    ]);
    for (const call of allows.mock.calls) expect(call[0]).toBe("https://chatgpt.com");
    expect(candidates.mock.calls.map(([, searched]) => searched)).toEqual([
      "chatgpt.com",
      "openai.com",
      "auth.openai.com",
    ]);
    for (const call of candidates.mock.calls) expect(call[3]).toEqual(only);
  });

  it("asks about related RP IDs only without a discoverable passkey of the origin's own", async () => {
    const candidates = vi.fn<PasskeySource["candidates"]>(async () => ({
      complete: true,
      candidates: [stored(first)],
    }));
    const rpIds = vi.fn<NonNullable<PasskeySource["rpIds"]>>(async () => ["example.net"]);
    const allows = vi.fn(async () => true);
    expect(await itemPasskeyFacts({ candidates, rpIds }, { origin, ...only }, { allows })).toEqual({
      passkey: true,
      discoverable: true,
    });
    expect(rpIds).not.toHaveBeenCalled();
    expect(allows).not.toHaveBeenCalled();
    // RP IDs that cannot be read, or a list that cannot, count as none.
    candidates.mockResolvedValue({ complete: true, candidates: [] });
    rpIds.mockRejectedValueOnce(new Error("locked"));
    expect(await itemPasskeyFacts({ candidates, rpIds }, { origin, ...only }, { allows })).toEqual({
      passkey: false,
      discoverable: false,
    });
    allows.mockRejectedValueOnce(new Error("offline"));
    expect(await itemPasskeyFacts({ candidates, rpIds }, { origin, ...only }, { allows })).toEqual({
      passkey: false,
      discoverable: false,
    });
  });
});
