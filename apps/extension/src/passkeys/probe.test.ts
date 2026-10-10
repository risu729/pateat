import { describe, expect, it, vi } from "vitest";
import { createProbePasskeySource } from "./probe";
import type { PasskeySource } from "./runtime";
import type { PasskeyCandidate } from "./select";

const vaultCandidate: PasskeyCandidate = {
  credentialId: "EjRWeBI0QjSCNBI0VniavA",
  rpId: "synthetic.example.test",
  userHandle: "c3ludGhldGljLXVzZXItaWQ",
  discoverable: true,
  counter: 0,
};
const data = new Uint8Array(37);
const hash = new Uint8Array(32);
const signal = new AbortController().signal;

function setup() {
  const sign = vi.fn<PasskeySource["sign"]>(async () => Uint8Array.of(1, 2, 3));
  const candidates = vi.fn<PasskeySource["candidates"]>(async () => ({
    candidates: [{ ...vaultCandidate }],
    complete: true,
  }));
  return { probe: createProbePasskeySource({ candidates, sign }), candidates, sign };
}

describe("probe passkey source", () => {
  it("answers localhost with the test-vector key and other origins from the other source", async () => {
    const { probe, candidates, sign } = setup();
    const local = await probe.source.candidates("http://localhost:3848", "localhost", signal);
    expect(local?.candidates).toMatchObject([{ rpId: "localhost" }]);
    expect(await probe.source.sign(local!.candidates[0]!, data, hash, signal)).not.toEqual(
      Uint8Array.of(1, 2, 3),
    );
    expect(candidates).not.toHaveBeenCalled();
    expect(sign).not.toHaveBeenCalled();

    const found = await probe.source.candidates(
      "https://synthetic.example.test",
      "synthetic.example.test",
      signal,
    );
    expect(candidates).toHaveBeenCalledWith(
      "https://synthetic.example.test",
      "synthetic.example.test",
      signal,
    );
    expect(await probe.source.sign(found!.candidates[0]!, data, hash, signal)).toEqual(
      Uint8Array.of(1, 2, 3),
    );
    expect(sign).toHaveBeenCalledWith(found!.candidates[0], data, hash, signal);
    // An equal-looking candidate the other source did not return is signed with the vector key.
    await probe.source.sign({ ...found!.candidates[0]! }, data, hash, signal);
    expect(sign).toHaveBeenCalledTimes(1);
    expect(probe.control({ version: 1, type: "passkey.probe.status" })).toEqual({
      ok: true,
      signatures: 3,
    });
  });

  it("turns off only the localhost key", async () => {
    const { probe } = setup();
    probe.control({ version: 1, type: "passkey.probe.configure", enabled: false });
    expect(
      await probe.source.candidates("http://localhost:3848", "localhost", signal),
    ).toBeUndefined();
    expect(
      await probe.source.candidates(
        "https://synthetic.example.test",
        "synthetic.example.test",
        signal,
      ),
    ).toMatchObject({ candidates: [{ rpId: "synthetic.example.test" }] });
  });
});
