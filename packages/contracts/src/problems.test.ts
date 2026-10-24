import * as v from "valibot";
import { describe, expect, it } from "vitest";
import {
  LOCAL_ONLY_EVENTS,
  PROBLEM_EVENT_FIELDS,
  problemFieldsAllowed,
  problemLocalOnly,
  problemInfoLine,
  problemReportEnvelopeSchema,
  problemReportSchema,
} from "./problems";

const accepts = (schema: v.GenericSchema, value: unknown) => v.safeParse(schema, value).success;

describe("problem report contract (ADR 0066)", () => {
  const line = {
    seq: 1,
    time: 1_792_731_845_123,
    level: "warn",
    event: "login.attempt",
    fields: {
      origin: "https://bank.example",
      recipe: "gen-0123456789abcdef0123456789abcdef",
      recipeRevision: 2,
      outcome: "target-missing",
      settled: true,
      url: "/[id]/signin",
      tab: 9,
    },
  };
  const report = (...entries: unknown[]) => ({
    version: 1,
    extensionBuild: "1c42ad3",
    logId: "0123456789abcdef0123456789abcdef",
    entries,
  });
  const withFields = (event: string, fields: Record<string, unknown>) =>
    report({ ...line, event, fields });

  it("accepts warning and error lines of the fields each event may carry", () => {
    expect(accepts(problemReportSchema, report(line))).toBe(true);
    expect(accepts(problemReportSchema, report({ ...line, level: "error", fields: {} }))).toBe(
      true,
    );
    expect(accepts(problemReportSchema, report(...Array.from({ length: 100 }, () => line)))).toBe(
      true,
    );
    for (const [event, fields] of [
      [
        "error.unhandled",
        { source: "error", name: "TypeError", stack: "background.js:1:2 chunk-a.js:3:4" },
      ],
      ["login.ask-ended", { origin: "origin:7d2b91aa", ask: "logout", elsewhere: false }],
      ["login.popup", { origin: "http://localhost:8080", choice: "none" }],
      ["login.choice", { origin: "http://[::1]:3000", url: "/" }],
      ["login.exception", { message: "storage-failed", url: "/a%2Fb/[id]/sign_in.php" }],
    ] as const)
      expect(accepts(problemReportSchema, withFields(event, fields)), event).toBe(true);
  });

  it("refuses free text, values and fields an event does not carry", () => {
    for (const [event, fields] of [
      // Free text in any string field.
      ["login.attempt", { reason: "Wrong password for alice@example.com" }],
      ["login.attempt", { reason: "wrong password" }],
      ["login.attempt", { reason: "Wrong password\nfor someone" }],
      ["login.attempt", { outcome: "パスワード" }],
      ["login.attempt", { outcome: "" }],
      ["error.unhandled", { name: "Type Error" }],
      ["error.unhandled", { message: "Cannot read alice" }],
      // A URL, a query, a fragment or an email address in a path.
      ["login.attempt", { url: "https://x.example/cb?code=abc" }],
      ["login.attempt", { url: "/cb?code=abc" }],
      ["login.attempt", { url: "/cb#token" }],
      ["login.attempt", { url: "/u/alice@example.com" }],
      ["login.attempt", { url: "/u/alice%40example.com" }],
      ["login.attempt", { url: "/u/alice%2540example.com" }],
      ["login.attempt", { url: "/u/al ice" }],
      // `;` and `=` mark parameters, which the device always redacts.
      ["login.attempt", { url: "/s;jsessionid=abc/login" }],
      ["login.attempt", { url: "/login/token=abc" }],
      ["login.attempt", { url: "relative/path" }],
      ["login.attempt", { url: `/${"a".repeat(512)}` }],
      // `://` only in an origin, and an origin only of its shape.
      ["login.attempt", { reason: "https://x.example" }],
      ["login.attempt", { origin: "https://bank.example/login" }],
      ["login.attempt", { origin: "https://alice@bank.example" }],
      ["login.attempt", { origin: "javascript://x" }],
      ["login.attempt", { origin: "origin:alice" }],
      // Whitespace only in a stack.
      ["login.exception", { stack: "at alice (background.js:1:2)" }],
      // Fields the event does not carry, or of another kind.
      ["login.attempt", { item: "item:0123abcd" }],
      ["vault.state", { connection: "bitwarden:0123ab" }],
      ["login.attempt", { username: "alice" }],
      ["login.attempt", { recipeRevision: "2" }],
      ["login.attempt", { settled: 1 }],
      ["login.attempt", { step: 1.5 }],
      ["login.attempt", { step: -1 }],
      ["vault.sync", { url: "/login" }],
    ] as const)
      expect(accepts(problemReportSchema, withFields(event, fields)), JSON.stringify(fields)).toBe(
        false,
      );
    for (const changed of [
      { level: "info" },
      { level: "debug" },
      { seq: 0 },
      { time: -1 },
      { event: "login.unknown" },
      { event: "Login attempt" },
      { fields: { nested: { a: 1 } } },
      { fields: { list: [1] } },
      { fields: Object.fromEntries(Array.from({ length: 41 }, (_, at) => [`f${at}`, 1])) },
      { url: "/login" },
    ])
      expect(accepts(problemReportSchema, report({ ...line, ...changed }))).toBe(false);
    expect(accepts(problemReportSchema, report())).toBe(false);
    expect(accepts(problemReportSchema, report(...Array.from({ length: 101 }, () => line)))).toBe(
      false,
    );
    expect(accepts(problemReportSchema, { ...report(line), extensionBuild: "main" })).toBe(false);
    expect(accepts(problemReportSchema, { ...report(line), deviceId: "d" })).toBe(false);
    expect(accepts(problemReportSchema, { ...report(line), logId: "0123" })).toBe(false);
    const { logId: _, ...withoutId } = report(line);
    expect(accepts(problemReportSchema, withoutId)).toBe(false);
  });

  it("lets the service check each line on its own within the same envelope", () => {
    const mixed = report(line, { ...line, event: "login.later" }, "not a line");
    expect(accepts(problemReportSchema, mixed)).toBe(false);
    expect(accepts(problemReportEnvelopeSchema, mixed)).toBe(true);
    expect(accepts(problemReportEnvelopeSchema, report())).toBe(false);
    expect(
      accepts(problemReportEnvelopeSchema, report(...Array.from({ length: 101 }, () => line))),
    ).toBe(false);
    expect(accepts(problemReportEnvelopeSchema, { ...report(line), version: 2 })).toBe(false);
    expect(accepts(problemReportEnvelopeSchema, { ...report(line), extensionBuild: "main" })).toBe(
      false,
    );
    expect(accepts(problemReportEnvelopeSchema, { ...report(line), deviceId: "d" })).toBe(false);
  });

  it("takes an info line only when it says why Pateat did nothing", () => {
    const info = (event: string, fields: Record<string, unknown>) =>
      report({
        ...line,
        level: "info",
        event,
        fields: { origin: "https://bank.example", ...fields },
      });
    expect(accepts(problemReportSchema, info("login.refused", { reason: "no-route" }))).toBe(true);
    expect(accepts(problemReportSchema, info("login.entry", { outcome: "refused" }))).toBe(true);
    for (const outcome of ["skipped", "abstained", "unavailable"])
      expect(accepts(problemReportSchema, info("recipe.generate", { outcome }))).toBe(true);
    expect(accepts(problemReportSchema, info("login.entry", { outcome: "pressed" }))).toBe(false);
    expect(accepts(problemReportSchema, info("login.entry", {}))).toBe(false);
    expect(accepts(problemReportSchema, info("recipe.generate", { outcome: "recipe" }))).toBe(
      false,
    );
    expect(accepts(problemReportSchema, info("login.start", { route: "password" }))).toBe(false);
    expect(problemInfoLine("toString", {})).toBe(false);
  });

  it("refuses passkey reports and fill-only logins' lines, which stay on the device", () => {
    for (const level of ["warn", "error"])
      for (const [event, fields] of [
        ["passkey.request", { origin: "https://bank.example", rpId: "bank.example" }],
        ["passkey.create", { origin: "https://bank.example", outcome: "failed" }],
        ["passkey.request", {}],
      ] as const)
        expect(
          accepts(problemReportSchema, report({ ...line, level, event, fields })),
          `${level} ${event}`,
        ).toBe(false);
    for (const event of LOCAL_ONLY_EVENTS)
      expect(Object.hasOwn(PROBLEM_EVENT_FIELDS, event)).toBe(false);
    expect(accepts(problemReportSchema, withFields("login.attempt", { fillOnly: true }))).toBe(
      false,
    );
    expect(accepts(problemReportSchema, withFields("login.start", { fillOnly: true }))).toBe(false);
    expect(problemLocalOnly("passkey.create", {})).toBe(true);
    expect(problemLocalOnly("login.attempt", { fillOnly: true })).toBe(true);
  });

  it("checks each field by the kind its event gives it", () => {
    expect(problemFieldsAllowed("vault.refresh", { outcome: "failed", status: 503 })).toBe(true);
    expect(problemFieldsAllowed("vault.refresh", { status: "503" })).toBe(false);
    expect(problemFieldsAllowed("log.dropped", { tab: 4, count: 2 })).toBe(true);
  });
});
