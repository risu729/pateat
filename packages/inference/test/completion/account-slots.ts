import { expect, it } from "vitest";
import { completionInstructions } from "../../src/completion";
import type { Candidate, Judge } from "./context";

type AccountSlotContext = {
  page: Candidate;
  slots: Candidate[];
  answered: (details: unknown[]) => Candidate;
  judgedWith: (
    result: unknown,
    sentSlots?: unknown,
  ) => { sent: unknown[]; outcome: ReturnType<Judge> };
  answerTarget: { by: string; value: string };
};

export function registerAccountSlotCases({
  page,
  slots,
  answered,
  judgedWith,
  answerTarget,
}: Pick<AccountSlotContext, "page" | "slots" | "answered" | "judgedWith" | "answerTarget">) {
  it("sends the slots with the page, as generation sends them", async () => {
    const { sent, outcome } = judgedWith({ decision: "unclear" });
    await outcome;
    expect(sent).toEqual([
      { task: "judge-sign-in", loginPaths: ["/login"], slots, stepElements: [], observation: page },
    ]);
  });

  it("refuses slots that fail the generation request's bounds", async () => {
    for (const bad of [
      [{ ...slots[3], valueShape: { length: 3, classes: ["ascii-digit"], email: false } }],
      [slots[2], slots[2]],
      Array.from({ length: 21 }, (_, index) => ({ ...slots[1], id: `slot-${index}` })),
    ]) {
      const { sent, outcome } = judgedWith({ decision: "unclear" }, bad);
      // oxlint-disable-next-line no-await-in-loop -- Each request is refused on its own.
      expect(await outcome).toMatchObject({ status: "failed", error: "invalid-request" });
      expect(sent).toEqual([]);
    }
  });

  it("pairs a kept secret answer's input with the slot the model named, apart from the handler", async () => {
    const { outcome } = judgedWith(
      answered([
        { field: "answer", value: "secret-answer", slot: 3, shown: "母親の旧姓は？" },
        { field: "member", value: "member-id" },
      ]),
    );
    expect(await outcome).toEqual(
      expect.objectContaining({
        status: "ok",
        value: {
          decision: "challenge",
          // The handler names only the details and the inputs, never a field name.
          detail: {
            fields: [
              { detail: "secret-answer", target: answerTarget },
              { detail: "member-id", target: { by: "name", value: "member" } },
            ],
            target: { by: "id", value: "next" },
          },
          questions: [{ field: answerTarget, slot: "custom-2", shown: "母親の旧姓は？" }],
        },
      }),
    );
  });

  it.each([
    ["no slot", { shown: "母親の旧姓は？" }],
    ["no question", { slot: 3 }],
    ["a slot the request lacks", { slot: 7, shown: "母親の旧姓は？" }],
    ["a built-in slot", { slot: 0, shown: "母親の旧姓は？" }],
    ["the password", { slot: 1, shown: "母親の旧姓は？" }],
    ["a question with a control character", { slot: 3, shown: "母親の\u0007旧姓は？" }],
  ])("keeps the answer's input but no pairing for %s", async (_label, pairing) => {
    const { outcome } = judgedWith(
      answered([{ field: "answer", value: "secret-answer", ...pairing }]),
    );
    expect(await outcome).toEqual(
      expect.objectContaining({
        status: "ok",
        value: {
          decision: "challenge",
          detail: {
            fields: [{ detail: "secret-answer", target: answerTarget }],
            target: { by: "id", value: "next" },
          },
        },
      }),
    );
  });

  it("pairs no other detail, and no input it dropped", async () => {
    const { outcome } = judgedWith(
      answered([
        { field: "member", value: "member-id", slot: 2, shown: "Member number" },
        { field: "missing", value: "secret-answer", slot: 3, shown: "母親の旧姓は？" },
      ]),
    );
    const result = await outcome;
    expect(result).toMatchObject({ status: "ok", value: { detailsDropped: ["unknown-field"] } });
    expect(result.status === "ok" && "questions" in result.value).toBe(false);
  });

  it("fails closed on a slot that is no index", async () => {
    for (const slot of [-1, 1.5, 20, "custom-2"]) {
      const { outcome } = judgedWith(
        answered([{ field: "answer", value: "secret-answer", slot, shown: "母親の旧姓は？" }]),
      );
      // oxlint-disable-next-line no-await-in-loop -- Each answer is judged on its own.
      expect(await outcome).toMatchObject({ status: "failed", error: "invalid-output" });
    }
  });

  it("logs the pairing as the model gave it, with an index the request lacks as -1", async () => {
    const { outcome } = judgedWith(
      answered([
        { field: "answer", value: "secret-answer", slot: 9, shown: "母親の旧姓は？" },
        { field: "member", value: "member-id" },
      ]),
    );
    expect((await outcome).answer).toEqual({
      decision: "challenge",
      details: [
        { field: "answer", value: "secret-answer", slot: -1, shown: "母親の旧姓は？" },
        { field: "member", value: "member-id" },
      ],
      detailSubmit: "next",
    });
  });

  it("tells the model what the slots are and how to pair an answer with one", () => {
    expect(completionInstructions).toMatch(
      /Use only candidate IDs and slot indexes from the input\./u,
    );
    expect(completionInstructions).toMatch(
      /A slot with fieldName offers one of the user's vault fields, and fieldPosition tells apart the user's fields of the same name: compare its name and valueShape with element labels, descriptions and constraints to name details and to tell a member-id from the account's sign-in ID, the username slot\./u,
    );
    expect(completionInstructions).toMatch(
      /For a secret-answer, slot is the index in slots of the identifier or hidden slot with fieldName that holds the answer to the question the page shows, even when its name words the question otherwise, and shown is the whole question sentence copied exactly as the page shows it, without a label before it such as "Security question:" and never a part of it; leave both out when no slot is for that question, and for every other detail\./u,
    );
  });
}
