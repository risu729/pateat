import type { LoginObservation, ObservedCandidate } from "@pateat/contracts";
import { describe, expect, it } from "vitest";
import type { ExpectedResult } from "./cases";
import { carryLabel } from "./carry";

const candidate = (
  id: string,
  role: ObservedCandidate["role"],
  value: string,
  by: "id" | "text" = "id",
): ObservedCandidate => ({ id, role, target: { by, value } });

const page = (candidates: ObservedCandidate[], extra: Partial<LoginObservation> = {}) =>
  ({
    version: 1,
    origin: "https://bank.example.test",
    path: "/login",
    language: "ja",
    complete: true,
    candidates,
    ...extra,
  }) satisfies LoginObservation;

const before = page([
  candidate("c1", "text", "user"),
  candidate("c2", "password", "pass"),
  candidate("c3", "button", "ログイン", "text"),
  candidate("c4", "button", "パスキーでログイン", "text"),
]);
const label: ExpectedResult = {
  kind: "plan",
  fields: { username: "c1", password: "c2" },
  action: "c3",
  purpose: "submit",
  passkeyButton: "c4",
};

describe("carryLabel", () => {
  it("renames each labelled candidate to the one with the same role and locator", () => {
    const after = page([
      candidate("c1", "link", "お知らせ", "text"),
      candidate("c2", "text", "user"),
      candidate("c3", "password", "pass"),
      candidate("c4", "button", "パスキーでログイン", "text"),
      candidate("c5", "button", "ログイン", "text"),
    ]);
    expect(carryLabel(before, label, after)).toEqual({
      ok: true,
      expected: {
        kind: "plan",
        fields: { username: "c2", password: "c3" },
        action: "c5",
        purpose: "submit",
        passkeyButton: "c4",
      },
    });
  });

  it("renames the candidates of alternative identifier sets too", () => {
    const withEmail = page([...before.candidates, candidate("c5", "email", "mail")]);
    const alternative: ExpectedResult = {
      ...label,
      alternatives: [{ fields: { username: "c5", password: "c2" }, action: "c3" }],
    };
    const after = page([
      candidate("c1", "link", "お知らせ", "text"),
      ...withEmail.candidates.map((entry, index) => ({ ...entry, id: `c${index + 2}` })),
    ]);
    const carried = carryLabel(withEmail, alternative, after);
    expect(carried.ok && carried.expected).toMatchObject({
      alternatives: [{ fields: { username: "c6", password: "c3" }, action: "c4" }],
    });
  });

  it("refuses a candidate whose role changed, such as a link that became a button", () => {
    const after = page([
      candidate("c1", "text", "user"),
      candidate("c2", "password", "pass"),
      candidate("c3", "link", "ログイン", "text"),
      candidate("c4", "button", "パスキーでログイン", "text"),
    ]);
    expect(carryLabel(before, label, after)).toEqual({
      ok: false,
      reason: "missing-candidate",
      candidate: "c3",
    });
  });

  it("refuses a page whose fields to fill changed, which may need another label", () => {
    const after = page([...before.candidates, candidate("c5", "tel", "otp")]);
    expect(carryLabel(before, label, after)).toEqual({ ok: false, reason: "changed-fields" });
  });

  it("refuses an incomplete observation and one of another path", () => {
    expect(carryLabel(before, label, page(before.candidates, { complete: false }))).toEqual({
      ok: false,
      reason: "incomplete",
    });
    expect(carryLabel(before, label, page(before.candidates, { path: "/error" }))).toEqual({
      ok: false,
      reason: "moved",
    });
  });

  it("keeps an abstention as it is", () => {
    expect(carryLabel(before, { kind: "abstain" }, before)).toEqual({
      ok: true,
      expected: { kind: "abstain" },
    });
  });
});
