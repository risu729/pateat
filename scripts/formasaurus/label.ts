// Turns one probed Formasaurus page into an evaluation case, or a reason it is left out.
// The labels follow the annotations only where they are unambiguous: one login form
// whose identifier, password and submit control can be told apart.
import type { LoginObservation } from "@pateat/contracts";
import type { RealPageCase } from "../../packages/inference/src/corpus/real";
import type { ProbeResult } from "./probe";

export type Annotation = {
  url: string;
  forms: string[];
  visible_html_fields: Record<string, string>[];
};

export type Skip =
  | "held-back"
  | "token-in-path"
  | "unresolved-candidate"
  | "not-observed"
  | "incomplete"
  | "forms-misaligned"
  | "unannotated-form"
  | "not-sent"
  | "several-login-forms"
  | "login-field-not-observed"
  | "other-login-fields"
  | "no-identifier-or-password"
  | "no-login-button"
  | "unclear-login-button";

const identifierTypes = new Set(["us", "e1", "ue"]);

/**
 * Pages held back after the personal-data review of ADR 0012 (2026-10-11): a private
 * person's homepage, and a forum for cashing out stolen funds.
 */
const heldBack = new Set(["html/946.html", "html/60.html"]);
/**
 * A long opaque path segment, such as Magento's base64 `/referer/` that carries the
 * original URL with its session ID. Such paths are left out rather than rewritten.
 */
// Base64url may hold a hyphen or two; a slug of hyphenated words is not opaque.
const opaqueSegment = /^(?=.*\d)(?=.*[a-z])(?=.*[A-Z])(?!(?:[^-]*-){3})[\w+=-]{32,}$/u;
const fillRoles = new Set(["text", "email", "tel", "number", "password"]);
// Submit, cancel, reset and other buttons; only Bs may be the page action.
const otherButtonTypes = new Set(["Bc", "Br", "Bo"]);

/**
 * Whether the extension would send this page for generation: a password input, or a
 * field marked `username` or `one-time-code` (ADR 0016). The vault-match half of the
 * rule is assumed.
 */
const wouldSend = (observation: LoginObservation) =>
  observation.candidates.some(
    (candidate) =>
      candidate.role === "password" ||
      (fillRoles.has(candidate.role) &&
        (candidate.autocomplete === "username" || candidate.autocomplete === "one-time-code")),
  );

export function label(
  file: string,
  annotation: Annotation,
  probe: ProbeResult,
): { ok: true; testCase: RealPageCase } | { ok: false; skip: Skip } {
  if (heldBack.has(file)) return { ok: false, skip: "held-back" };
  if (!probe.ok) return { ok: false, skip: "not-observed" };
  const observation = probe.observation as LoginObservation;
  if (observation.path.split("/").some((segment) => opaqueSegment.test(segment)))
    return { ok: false, skip: "token-in-path" };
  // An observed candidate that cannot be found again cannot be placed in a form.
  if (probe.candidates.some((candidate) => candidate.tag === "missing"))
    return { ok: false, skip: "unresolved-candidate" };
  // Inference rejects an incomplete observation before any call.
  if (!observation.complete) return { ok: false, skip: "incomplete" };
  // Formasaurus numbers forms in document order as its parser saw them; every annotated
  // name must be in the same-numbered form here.
  if (
    annotation.forms.length !== probe.formNames.length ||
    annotation.visible_html_fields.some((fields, at) =>
      Object.keys(fields).some((name) => !probe.formNames[at]!.includes(name)),
    )
  )
    return { ok: false, skip: "forms-misaligned" };
  if (!wouldSend(observation)) return { ok: false, skip: "not-sent" };
  const roles = new Map(observation.candidates.map((candidate) => [candidate.id, candidate.role]));
  // Forms Formasaurus left unannotated could be a login form, unless they hold no
  // password field and the page has an annotated login form.
  const unannotated = probe.candidates.filter(
    (candidate) =>
      candidate.form >= 0 && ["X", "-"].includes(annotation.forms[candidate.form] ?? "X"),
  );

  const id = `formasaurus-${file.replace(/^html\/|\.html$/gu, "")}`;
  const base = {
    id,
    source: { dataset: "formasaurus", page: file },
    observation,
  } as const;
  const logins = annotation.forms.flatMap((type, at) => (type === "l" ? [at] : []));
  if (logins.length > 1) return { ok: false, skip: "several-login-forms" };
  // Neither may a password field outside any form.
  const outside = probe.candidates.filter((candidate) => candidate.form < 0);
  if (
    (unannotated.length &&
      (!logins.length ||
        unannotated.some((candidate) => roles.get(candidate.id) === "password"))) ||
    outside.some((candidate) => roles.get(candidate.id) === "password")
  )
    return { ok: false, skip: "unannotated-form" };
  if (logins.length === 0) {
    // A password field outside any form has no annotation to rule out a login.
    if (probe.candidates.some((candidate) => candidate.form < 0))
      return { ok: false, skip: "unannotated-form" };
    return { ok: true, testCase: { ...base, expected: { kind: "abstain" } } };
  }

  const login = logins[0]!;
  const fields = annotation.visible_html_fields[login]!;
  const named = (types: (type: string) => boolean) =>
    Object.entries(fields).flatMap(([name, type]) => (types(type) ? [name] : []));
  const identifiers = named((type) => identifierTypes.has(type));
  const passwords = named((type) => type === "p1");
  if (identifiers.length > 1 || passwords.length > 1 || identifiers.length + passwords.length === 0)
    return { ok: false, skip: "no-identifier-or-password" };
  // A password-only form may expect a remembered identifier; its truth is unclear.
  if (passwords.length && !identifiers.length)
    return { ok: false, skip: "no-identifier-or-password" };

  const inLogin = probe.candidates.filter((candidate) => candidate.form === login);
  const byName = (name: string) => inLogin.filter((candidate) => candidate.name === name);
  const mapped: Record<string, string> = {};
  for (const [slot, names] of [
    ["username", identifiers],
    ["password", passwords],
  ] as const) {
    if (!names.length) continue;
    const found = byName(names[0]!);
    if (found.length !== 1) return { ok: false, skip: "login-field-not-observed" };
    mapped[slot] = found[0]!.id;
  }
  // Any other field in the login form (a captcha, a security code) makes the right
  // plan a judgment call; such pages are left out.
  if (
    inLogin.some(
      (candidate) =>
        fillRoles.has(roles.get(candidate.id)!) && !Object.values(mapped).includes(candidate.id),
    )
  )
    return { ok: false, skip: "other-login-fields" };

  const buttons = inLogin.filter(
    (candidate) =>
      roles.get(candidate.id) === "button" &&
      !otherButtonTypes.has(fields[candidate.name ?? ""] ?? ""),
  );
  const annotated = buttons.filter((candidate) => fields[candidate.name ?? ""] === "Bs");
  const submits = buttons.filter(
    (candidate) =>
      candidate.type === "submit" ||
      candidate.type === "image" ||
      (candidate.tag === "button" && candidate.type === undefined),
  );
  const action =
    annotated.length === 1
      ? annotated[0]
      : buttons.length === 1
        ? buttons[0]
        : submits.length === 1
          ? submits[0]
          : undefined;
  if (!buttons.length) return { ok: false, skip: "no-login-button" };
  if (!action) return { ok: false, skip: "unclear-login-button" };

  return {
    ok: true,
    testCase: {
      ...base,
      expected: {
        kind: "plan",
        fields: mapped,
        action: action.id,
        purpose: passwords.length ? "submit" : "advance",
      },
    },
  };
}
