import { startLoginFixture } from "../tests/extension/login-server.ts";

const fixture = await startLoginFixture(3847);
console.log(`Synthetic login fixtures: ${fixture.origin}/identity`);
console.log("Use the localhost-only probe build and the demo account. Press Ctrl+C to stop.");

let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await fixture.close();
}
process.once("SIGINT", () => void close());
process.once("SIGTERM", () => void close());
