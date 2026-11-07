import type { LoginObservation, ObservedCandidate } from "@pateat/contracts";

/** What a careful human would answer for a judged page, in candidate IDs. */
export type JudgeExpected = {
  /** The decisions that count as right; most cases allow one. */
  decisions: ("signed-in" | "rejected" | "challenge" | "optional" | "unclear")[];
  /** For `signed-in`: every marker that would be right. Any other marker is wrong. */
  markers?: string[];
  /**
   * For `challenge`: an ID the answer must name, or null when it must name none. A detail
   * left out is not scored.
   */
  passkeyButton?: string | null;
  passwordButton?: string | null;
  authenticatorButton?: string | null;
  code?: { field: string; submit: string; sources: string[] } | null;
};

/** One synthetic judged page with its ground truth. No case holds a real site or account. */
export type JudgeCase = {
  id: string;
  summary: string;
  observation: LoginObservation;
  loginPaths: string[];
  /** A login's stop before a password it does not fill (ADR 0036). */
  stop?: boolean;
  expected: JudgeExpected;
};

type Extra = Partial<Omit<ObservedCandidate, "id" | "role">>;
const element =
  (role: ObservedCandidate["role"]) =>
  (id: string, label?: string, extra: Extra = {}): ObservedCandidate => ({
    id,
    role,
    target: { by: "id", value: id },
    ...(label === undefined ? {} : { label }),
    ...extra,
  });
export const text = element("text");
export const email = element("email");
export const tel = element("tel");
export const password = element("password");
export const button = element("button");
export const link = element("link");
export const checkbox = element("checkbox");
/** A button or link found by its text, as script buttons and nav links usually are. */
export const byText = (target: ObservedCandidate): ObservedCandidate => ({
  ...target,
  target: { by: "text", value: target.label! },
});
export const byHref = (target: ObservedCandidate, path: string): ObservedCandidate => ({
  ...target,
  target: { by: "href", value: path },
});
export const code = (id: string, extra: Extra = {}) =>
  text(id, undefined, {
    autocomplete: "one-time-code",
    inputMode: "numeric",
    maxLength: 6,
    ...extra,
  });

export const page = (
  host: string,
  path: string,
  language: LoginObservation["language"],
  candidates: ObservedCandidate[],
  extra: Partial<Omit<LoginObservation, "version" | "origin" | "path" | "language">> = {},
): LoginObservation => ({
  version: 1,
  origin: `https://${host}.example.test`,
  path,
  language,
  complete: true,
  candidates,
  ...extra,
});

export const signedIn = (...markers: string[]): JudgeExpected => ({ decisions: ["signed-in"], markers });
export const rejected: JudgeExpected = { decisions: ["rejected"] };
export const optional: JudgeExpected = { decisions: ["optional"] };
export const unclear: JudgeExpected = { decisions: ["unclear"] };

/**
 * Candidates get the extension's IDs (`c1`, `c2` …) in page order, as real observations
 * carry them; the readable names written here stay only as the elements' DOM IDs.
 */
export function withObservedIds(testCase: JudgeCase): JudgeCase {
  const ids = new Map(
    testCase.observation.candidates.map((entry, index) => [entry.id, `c${index + 1}`]),
  );
  const id = (name: string) => {
    const mapped = ids.get(name);
    if (mapped === undefined) throw new Error(`${testCase.id}: no candidate ${name}`);
    return mapped;
  };
  const detail = (name: string | null) => (name === null ? null : id(name));
  const { expected } = testCase;
  return {
    ...testCase,
    observation: {
      ...testCase.observation,
      candidates: testCase.observation.candidates.map((entry) => ({ ...entry, id: id(entry.id) })),
    },
    expected: {
      decisions: expected.decisions,
      ...(expected.markers === undefined ? {} : { markers: expected.markers.map(id) }),
      ...(expected.passkeyButton === undefined
        ? {}
        : { passkeyButton: detail(expected.passkeyButton) }),
      ...(expected.passwordButton === undefined
        ? {}
        : { passwordButton: detail(expected.passwordButton) }),
      ...(expected.authenticatorButton === undefined
        ? {}
        : { authenticatorButton: detail(expected.authenticatorButton) }),
      ...(expected.code === undefined
        ? {}
        : {
            code:
              expected.code === null
                ? null
                : {
                    ...expected.code,
                    field: id(expected.code.field),
                    submit: id(expected.code.submit),
                  },
          }),
    },
  };
}
