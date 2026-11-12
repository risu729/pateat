import type { LoginTarget } from "@pateat/contracts";
import { newId } from "@pateat/contracts/ids";
import { clickDestinations, ssoClickDestinations } from "../page/form-destination";
import { visible } from "../page/code-submission";
import { clickable } from "../page/target-state";
import { findTargets } from "../page/targets";
import { closestAcross, formOf, queryAll } from "../page/shadow";
import { pressElement } from "../page/script-url-click";
import { extractSignedInObservation, extractEntryObservation } from "../observation/extract";
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
  const link = closestAcross(element, "a[href]");
  if (link instanceof HTMLAnchorElement) {
    if ((link.target && link.target.toLowerCase() !== "_self") || link.hasAttribute("download"))
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
  const control = closestAcross(element, "button,input");
  const form =
    control instanceof HTMLButtonElement || control instanceof HTMLInputElement
      ? formOf(control)
      : (closestAcross(element, "form") as HTMLFormElement | null);
  if (
    form &&
    ((form.target && form.target.toLowerCase() !== "_self") ||
      (element.getAttribute("formtarget") &&
        element.getAttribute("formtarget")?.toLowerCase() !== "_self"))
  )
    return { reason: "new-context" };
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
        accounts.some((account) => normalized(account) === normalized(username)))
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
  const candidates = controls.filter(
    (candidate) =>
      candidate.target.by !== "href" &&
      (stays
        ? /^(?:yes|はい)$/iu
        : /^(?:continue|continue as .+|next|続行|次へ|.+でログイン)$/iu
      ).test(candidate.label?.trim() ?? ""),
  );
  if (sameAccount && candidates.length === 1 && candidates[0]!.target.by !== "href")
    return { kind: stays ? "stay-signed-in" : "continue", target: candidates[0]!.target };
  return { kind: "unknown" };
}
/** A prepared DOM object is single-use. The background must authorize after intent is durable. */
export function createSsoContent(
  document: Document,
  options: {
    cancelled: () => boolean;
    authorize: (input: { flowId: string; operationId: string; handle: string }) => Promise<boolean>;
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
  ): Promise<SsoInspection | SsoIdpReading | { ok: boolean }> => {
    if (options.cancelled()) {
      prepared.clear();
      return { ok: false, reason: "cancelled" };
    }
    if (command.type === "login.sso.idp") return readSsoIdp(document, command.username);
    if (command.type === "login.sso.commit") {
      const held = prepared.get(command.handle);
      prepared.delete(command.handle);
      if (!held || held.flowId !== command.flowId || held.operationId !== command.operationId)
        return { ok: false, reason: "operation-gone" };
      if (!(await options.authorize(command))) return { ok: false, reason: "not-authorized" };
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
      const pressed = await pressElement(held.element, current);
      return { ok: pressed !== "missed" };
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
