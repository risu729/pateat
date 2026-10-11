import { webcrypto } from "node:crypto";

// Prints a new OIDC_SIGNING_KEYS value with one ES256 key (ADR 0015). The output holds
// a private key: send it straight to the Worker secret and do not save or log it.
// To rotate, add the new key to the existing `keys`, publish for at least 15 minutes,
// then switch `signingKeyId`; drop the old key once its assertions have expired.

const kid = process.argv[2] || new Date().toISOString().slice(0, 10);
if (!/^[A-Za-z0-9._-]{1,64}$/.test(kid)) {
  console.error("The key ID must be 1-64 letters, digits, dots, underscores or hyphens.");
  process.exit(1);
}
const pair = await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
  "sign",
  "verify",
]);
const { kty, crv, x, y, d } = await webcrypto.subtle.exportKey("jwk", pair.privateKey);
process.stdout.write(
  `${JSON.stringify({ signingKeyId: kid, keys: [{ kty, crv, alg: "ES256", kid, x, y, d }] })}\n`,
);
