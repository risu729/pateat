import assert from "node:assert/strict";
import { appendFile } from "node:fs/promises";
import { setTimeout } from "node:timers/promises";

/* oxlint-disable no-await-in-loop -- Propagation retries must run sequentially. */

assert.match(
  process.env.DEPLOYMENT_ID ?? "",
  /^[0-9a-f-]{36}$/u,
  "The action must return a verified deployment ID",
);
assert.match(
  process.env.VERSION_ID ?? "",
  /^[0-9a-f-]{36}$/u,
  "The action must return a version ID",
);
// The new version can take more than ten seconds to reach every edge; one run saw the old
// revision for longer than six tries 2 seconds apart.
const attempts = 30;
let failure;
for (let attempt = 0; attempt < attempts; attempt += 1) {
  try {
    const response = await fetch(process.env.SERVER_HEALTH_URL, {
      redirect: "error",
      signal: AbortSignal.timeout(5000),
      headers: { "Cache-Control": "no-cache" },
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), {
      status: "ok",
      service: "pateat-api",
      revision: process.env.RELEASE_REVISION,
    });
    failure = undefined;
    break;
  } catch (error) {
    failure = error;
    if (attempt < attempts - 1) await setTimeout(2000);
  }
}
if (failure) throw failure;
await appendFile(
  process.env.GITHUB_STEP_SUMMARY,
  [
    "## Server release verified",
    `- Revision: ${process.env.RELEASE_REVISION}`,
    `- Version: ${process.env.VERSION_ID}`,
    `- Deployment: ${process.env.DEPLOYMENT_ID}`,
    "- Hosted health returned the expected revision.",
    "",
  ].join("\n"),
);
