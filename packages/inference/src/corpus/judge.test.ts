import { loginObservationSchema } from "@pateat/contracts";
import * as v from "valibot";
import { describe, expect, it } from "vitest";
import { createCompletionJudge } from "../completion";
import { judgeVerdict } from "../judge-evaluate";
import { textModel, textResult } from "../testing/fake-models";
import { judgeCorpus, type JudgeCase } from "./judge";

// The ground truth as the judge would answer it: the first allowed decision and marker,
// and each challenge detail it names.
function truthAnswer({ expected }: JudgeCase) {
  const decision = expected.decisions[0]!;
  if (decision === "signed-in") return { decision, marker: expected.markers![0]! };
  if (decision !== "challenge") return { decision };
  return {
    decision,
    ...(expected.passkeyButton ? { passkeyButton: expected.passkeyButton } : {}),
    ...(expected.passwordButton ? { passwordButton: expected.passwordButton } : {}),
    ...(expected.authenticatorButton ? { authenticatorButton: expected.authenticatorButton } : {}),
    ...(expected.code
      ? {
          code: {
            field: expected.code.field,
            submit: expected.code.submit,
            source: expected.code.sources[0]!,
          },
        }
      : {}),
  };
}

describe("judge corpus", () => {
  it("parses, has unique pages and observed candidate IDs", () => {
    expect(new Set(judgeCorpus.map((entry) => entry.id)).size).toBe(judgeCorpus.length);
    for (const entry of judgeCorpus) {
      v.parse(loginObservationSchema, entry.observation);
      expect(
        entry.observation.candidates.map((candidate) => candidate.id),
        entry.id,
      ).toEqual(entry.observation.candidates.map((_, index) => `c${index + 1}`));
    }
  });

  it("covers every decision", () => {
    const decisions = new Set(judgeCorpus.flatMap((entry) => entry.expected.decisions));
    expect(decisions).toEqual(
      new Set(["signed-in", "rejected", "challenge", "optional", "unclear"]),
    );
  });

  it("scores its own ground truth as correct and passes the judge's local checks", async () => {
    for (const entry of judgeCorpus) {
      const answer = truthAnswer(entry);
      const judge = createCompletionJudge({
        model: textModel(async () => textResult(JSON.stringify({ result: answer }))),
        limits: { timeoutMs: 1_000, maxInputBytes: 64 * 1024 },
        maxOutputTokens: 512,
      });
      // oxlint-disable-next-line no-await-in-loop
      const outcome = await judge({
        observation: entry.observation,
        loginPaths: entry.loginPaths,
        ...(entry.stop ? { stop: true } : {}),
      });
      expect(outcome.status, entry.id).toBe(answer.decision === "unclear" ? "abstained" : "ok");
      expect(judgeVerdict(entry, outcome.answer as never), entry.id).toBe("correct");
    }
  });
});

describe("judge verdicts", () => {
  const signedIn = judgeCorpus.find((entry) => entry.id === "en-name-menu")!;
  const challenge = judgeCorpus.find((entry) => entry.id === "en-split-email-code")!;

  it("calls a signed-in answer on another page a false signed-in", () => {
    const rejected = judgeCorpus.find((entry) => entry.id === "en-incorrect-password")!;
    expect(judgeVerdict(rejected, { decision: "signed-in", marker: "c3" })).toBe("false-signed-in");
    expect(judgeVerdict(rejected, { decision: "unclear" })).toBe("wrong-decision");
  });

  it("scores a marker that names the person as a wrong detail", () => {
    expect(judgeVerdict(signedIn, { decision: "signed-in", marker: "c1" })).toBe("wrong-detail");
  });

  it("accepts any box of a split code and checks the source", () => {
    const answer = (field: string, source: string) => ({
      decision: "challenge" as const,
      code: { field, submit: "c7", source },
    });
    expect(judgeVerdict(challenge, answer("c3", "email"))).toBe("correct");
    expect(judgeVerdict(challenge, answer("c1", "unknown"))).toBe("wrong-detail");
  });

  it("counts a missing answer as failed", () => {
    expect(judgeVerdict(challenge, undefined)).toBe("failed");
  });
});
