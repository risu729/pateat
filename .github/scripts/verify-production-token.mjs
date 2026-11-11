import { resolve } from "node:path";

/* oxlint-disable no-await-in-loop -- Read the bounded response stream sequentially. */

const maxResponseBytes = 16 * 1024;
const identifier = /^[0-9a-f]{32}$/u;
const statuses = new Set(["active", "disabled", "expired"]);

async function boundedJson(response) {
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > maxResponseBytes)) {
    await response.body?.cancel();
    return null;
  }
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxResponseBytes) return null;
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks, bytes).toString("utf8"));
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}

export async function verifyProductionToken(
  { accountId, token },
  { fetcher = fetch, emit = (metadata) => console.log(JSON.stringify(metadata)) } = {},
) {
  const metadata = { http_status: null, error_codes: [] };
  let verified = false;
  try {
    if (
      typeof accountId !== "string" ||
      !identifier.test(accountId) ||
      typeof token !== "string" ||
      !token
    )
      return false;
    const response = await fetcher(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/tokens/verify`,
      {
        method: "GET",
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
        redirect: "error",
        signal: AbortSignal.timeout(10000),
      },
    );
    metadata.http_status = response.status;
    const body = await boundedJson(response);
    if (Array.isArray(body?.errors))
      metadata.error_codes = body.errors
        .map((error) => error?.code)
        .filter((code) => Number.isSafeInteger(code) && code >= 1000)
        .slice(0, 32);
    if (
      response.ok &&
      body?.success === true &&
      Array.isArray(body.errors) &&
      body.errors.length === 0 &&
      typeof body.result?.id === "string" &&
      identifier.test(body.result.id) &&
      statuses.has(body.result.status)
    ) {
      metadata.id = body.result.id;
      metadata.status = body.result.status;
      verified = body.result.status === "active";
    }
  } catch {
    // Do not surface response bodies, headers, messages, credentials or exception text.
  } finally {
    emit(metadata);
  }
  return verified;
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  const verified = await verifyProductionToken({
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
    token: process.env.CLOUDFLARE_API_TOKEN,
  });
  if (!verified) process.exitCode = 1;
}
