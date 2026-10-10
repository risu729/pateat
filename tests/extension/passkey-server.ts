import { createServer, type Server } from "node:http";

// Public WebAuthn Level 3 test-vector values used by the probe build's synthetic source.
const PROBE_CREDENTIAL_ID = "f91f391db4c9b2fde0ea70189cba3fb63f579ba6122b33ad94ff3ec330084be4";
const PROBE_PUBLIC_X = "afefa16f97ca9b2d23eb86ccb64098d20db90856062eb249c33a9b672f26df61";
const PROBE_PUBLIC_Y = "930a56b87a2fca66334b03458abf879717c12cc68ed73290af2e2664796b9220";
const hexToBase64Url = (hex: string) => Buffer.from(hex, "hex").toString("base64url");
const probe = {
  credentialId: hexToBase64Url(PROBE_CREDENTIAL_ID),
  x: hexToBase64Url(PROBE_PUBLIC_X),
  y: hexToBase64Url(PROBE_PUBLIC_Y),
};

/** Synthetic relying party for `http://localhost` passkey probes, automated and manual. */
export const passkeyPageHtml = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Synthetic passkey relying party</title><script>
const PROBE = ${JSON.stringify(probe)};
const b64u = (buffer) => btoa(String.fromCharCode(...new Uint8Array(buffer)))
  .replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
const fromHex = (hex) => Uint8Array.from(hex.match(/../g), (pair) => parseInt(pair, 16));
window.wrappedAtStart = navigator.credentials.get !== CredentialsContainer.prototype.get;
window.request = (spec) => {
  window.controller = new AbortController();
  document.getElementById('result').textContent = 'pending';
  const publicKey = { challenge: fromHex(spec.challenge), timeout: 5000 };
  if (spec.rpId) publicKey.rpId = spec.rpId;
  if (spec.userVerification) publicKey.userVerification = spec.userVerification;
  if (spec.allow) publicKey.allowCredentials = spec.allow.map((id) => ({ type: 'public-key', id: fromHex(id) }));
  return navigator.credentials.get({ publicKey, signal: window.controller.signal }).then((credential) => ({
    instance: credential instanceof PublicKeyCredential,
    responseInstance: credential.response instanceof AuthenticatorAssertionResponse,
    id: credential.id,
    rawId: b64u(credential.rawId),
    type: credential.type,
    attachment: credential.authenticatorAttachment,
    clientDataJSON: b64u(credential.response.clientDataJSON),
    authenticatorData: b64u(credential.response.authenticatorData),
    signature: b64u(credential.response.signature),
    userHandle: credential.response.userHandle && b64u(credential.response.userHandle),
    extensions: credential.getClientExtensionResults(),
    json: JSON.parse(JSON.stringify(credential)),
  }), (error) => ({ error: error === window.abortReason ? 'caller-reason' : error.name }))
    .then(async (result) => {
      document.getElementById('result').textContent = await describe(result);
      return result;
    });
};
// Manual runs: name the answering authenticator, its flags and whether the public probe key
// verifies the signature. Automated tests verify independently in Node.
const fromB64u = (value) => Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), (char) => char.charCodeAt(0));
function derToRaw(der) {
  const read = (offset) => {
    const length = der[offset + 1];
    let value = der.slice(offset + 2, offset + 2 + length);
    while (value.length > 32 && value[0] === 0) value = value.slice(1);
    const padded = new Uint8Array(32);
    padded.set(value, 32 - value.length);
    return [padded, offset + 2 + length];
  };
  const [r, next] = read(2);
  const [s] = read(next);
  return Uint8Array.from([...r, ...s]);
}
async function describe(result) {
  if (result.error) return 'error ' + result.error;
  const data = fromB64u(result.authenticatorData);
  const flags = '0x' + data[32].toString(16).padStart(2, '0');
  if (result.rawId !== PROBE.credentialId) return 'browser authenticator, flags ' + flags;
  const key = await crypto.subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', x: PROBE.x, y: PROBE.y }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', fromB64u(result.clientDataJSON)));
  const verified = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, derToRaw(fromB64u(result.signature)), Uint8Array.from([...data, ...hash]));
  return 'Pateat, flags ' + flags + ', signature ' + (verified ? 'verified' : 'INVALID');
}
</script></head><body><main><h1>Synthetic passkey relying party</h1>
<button id="sign-in" type="button">Sign in with a passkey</button>
<button id="sign-in-uv" type="button">Sign in requiring UV</button>
<p><a href="/?unattended">Request on page load</a> · <a href="/denied">Permissions Policy denies passkeys</a> · <a href="/">Reset</a></p>
<p>Wrapped at document start: <output id="wrapped"></output></p>
<p>Result: <output id="result" aria-live="polite">none</output></p></main><script>
document.getElementById('wrapped').textContent = String(window.wrappedAtStart);
const randomChallenge = () => Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) => byte.toString(16).padStart(2, '0')).join('');
document.getElementById('sign-in').addEventListener('click', () => {
  window.pending = window.request(window.nextSpec ?? { challenge: randomChallenge() });
});
document.getElementById('sign-in-uv').addEventListener('click', () => {
  window.pending = window.request({ challenge: randomChallenge(), userVerification: 'required' });
});
// A page-load request has no transient user activation.
if (location.search === '?unattended') window.pending = window.request({ challenge: '00'.repeat(32) });
</script></body></html>`;

export async function startPasskeyRelyingParty(
  port = 0,
): Promise<{ server: Server; origin: string; close(): Promise<void> }> {
  const server = createServer((request, response) => {
    const headers: Record<string, string> = { "content-type": "text/html; charset=utf-8" };
    if (request.url === "/denied") headers["permissions-policy"] = "publickey-credentials-get=()";
    response.writeHead(200, headers);
    response.end(passkeyPageHtml);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No relying-party port");
  return {
    server,
    // WebAuthn rejects IP-address origins, so pages are opened through localhost.
    origin: `http://localhost:${address.port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
