import type { LoginTarget } from "@pateat/contracts";
import { newId } from "@pateat/contracts/ids";
import { clickDestinations, ssoClickDestinations } from "../page/form-destination";
import { visible } from "../page/code-submission";
import { clickable } from "../page/target-state";
import { findTargets } from "../page/targets";
import { closestAcross, queryAll } from "../page/shadow";
import { pressPointer } from "../page/pointer-press";
import {
  extractSignedInObservation,
  extractEntryObservation,
  extractPasskeyObservation,
} from "../observation/extract";
import { showsSignUp } from "../page/entry";
import type { SsoContentCommand, SsoInspection, SsoIdpReading } from "./sso-operation-wire";

const unsafe =
  /(?:\bconsent\b|\bauthori[sz]e\b|\bpermissions?\b|\bgrant\b.*\baccess\b|\bshar(?:e|ing)\b.*\b(?:email|account|data)\b|\b(?:create|register)\b.*\baccount\b|\bsign[ -]?up\b|新規|アカウント.*作成|権限|同意|共有)/iu;
const normalized = (value: string) => value.trim().toLowerCase();
// Match raw complete tokens: no width/format folding and no masked aliases.
const exactAccounts = (text: string) =>
  text
    .match(/(?<![\p{L}\p{N}._%+\-*/])[A-Za-z0-9._%+\-*]{1,64}@[A-Za-z0-9.\-*]{1,253}/gu)
    ?.map((value) => value.replace(/[.-]+$/u, "")) ?? [];
const exactIdentityShown = (document: Document, username: string) =>
  queryAll<HTMLElement>(document, "p,span,div,strong,b,[data-username]")
    .filter(visible)
    .some(
      (element) =>
        element.children.length === 0 &&
        normalized(element.textContent ?? "") === normalized(username),
    );
