import { startPasskeyRelyingParty } from "../tests/extension/passkey-server.ts";

const fixture = await startPasskeyRelyingParty(3848);
console.log(`Synthetic passkey relying party: ${fixture.origin}/`);
console.log("Use the localhost-only probe build. Press Ctrl+C to stop.");

let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await fixture.close();
}
process.once("SIGINT", () => void close());
process.once("SIGTERM", () => void close());
