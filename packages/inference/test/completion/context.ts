import type { CompletionFixtures } from "../../src/completion.test";

export type Candidate = Record<string, unknown>;
export type Judge = ReturnType<CompletionFixtures["judgeReturning"]>["judge"];