/** Reject unsafe local semantics again immediately before the click. No value leaves this reader. */
export function ssoUnsafePage(document: Document): boolean {
  const headings = queryAll<HTMLElement>(document, "h1,h2,[role=heading]")
    .filter(visible)
    .slice(0, 8)
    .map((element) => element.textContent ?? "");
  const disclosure =
    /(?:\b(?:email|account|data|details)\b[^.!?]{0,160}\b(?:will be |are |is )?shared\b|\bpermission\b[^.!?]{0,120}\b(?:read|access|share)\b|\b(?:app|application|site)\b[^.!?]{0,100}\bcan access\b|\ballow\b[^.!?]{0,120}\b(?:access|permission)\b|(?:メール|アカウント|データ|情報).{0,80}(?:共有|アクセス.*許可))/iu;
  const body = document.body?.innerText.slice(0, 16_384) ?? "";
  return (
    showsSignUp(document) ||
    unsafe.test([document.title, ...headings].join("\n")) ||
    disclosure.test(body)
  );
}
function inspected(
  document: Document,
  target: LoginTarget,
): { element: HTMLElement; destinations: string[] } | { reason: string } {
  const matches = findTargets(document, target, { links: true });
  if (matches.length !== 1) return { reason: matches.length ? "ambiguous" : "missing" };
  const element = matches[0];
  if (
    !(element instanceof HTMLElement) ||
    !visible(element) ||
    !(element instanceof HTMLAnchorElement || clickable(element))
  )
    return { reason: "unusable" };
  if (ssoUnsafePage(document) || unsafe.test(element.textContent ?? ""))
    return { reason: "unsafe-page" };
  const destinations = [];
  const base = Reflect.apply(Document.prototype.querySelector, document, [
    "base[target]",
  ]) as Element | null;
  const defaultTarget = base && Element.prototype.getAttribute.call(base, "target");
  const link = closestAcross(element, "a[href]");
  if (link instanceof HTMLAnchorElement) {
    if (
      (link.target || defaultTarget || "_self").toLowerCase() !== "_self" ||
      link.hasAttribute("download")
    )
      return { reason: "new-context" };
    const parsed = URL.parse(link.href);
    if (
      !parsed ||
      !["http:", "https:"].includes(parsed.protocol) ||
      parsed.username ||
      parsed.password
    )
      return { reason: "unsafe-destination" };
    destinations.push(parsed.href);
  }
  for (const destination of clickDestinations(element)) {
    if (destination.kind === "refused") return { reason: "unsafe-destination" };
    if (destination.kind === "other-origin") destinations.push(destination.url);
  }
  const submissions = ssoClickDestinations(element);
  if (!submissions) return { reason: "unsafe-destination" };
  destinations.push(...submissions);
  if (new Set(destinations).size > 8) return { reason: "too-many-destinations" };
  return { element, destinations: [...new Set(destinations)] };
}
/** Generic finite IdP pages; no provider catalogue and no consent-as-continue rule. */
export function readSsoIdp(document: Document, username: string): SsoIdpReading {
  if (ssoUnsafePage(document)) return { kind: "unsafe", reason: "permission-or-account-creation" };
  let observation = extractSignedInObservation(document);
  if (!observation.ok) observation = extractEntryObservation(document);
  if (!observation.ok || !observation.observation.complete) return { kind: "unknown" };
  if (extractPasskeyObservation(document).ok) return { kind: "native" };
  const page = observation.observation;
  if (
    page.candidates.some((candidate) =>
      ["text", "email", "tel", "number", "password"].includes(candidate.role),
    )
  )
    return { kind: "native" };
  const controls = page.candidates.filter(
    (candidate) => candidate.role === "button" || candidate.role === "link",
  );
  const exact = controls.filter((candidate) => {
    const matches = findTargets(document, candidate.target, { links: true });
    if (matches.length !== 1) return false;
    const text = matches[0]!.textContent ?? "";
    const accounts = exactAccounts(text);
    return (
      !/[*●•]/u.test(text) &&
      (normalized(text) === normalized(username) ||
        (accounts.length === 1 && normalized(accounts[0]!) === normalized(username)))
    );
  });
  if (exact.length === 1 && exact[0]!.target.by !== "href")
    return { kind: "account", target: exact[0]!.target };
  if (exact.length > 1) return { kind: "unsafe", reason: "ambiguous-account" };
  const body = document.body?.innerText ?? "";
  const accounts = exactAccounts(body);
  if (
    accounts.some((account) => normalized(account) !== normalized(username)) ||
    /[*●•]/u.test(accounts.join(" "))
  )
    return { kind: "unsafe", reason: "wrong-or-masked-account" };
  const sameAccount =
    accounts.some((account) => normalized(account) === normalized(username)) ||
    exactIdentityShown(document, username);
  const stays =
    /(?:stay signed in|keep (?:me|you) signed in|サインイン.*維持|ログイン状態.*保持)/iu.test(
      [
        document.title,
        ...queryAll(document, "h1,h2").map((element) => element.textContent ?? ""),
      ].join(" "),
    );
  const candidates = controls.filter((candidate) => {
    if (candidate.target.by === "href") return false;
    const label = candidate.label?.trim() ?? "";
    if (stays) return /^(?:yes|はい)$/iu.test(label);
    if (/^(?:continue|next|続行|次へ)$/iu.test(label)) return true;
    const named = /^continue as (.+)$/iu.exec(label)?.[1] ?? /^(.+)でログイン$/u.exec(label)?.[1];
    return named !== undefined && normalized(named) === normalized(username);
  });
  if (sameAccount && candidates.length === 1 && candidates[0]!.target.by !== "href")
    return { kind: stays ? "stay-signed-in" : "continue", target: candidates[0]!.target };
  return { kind: "unknown" };
}
/** Explicit wrong identity defeats a generic signed-in marker on the RP return. */
export function readSsoReturn(
  document: Document,
  username?: string,
): { ok: false; reason: string } | { ok: true; identity: "match" | "different" | "absent" } {
  if (ssoUnsafePage(document)) return { ok: false, reason: "unsafe-return" };
  if (!username) return { ok: true, identity: "absent" };
  const identity = normalized(username);
  const headers = queryAll<HTMLElement>(
    document,
    "header,nav,[role=banner],[role=navigation]",
  ).filter(visible);
  const accounts = headers.flatMap((element) => exactAccounts(element.innerText));
  if (accounts.some((account) => normalized(account) !== identity))
    return { ok: true, identity: "different" };
  const explicit = headers
    .flatMap((header) => queryAll<HTMLElement>(header, "[data-username]").filter(visible))
    .map((element) => element.getAttribute("data-username") || element.textContent || "");
  if (explicit.some((value) => normalized(value) !== identity))
    return { ok: true, identity: "different" };
  const matched =
    accounts.some((value) => normalized(value) === identity) ||
    headers.some((header) =>
      queryAll<HTMLElement>(header, "span,a,p,strong,b,[data-username]")
        .filter(visible)
        .some(
          (element) =>
            element.children.length === 0 && normalized(element.textContent ?? "") === identity,
        ),
    );
  return { ok: true, identity: matched ? "match" : "absent" };
}
/** A prepared DOM object is single-use. The background must authorize after intent is durable. */
export function createSsoContent(
  document: Document,
  options: {
    cancelled: () => boolean;
    authorize: (input: {
      flowId: string;
      operationId: string;
      handle: string;
      phase: "pointer" | "click";
    }) => Promise<boolean>;
  },
) {
  const prepared = new Map<
    string,
    {
      flowId: string;
      operationId: string;
      target: LoginTarget;
      element: HTMLElement;
      url: string;
      destinations: string[];
    }
  >();
  return async (
    command: SsoContentCommand,
  ): Promise<
    SsoInspection | SsoIdpReading | { ok: boolean } | ReturnType<typeof readSsoReturn>
  > => {
    if (options.cancelled()) {
      prepared.clear();
      return { ok: false, reason: "cancelled" };
    }
    if (command.type === "login.sso.return") return readSsoReturn(document, command.username);
    if (command.type === "login.sso.idp") return readSsoIdp(document, command.username);
    if (command.type === "login.sso.commit") {
      const held = prepared.get(command.handle);
      prepared.delete(command.handle);
      if (!held || held.flowId !== command.flowId || held.operationId !== command.operationId)
        return { ok: false, reason: "operation-gone" };
      if (!(await options.authorize({ ...command, phase: "pointer" })))
        return { ok: false, reason: "not-authorized" };
      const current = () => {
        if (options.cancelled() || document.URL !== held.url) return false;
        const latest = inspected(document, held.target);
        return (
          !("reason" in latest) &&
          latest.element === held.element &&
          JSON.stringify(latest.destinations) === JSON.stringify(held.destinations)
        );
      };
      if (!current()) return { ok: false, reason: "target-changed" };
      const pressed = await pressPointer(held.element, current);
      if (pressed !== "pressed" || !current()) return { ok: false, reason: "target-changed" };
      if (!(await options.authorize({ ...command, phase: "click" })) || !current())
        return { ok: false, reason: "not-authorized" };
      HTMLElement.prototype.click.call(held.element);
      return { ok: true };
    }
    const found = inspected(document, command.target);
    if ("reason" in found) return { ok: false, reason: found.reason };
    if (command.type === "login.sso.inspect")
      return { ok: true, url: document.URL, destinations: found.destinations };
    prepared.clear();
    const handle = newId();
    prepared.set(handle, {
      ...found,
      flowId: command.flowId,
      operationId: command.operationId,
      target: command.target,
      url: document.URL,
    });
    return { ok: true, url: document.URL, destinations: found.destinations, handle };
  };
}
