import * as v from "valibot";
import { toBase64Url } from "./encoding";
import { INITIAL_PASSKEY_POLICY, type PasskeyPolicy } from "./policy";
import type { PasskeySource } from "./runtime";
import type { PasskeyCandidate } from "./select";
import { importAssertionKey, signAssertion } from "./signature";

/**
 * Synthetic source for the loopback probe build only. Its key is the public WebAuthn Level 3
 * ES256 test-vector key, never vault data. It answers only for `http://localhost` origins.
 */
// Pure so production builds, which import only the tree-shaken factory, drop the vector key.
export const PROBE_PASSKEY = /* @__PURE__ */ Object.freeze({
  rpId: "localhost",
  credentialPrivateKey: "6e68e7a58484a3264f66b77f5d6dc5bc36a47085b615c9727ab334e8c369c2ee",
  publicKeyX: "afefa16f97ca9b2d23eb86ccb64098d20db90856062eb249c33a9b672f26df61",
  publicKeyY: "930a56b87a2fca66334b03458abf879717c12cc68ed73290af2e2664796b9220",
  credentialId: "f91f391db4c9b2fde0ea70189cba3fb63f579ba6122b33ad94ff3ec330084be4",
  userHandle: "c3ludGhldGljLXBhc3NrZXktdXNlcg",
});

const delayMs = v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(30_000));
export const probeControlSchema = v.variant("type", [
  v.strictObject({
    version: v.literal(1),
    type: v.literal("passkey.probe.configure"),
    /** Offers the localhost test-vector key; other origins always go to `other`. */
    enabled: v.optional(v.boolean()),
    counter: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(0xff_ff_ff_ff))),
    discoverable: v.optional(v.boolean()),
    signDelayMs: v.optional(delayMs),
    timeoutMs: v.optional(v.pipe(delayMs, v.minValue(1))),
    presence: v.optional(v.picklist(["always", "activation"])),
    verification: v.optional(v.picklist(["always", "never"])),
  }),
  v.strictObject({ version: v.literal(1), type: v.literal("passkey.probe.status") }),
]);

const hex = (value: string) =>
  Uint8Array.from(value.match(/../gu) ?? [], (pair) => Number.parseInt(pair, 16));

/**
 * The probe build's source. `http://localhost` origins get the synthetic test-vector key; any
 * other origin the probe content scripts reach is answered by `other`, such as the vault source
 * over a synthetic Bitwarden account. `other` must not cancel vault work with the runtime's
 * signal, since host cancellation retires the whole session; the vault source ignores it.
 */
export function createProbePasskeySource<TOther extends PasskeyCandidate>(
  other?: PasskeySource<TOther>,
): {
  source: PasskeySource;
  /** Synthetic controls, accepted only from the probe build's own options page. */
  control(message: unknown): unknown;
  timeoutMs: () => number;
  policy: () => PasskeyPolicy;
} {
  let enabled = true;
  let counter = 0;
  let discoverable = true;
  let signDelayMs = 0;
  let timeoutMs = 10_000;
  let policy = INITIAL_PASSKEY_POLICY;
  let signatures = 0;
  let keyPromise: Promise<CryptoKey> | undefined;
  const key = () => {
    keyPromise ??= (async () => {
      const jwk = {
        kty: "EC",
        crv: "P-256",
        x: toBase64Url(hex(PROBE_PASSKEY.publicKeyX)),
        y: toBase64Url(hex(PROBE_PASSKEY.publicKeyY)),
        d: toBase64Url(hex(PROBE_PASSKEY.credentialPrivateKey)),
      };
      const extractable = await crypto.subtle.importKey(
        "jwk",
        jwk,
        { name: "ECDSA", namedCurve: "P-256" },
        true,
        ["sign"],
      );
      // Mirror the production path: sign only with a non-extractable PKCS #8 import.
      return importAssertionKey(
        new Uint8Array(await crypto.subtle.exportKey("pkcs8", extractable)),
      );
    })();
    return keyPromise;
  };
  const delay = (ms: number, signal: AbortSignal) =>
    new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, ms);
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          reject(signal.reason);
        },
        { once: true },
      );
    });
  const others = new WeakSet<PasskeyCandidate>();
  const source: PasskeySource = {
    async candidates(origin, rpId, signal) {
      if (new URL(origin).hostname !== PROBE_PASSKEY.rpId) {
        const found = await other?.candidates(origin, rpId, signal);
        for (const candidate of found?.candidates ?? []) others.add(candidate);
        return found;
      }
      if (!enabled) return undefined;
      const candidate: PasskeyCandidate = {
        credentialId: toBase64Url(hex(PROBE_PASSKEY.credentialId)),
        rpId: PROBE_PASSKEY.rpId,
        userHandle: PROBE_PASSKEY.userHandle,
        discoverable,
        counter,
      };
      return { candidates: [candidate], complete: true };
    },
    async sign(candidate, authenticatorData, clientDataHash, signal) {
      if (others.has(candidate)) {
        const signature = await other!.sign(
          candidate as TOther,
          authenticatorData,
          clientDataHash,
          signal,
        );
        signatures += 1;
        return signature;
      }
      if (signDelayMs > 0) await delay(signDelayMs, signal);
      const signature = await signAssertion(await key(), authenticatorData, clientDataHash);
      signatures += 1;
      return signature;
    },
  };
  return {
    source,
    timeoutMs: () => timeoutMs,
    policy: () => policy,
    control(message) {
      const parsed = v.safeParse(probeControlSchema, message);
      if (!parsed.success) return { ok: false };
      if (parsed.output.type === "passkey.probe.status") return { ok: true, signatures };
      enabled = parsed.output.enabled ?? true;
      counter = parsed.output.counter ?? 0;
      discoverable = parsed.output.discoverable ?? true;
      signDelayMs = parsed.output.signDelayMs ?? 0;
      timeoutMs = parsed.output.timeoutMs ?? 10_000;
      policy = Object.freeze({
        presence: parsed.output.presence ?? INITIAL_PASSKEY_POLICY.presence,
        verification: parsed.output.verification ?? INITIAL_PASSKEY_POLICY.verification,
      });
      return { ok: true, signatures };
    },
  };
}
