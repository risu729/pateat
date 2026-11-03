import { loginObservationSchema, semanticSlotsSchema } from "@pateat/contracts";
import * as v from "valibot";
import { describe, expect, it } from "vitest";
import { validateGeneratedPage } from "../plan";
import { expectedFields } from "./cases";
import { logPageCorpus } from "./log";
import {
  assembleLogCorpus,
  coarseShape,
  draftLogCases,
  loginOf,
  privateHints,
  scrubObservation,
  scrubSlots,
  scrubText,
  textScrubber,
  type LogRow,
  type OutcomeRow,
} from "./log-convert";

// Synthetic rows only: no production row enters the repository's tests.
const observation = {
  version: 1,
  origin: "https://login.example.com",
  path: "/signin",
  language: "en",
  title: "Sign in",
  complete: true,
  candidates: [
    { id: "c1", role: "email", target: { by: "id", value: "email" }, label: "Email" },
    { id: "c2", role: "password", target: { by: "id", value: "pw" }, label: "Password" },
    { id: "c3", role: "button", target: { by: "text", value: "Sign in" }, label: "Sign in" },
  ],
};
const slots = [
  {
    id: "username",
    kind: "identifier",
    description: "account username, email address or login ID",
  },
  { id: "password", kind: "secret", description: "account password" },
];
const answer = {
  decision: "plan",
  pageKind: "sign-in",
  irreversible: "no",
  fields: [
    { slot: "username", candidate: "c1" },
    { slot: "password", candidate: "c2" },
  ],
  action: { candidate: "c3", purpose: "submit" },
};
const row = (overrides: Partial<LogRow> = {}): LogRow => ({
  id: "row-1",
  owner_id: "owner",
  role: "generate",
  origin: "https://login.example.com",
  path: "/signin",
  recipe_page: "first",
  request: JSON.stringify({ instructions: "…", slots, observation }),
  answer: JSON.stringify(answer),
  result: JSON.stringify({ fields: answer.fields, action: answer.action }),
  outcome: "ok",
  model_id: "claude-opus-5-5",
  effort: "low",
  speed: "standard",
  prompt_version: "p1",
  source: "service",
  build: "abc1234",
  created_at: Date.UTC(2026, 9, 20, 9),
  recipe_id: "gen-1",
  branch: "",
  layout: "1792791691542",
  revision: 2,
  observation_hash: "0123456789ab",
  ...overrides,
});
const outcome = (overrides: Partial<OutcomeRow> = {}): OutcomeRow => ({
  owner_id: "owner",
  recipe_id: "gen-1",
  branch: "1792791691542",
  revision: 2,
  outcome: "authenticated",
  cause: null,
  step: 0,
  ...overrides,
});

