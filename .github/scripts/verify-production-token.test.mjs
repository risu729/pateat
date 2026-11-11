import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { verifyProductionToken } from "./verify-production-token.mjs";

const accountId = "a".repeat(32);
const id = "b".repeat(32);
const sentinel = "synthetic-private-sentinel";
const credentials = { accountId, token: sentinel };
const active = { success: true, errors: [], result: { id, status: "active" } };
const maxBytes = 16 * 1024;

async function verify(response, input = credentials) {
  const requests = [];
  const logs = [];
  const verified = await verifyProductionToken(input, {
    fetcher: (...args) => {
      requests.push(args);
      if (response instanceof Error) throw response;
      return response;
    },
    emit: (metadata) => logs.push(metadata),
  });
  assert.equal(logs.length, 1);
  assert(!JSON.stringify(logs).includes(sentinel));
  return { verified, requests, metadata: logs[0] };
}

function streamed(chunks, headers = {}) {
  let reads = 0;
  let cancelled = false;
  const body = new ReadableStream(
    {
      pull(controller) {
        if (reads < chunks.length) controller.enqueue(chunks[reads++]);
        else controller.close();
      },
      cancel() {
        cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  return {
    response: new Response(body, { headers }),
    reads: () => reads,
    cancelled: () => cancelled,
  };
}

test("an active identity makes exactly one bounded read-only request", async (t) => {
  const controller = new AbortController();
  const timeout = t.mock.method(AbortSignal, "timeout", (milliseconds) => {
    assert.equal(milliseconds, 10000);
    return controller.signal;
  });
  const result = await verify(Response.json(active));
  assert.equal(result.verified, true);
  assert.deepEqual(result.metadata, { http_status: 200, error_codes: [], id, status: "active" });
  assert.deepEqual(result.requests, [
    [
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/tokens/verify`,
      {
        method: "GET",
        headers: { Authorization: `Bearer ${sentinel}`, Accept: "application/json" },
        redirect: "error",
        signal: controller.signal,
      },
    ],
  ]);
  assert.equal(timeout.mock.callCount(), 1);
});

for (const status of ["disabled", "expired"]) {
  test(`${status} identities are reported but stop the release`, async () => {
    const result = await verify(Response.json({ ...active, result: { id, status } }));
    assert.equal(result.verified, false);
    assert.deepEqual(result.metadata, { http_status: 200, error_codes: [], id, status });
  });
}

for (const [name, body] of [
  ["missing success", { errors: [], result: active.result }],
  ["false success", { ...active, success: false }],
  ["string success", { ...active, success: "true" }],
  ["missing errors", { success: true, result: active.result }],
  ["object errors", { ...active, errors: {} }],
  ["nonempty errors", { ...active, errors: [{ message: sentinel }] }],
  ["missing result", { success: true, errors: [] }],
  ["null result", { ...active, result: null }],
  ["short ID", { ...active, result: { id: "abc", status: "active" } }],
  ["uppercase ID", { ...active, result: { id: id.toUpperCase(), status: "active" } }],
  ["numeric ID", { ...active, result: { id: 123, status: "active" } }],
  ["array ID", { ...active, result: { id: [id], status: "active" } }],
  ["newline ID", { ...active, result: { id: `${id}\n`, status: "active" } }],
  ["unknown status", { ...active, result: { id, status: sentinel } }],
  ["missing status", { ...active, result: { id } }],
  ["array status", { ...active, result: { id, status: ["active"] } }],
  ["null envelope", null],
]) {
  test(`${name} cannot establish an identity`, async () => {
    const result = await verify(Response.json(body));
    assert.equal(result.verified, false);
    assert.deepEqual(result.metadata, { http_status: 200, error_codes: [] });
  });
}

test("HTTP failure reports only bounded numeric codes, even with a success-shaped result", async () => {
  const validCodes = Array.from({ length: 40 }, (_, index) => 10000 + index);
  const errors = [
    null,
    {},
    { code: "10084" },
    { code: -1 },
    { code: 999 },
    { code: 1000.5 },
    { code: Number.MAX_SAFE_INTEGER + 1 },
    ...validCodes.map((code) => ({ code, message: sentinel })),
  ];
  const result = await verify(
    Response.json(
      { ...active, errors, messages: [sentinel], token: sentinel },
      { status: 403, headers: { "x-private": sentinel } },
    ),
  );
  assert.equal(result.verified, false);
  assert.deepEqual(result.metadata, { http_status: 403, error_codes: validCodes.slice(0, 32) });
});

test("HTTP failure cannot accept an otherwise active identity", async () => {
  const result = await verify(Response.json(active, { status: 503 }));
  assert.equal(result.verified, false);
  assert.deepEqual(result.metadata, { http_status: 503, error_codes: [] });
});

test("success never emits extra response fields or credential-shaped messages", async () => {
  const result = await verify(
    Response.json(
      {
        ...active,
        messages: [sentinel],
        result: { ...active.result, value: sentinel, policies: [sentinel] },
      },
      { headers: { "x-private": sentinel } },
    ),
  );
  assert.equal(result.verified, true);
  assert.deepEqual(result.metadata, { http_status: 200, error_codes: [], id, status: "active" });
});

for (const [name, response, httpStatus] of [
  ["network exception", new Error(sentinel), null],
  ["malformed JSON", new Response(sentinel), 200],
  ["empty body", new Response(null), 200],
  ["redirect response", new Response(null, { status: 302, headers: { location: sentinel } }), 302],
]) {
  test(`${name} fails without exposing details`, async () => {
    const result = await verify(response);
    assert.equal(result.verified, false);
    assert.deepEqual(result.metadata, { http_status: httpStatus, error_codes: [] });
  });
}

test("stream read failures do not expose exception text", async () => {
  const body = new ReadableStream({
    start(controller) {
      controller.error(new Error(sentinel));
    },
  });
  const result = await verify(new Response(body));
  assert.equal(result.verified, false);
  assert.deepEqual(result.metadata, { http_status: 200, error_codes: [] });
});

test("the request timeout also stops a pending body read", async (t) => {
  const controller = new AbortController();
  t.mock.method(AbortSignal, "timeout", () => controller.signal);
  const logs = [];
  const verified = await verifyProductionToken(credentials, {
    fetcher: (_url, { signal }) =>
      new Response(
        new ReadableStream({
          start(stream) {
            signal.addEventListener("abort", () => stream.error(new Error(sentinel)), {
              once: true,
            });
            queueMicrotask(() => controller.abort());
          },
        }),
      ),
    emit: (metadata) => logs.push(metadata),
  });
  assert.equal(verified, false);
  assert.deepEqual(logs, [{ http_status: 200, error_codes: [] }]);
});

for (const declared of [String(maxBytes + 1), "-1", "invalid", "1.5"]) {
  test(`refuses declared content length ${declared} before consuming bytes`, async () => {
    const stream = streamed([Buffer.from(JSON.stringify(active))], { "content-length": declared });
    const result = await verify(stream.response);
    assert.equal(result.verified, false);
    assert.equal(stream.reads(), 0);
    assert.equal(stream.cancelled(), true);
  });
}

test("accepts valid chunked UTF-8 JSON at the exact byte limit", async () => {
  const body = Buffer.from(JSON.stringify({ ...active, message: "合成" }));
  const bytes = Buffer.concat([body, Buffer.alloc(maxBytes - body.length, " ")]);
  const split = bytes.indexOf(Buffer.from("合成")) + 1;
  const stream = streamed([
    bytes.subarray(0, split),
    bytes.subarray(split, split + 2),
    bytes.subarray(split + 2),
  ]);
  const result = await verify(stream.response);
  assert.equal(result.verified, true);
  assert.equal(stream.reads(), 3);
});

for (const headers of [{}, { "content-length": "1" }]) {
  test(`rejects oversized chunked body with ${Object.keys(headers).length ? "false" : "no"} length header`, async () => {
    const stream = streamed(
      [Buffer.alloc(maxBytes), Buffer.from(" "), Buffer.from(sentinel)],
      headers,
    );
    const result = await verify(stream.response);
    assert.equal(result.verified, false);
    assert.deepEqual(result.metadata, { http_status: 200, error_codes: [] });
    assert.equal(stream.reads(), 2);
    assert.equal(stream.cancelled(), true);
  });
}

for (const [name, input] of [
  ["missing account", { token: sentinel }],
  ["invalid account", { ...credentials, accountId: sentinel }],
  ["uppercase account", { ...credentials, accountId: accountId.toUpperCase() }],
  ["array account", { ...credentials, accountId: [accountId] }],
  ["newline account", { ...credentials, accountId: `${accountId}\n` }],
  ["missing token", { accountId }],
  ["empty token", { ...credentials, token: "" }],
  ["non-string token", { ...credentials, token: 123 }],
]) {
  test(`${name} makes no request`, async () => {
    const result = await verify(Response.json(active), input);
    assert.equal(result.verified, false);
    assert.deepEqual(result.requests, []);
    assert.deepEqual(result.metadata, { http_status: null, error_codes: [] });
  });
}

test("CLI exits unsuccessfully and prints only metadata for invalid configuration", () => {
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(new URL("verify-production-token.mjs", import.meta.url))],
    {
      encoding: "utf8",
      env: { CLOUDFLARE_ACCOUNT_ID: "invalid", CLOUDFLARE_API_TOKEN: sentinel },
    },
  );
  assert.equal(result.status, 1);
  assert.equal(result.stderr, "");
  assert.deepEqual(JSON.parse(result.stdout), { http_status: null, error_codes: [] });
});

test("production verification uses the deployment secret and blocks all release mutations", async () => {
  const workflow = await readFile(new URL("../workflows/ci.yml", import.meta.url), "utf8");
  const steps = workflow.split(/^      - /mu);
  const guard = steps.findIndex((step) =>
    step.includes("node .github/scripts/verify-production-token.mjs"),
  );
  assert(guard >= 0);
  assert.match(steps[guard], /if: \$\{\{ steps\.source\.outputs\.release == 'true' \}\}/u);
  assert.match(steps[guard], /CLOUDFLARE_API_TOKEN: \$\{\{ secrets\.CLOUDFLARE_API_TOKEN \}\}/u);
  assert.match(steps[guard], /timeout-minutes: 1/u);
  assert.doesNotMatch(steps[guard], /continue-on-error|always\(|\|\| true/u);
  for (const name of ["Apply the released migrations", "Activate the exact prebuilt server"]) {
    const mutations = steps
      .map((step, index) => (step.startsWith(`name: ${name}`) ? index : -1))
      .filter((index) => index >= 0);
    assert(mutations.length > 0);
    for (const index of mutations) {
      assert(guard < index);
      assert.doesNotMatch(steps[index], /always\(|failure\(/u);
      assert(steps[index].includes("secrets.CLOUDFLARE_API_TOKEN"));
    }
  }
});
