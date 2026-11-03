import { caseFor } from "./fake-models";

export type Sent = { url: string; headers: Headers; body: Record<string, any> };
type ClefQuestion = { type: string; criteria: Record<string, unknown> };

/**
 * Answers like Workers AI's Clef endpoint without any network I/O: each choice with the
 * page's truth at `confidence`, the rest spread over the other options, rounded to four
 * decimals as Clef rounds.
 */
export function fakeClef(
  reply: { status?: number; body?: unknown; confidence?: number; usage?: unknown } = {},
) {
  const sent: Sent[] = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    sent.push({ url: String(input), headers: new Headers(init?.headers), body });
    if (reply.body !== undefined || reply.status !== undefined)
      return Response.json(reply.body ?? {}, { status: reply.status ?? 200 });
    const expected = caseFor(body.state.page).expected;
    const answers: Record<string, unknown> = {};
    for (const [id, question] of Object.entries(body.questions as Record<string, ClefQuestion>)) {
      const options = Object.keys(question.criteria);
      const target =
        expected.kind === "abstain"
          ? undefined
          : id === "action"
            ? expected.action
            : expected.fields[id.slice("slot.".length)];
      const choice = target === undefined ? "none" : `c:${target}`;
      const confidence = reply.confidence ?? 0.9;
      const rest = Math.round(((1 - confidence) / (options.length - 1)) * 10_000) / 10_000;
      answers[id] = {
        type: "choice",
        choice,
        probabilities: Object.fromEntries(
          options.map((option) => [option, option === choice ? confidence : rest]),
        ),
        confidence: 0.5,
      };
    }
    return Response.json({
      result: {
        model: body.model,
        answers,
        usage: reply.usage ?? { input_tokens: 1_000, output_tokens: 0 },
      },
      success: true,
      errors: [],
      messages: [],
    });
  }) as typeof globalThis.fetch;
  return { sent, fetch };
}