describe("request-log corpus conversion", () => {
  it("scrubs email addresses, long digit runs and configured text", () => {
    const replacements = new Map([["Taro Yamada", "Hanako Example"]]);
    expect(scrubText("Taro Yamada taro.y@mail.example.jp No. 0012345", replacements)).toBe(
      "Hanako Example user@example.com No. 1234567",
    );
    expect(scrubText("PIN 123", replacements)).toBe("PIN 123");
    // Full-width digits too, and distinct runs stay distinct.
    expect(scrubText("口座番号 １２３４５６７", replacements)).toBe("口座番号 1234567");
    const scrub = textScrubber(new Map());
    expect([scrub("acct-98765"), scrub("acct-56789"), scrub("again 98765")]).toEqual([
      "acct-12345",
      "acct-12341",
      "again 12345",
    ]);
  });

  it("replaces listed accounts wherever their text shows, and keeps structure", () => {
    const listed = v.parse(loginObservationSchema, {
      ...observation,
      candidates: [{ id: "c1", role: "button", target: { by: "text", value: "Taro [email]" } }],
      accounts: ["Taro [email]"],
      accountEntries: 1,
    });
    const scrubbed = scrubObservation(listed, new Map());
    // The redaction mark stays, as the role's checks tell account text by it.
    expect(scrubbed.accounts).toEqual(["Account 1 [email]"]);
    expect(scrubbed.candidates[0]).toEqual({
      id: "c1",
      role: "button",
      target: { by: "text", value: "Account 1 [email]" },
    });
    expect(scrubbed.origin).toBe(listed.origin);
  });

  it("names vault fields synthetically and coarsens value shapes", () => {
    expect(coarseShape({ length: 3, classes: ["ascii-digit"], email: false }).length).toBe(3);
    expect(coarseShape({ length: 13, classes: ["ascii-letter"], email: true }).length).toBe(16);
    expect(coarseShape({ length: 13, classes: ["ascii-letter"], email: true }, true).length).toBe(
      13,
    );
    const scrubbed = scrubSlots(
      [
        ...v.parse(semanticSlotsSchema, slots),
        {
          id: "custom-1",
          kind: "identifier",
          description: "a login identifier",
          fieldName: "my branch",
          valueShape: { length: 3, classes: ["ascii-digit"], email: false },
        },
        { id: "custom-2", kind: "hidden", description: "a hidden value", fieldName: "secret pin" },
      ],
      { "my branch": "支店番号" },
    );
    expect(scrubbed.slots.map((slot) => slot.fieldName)).toEqual([
      undefined,
      undefined,
      "支店番号",
      "field 4",
    ]);
    expect(scrubbed.unnamed).toEqual(["custom-2"]);
  });

  it("hints at hosts and paths that name a tenant or an identifier", () => {
    expect(privateHints("https://acme.enterprise.slack.com", "/")).toEqual([
      "tenant host acme.enterprise.slack.com",
    ]);
    expect(privateHints("https://app.slack.com", "/client")).toEqual([]);
    expect(privateHints("https://idcs-0123456789abcdef0123.identity.oraclecloud.com", "/")).toEqual(
      [
        "tenant host idcs-0123456789abcdef0123.identity.oraclecloud.com",
        "identifier in host idcs-0123456789abcdef0123.identity.oraclecloud.com",
      ],
    );
    expect(privateHints("https://example.com", "/user/123456/login")).toEqual([
      "identifier in path",
    ]);
    expect(privateHints("https://github.com", "/acme/app/pull/12")).toEqual([
      "repository page on github.com",
    ]);
    expect(privateHints("https://github.com", "/login")).toEqual([]);
    expect(privateHints("https://github.com", "/sessions/two-factor")).toEqual([]);
  });

  it("finds the revision's first login, else the next revision's, by layout and branch", () => {
    expect(loginOf(row(), [outcome()])).toEqual({
      outcome: "authenticated",
      cause: null,
      step: 0,
      revision: "same",
    });
    expect(loginOf(row(), [outcome({ revision: 3 })])?.revision).toBe("later");
    // Only the revision right after it, which the next page of the same login wrote.
    expect(loginOf(row(), [outcome({ revision: 4 })])).toBeUndefined();
    expect(loginOf(row(), [outcome({ revision: 1 })])).toBeUndefined();
    // A first page counts the logins of any branch of its layout, a list's chooser ones too.
    expect(loginOf(row(), [outcome({ branch: "1792791691542:account" })])?.outcome).toBe(
      "authenticated",
    );
    expect(loginOf(row(), [outcome({ branch: "1792790000000" })])).toBeUndefined();
    // A later page matches its own branch only.
    const later = row({ recipe_page: "continuation", branch: "1792791691542:account" });
    expect(loginOf(later, [outcome()])).toBeUndefined();
    expect(loginOf(later, [outcome({ branch: "1792791691542:account" })])?.outcome).toBe(
      "authenticated",
    );
    // A row from before layouts joins nothing: that migration removed every login outcome.
    expect(loginOf(row({ layout: null }), [outcome()])).toBeUndefined();
  });

  it("merges rows asking the same thing, keeping the latest row with an answer", () => {
    const { drafts, skipped } = draftLogCases(
      [
        row({ id: "a", created_at: 1 }),
        row({ id: "b", created_at: 3, answer: null, outcome: "busy" }),
        row({ id: "c", created_at: 2, recipe_page: "continuation" }),
        row({ id: "d", origin: "http://localhost:8080" }),
        row({ id: "e", role: "judge" }),
        row({ id: "f", recipe_page: "logout" }),
        row({ id: "g", request: "{" }),
      ],
      [outcome()],
    );
    expect(skipped).toEqual([
      { id: "d", reason: "local test server" },
      { id: "e", reason: "not a generation row" },
      { id: "f", reason: "logout request" },
      { id: "g", reason: "row does not parse" },
    ]);
    expect(
      drafts.map((draft) => [draft.id.slice(0, 17), draft.source.logIds, draft.request]),
    ).toEqual(
      expect.arrayContaining([
        ["log-0123456789ab-", ["a", "b"], undefined],
        ["log-0123456789ab-", ["c"], { startPage: false }],
      ]),
    );
    expect(drafts).toHaveLength(2);
    const first = drafts.find((draft) => draft.request === undefined)!;
    expect(first.logged).toMatchObject({ outcome: "ok", answer });
    expect(first.login?.outcome).toBe("authenticated");
    expect(first.source.observed).toBe("1970-01-01");
    // The same rows give the same IDs whatever order they come in.
    const again = draftLogCases(
      [
        row({ id: "c", created_at: 2, recipe_page: "continuation" }),
        row({ id: "a", created_at: 1 }),
      ],
      [],
    );
    expect(again.drafts.map((draft) => draft.id).sort()).toEqual(
      drafts.map((draft) => draft.id).sort(),
    );
  });

  it("leaves out a page whose scrubbed text no longer fits the observation's limits", () => {
    const title = `${"x".repeat(113)} a@b.jp`;
    const { drafts, skipped } = draftLogCases(
      [
        row({
          request: JSON.stringify({
            instructions: "…",
            slots,
            observation: { ...observation, title },
          }),
        }),
      ],
      [],
    );
    expect(drafts).toEqual([]);
    expect(skipped).toEqual([{ id: "row-1", reason: "scrubbed observation no longer parses" }]);
  });

  it("marks requests without slots as entry requests and lists as slotless", () => {
    const entry = draftLogCases(
      [row({ request: JSON.stringify({ instructions: "…", observation }) })],
      [],
    );
    expect(entry.drafts[0]).toMatchObject({ request: { entry: true }, slots: [] });
    const passkeyOnly = draftLogCases(
      [
        row({
          request: JSON.stringify({ instructions: "…", slots: [], passkeyOnly: true, observation }),
        }),
      ],
      [],
    );
    expect(passkeyOnly.skipped).toEqual([]);
    expect(passkeyOnly.drafts[0]).toMatchObject({ request: { passkeyOnly: true }, slots: [] });
    // Rows from before observation hashes are told apart by their observations.
    const unhashed = draftLogCases(
      [
        row({ id: "a", observation_hash: null }),
        row({
          id: "b",
          observation_hash: null,
          request: JSON.stringify({
            instructions: "…",
            slots,
            observation: { ...observation, title: "Log in" },
          }),
        }),
      ],
      [],
    );
    expect(unhashed.drafts).toHaveLength(2);
  });

  it("keeps pages with open hints out until their label decides, and splits the corpus", () => {
    const { drafts } = draftLogCases(
      [
        row({ id: "a" }),
        row({ id: "b", origin: "https://acme.slack.com", observation_hash: "bbbbbbbbbbbb" }),
        row({ id: "c", observation_hash: "cccccccccccc" }),
        row({ id: "d", observation_hash: "dddddddddddd" }),
      ],
      [],
    );
    const plan = {
      kind: "plan" as const,
      fields: { username: "c1", password: "c2" },
      action: "c3",
      purpose: "submit" as const,
    };
    const assembled = assembleLogCorpus(
      drafts,
      {
        "log-0123456789ab": { expected: plan, labelSource: "agreed" },
        "log-bbbbbbbbbbbb": { expected: plan, labelSource: "owner" },
        "log-cccccccccccc": { exclude: "labellers unsure" },
        "log-gone": { exclude: "an earlier export's case" },
      },
      "2026-11-03",
    );
    expect(assembled.public.cases.map((entry) => entry.id)).toEqual(["log-0123456789ab"]);
    expect(assembled.private.cases).toEqual([]);
    expect(assembled.undecided).toEqual(["log-bbbbbbbbbbbb"]);
    expect(assembled.unlabelled).toEqual(["log-dddddddddddd"]);
    expect(assembled.unknownLabels).toEqual(["log-gone"]);
    expect(assembled.public.cases[0]).not.toHaveProperty("privateHints");
  });
});

describe("request-log corpus", () => {
  it("holds complete observations whose plan truths pass the generated plan's check", () => {
    expect(new Set(logPageCorpus.map((entry) => entry.id)).size).toBe(logPageCorpus.length);
    for (const entry of logPageCorpus) {
      const parsed = v.parse(loginObservationSchema, entry.observation);
      expect(parsed.complete, entry.id).toBe(true);
      if (entry.expected.kind !== "plan") continue;
      const checked = validateGeneratedPage(
        parsed,
        v.parse(semanticSlotsSchema, entry.slots),
        {
          fields: expectedFields(entry.expected),
          action: { candidate: entry.expected.action, purpose: entry.expected.purpose },
        },
        entry.request?.startPage ?? true,
      );
      expect(checked.ok, entry.id).toBe(true);
    }
  });
});
