import { sameLoginTarget, type LoginTarget } from "@pateat/contracts";
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
import { CONFIRM_TEXT_LETTERS, confirmExtraLetters, oneLine } from "./content-sso-confirm";
import type {
  SsoContentCommand,
  SsoInspection,
  SsoIdpReading,
  SsoIdpExpectation,
} from "./sso-operation-wire";

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
/**
 * Wording that shares an account with another app or grants it access, in any tense or
 * order (ADR 0026): an IdP page that shows it is never a finite step to press through.
 */
const sharing =
  /(?:\bshar(?:e|es|ed|ing)\b|\bwants? (?:to )?access\b|\baccess(?:es)? (?:to )?your\b|\ballow(?:s|ed|ing)?\b[^.!?\n]{0,80}?\bto\b|\bto continue to\b|^(?:continue|proceed) to\b|\b(?:can|will be able to) (?:see|access|read|view|manage|edit|delete)\b|\bsee your\b|\bpermissions?\b|\bconsent\b|\bauthori[sz]e\b|\bgrant(?:s|ed)?\b|\bscopes?\b|\bthird[- ]party\b|\breceiv(?:e|es|ed|ing)\b|\bprovid(?:e|es|ed|ing)\b|\bsen(?:d|ds|t|ding)\b|\bget(?:s|ting)? access\b|共有|許可|権限|同意|連携|取得|受け取|提供|送信|アクセス(?:を|が|でき|しよう|する)|(?:に|へ)移動)/imu;
// The page's own title or heading must say what the step is; a button label alone never does.
const chooserHeading =
  /^(?:(?:choose|pick|select) (?:an|your) account|アカウントを選択(?:してください)?|アカウントの選択)[.?？]?$/iu;
const stayHeading =
  /^(?:stay signed in|keep (?:me|you) signed in|サインインの状態を維持しますか|ログイン状態を(?:保持|維持)(?:しますか)?)[?？]?$/iu;
const confirmHeading =
  /^(?:confirm (?:your|this) account|is this (?:you|your account)|continue as (.+)|アカウントの確認|このアカウントで(?:続行|ログイン)(?:しますか)?|(.+)として続行)[.?？!]?$/iu;
/** The page's title and visible headings, each as one trimmed line. */
const headingsOf = (document: Document) =>
  [
    document.title,
    ...queryAll<HTMLElement>(document, "h1,h2,[role=heading]")
      .filter(visible)
      .slice(0, 8)
      .map((element) => element.textContent ?? ""),
  ]
    .map(oneLine)
    .filter(Boolean);
/** What the IdP page's own headings say it is, read only for a finite step. */
function idpStep(document: Document, username: string) {
  const headings = headingsOf(document);
  const body = document.body?.innerText.slice(0, 16_384) ?? "";
  return {
    sharing: [...headings, body].some((text) => sharing.test(text)),
    chooser: headings.some((text) => chooserHeading.test(text)),
    stays: headings.some((text) => stayHeading.test(text)),
    /** The headings that name an account confirmation for this account. */
    confirms: headings.filter((text) => {
      const match = confirmHeading.exec(text);
      const named = match?.[1] ?? match?.[2];
      return match !== null && (named === undefined || normalized(named) === normalized(username));
    }),
  };
}
/** Anything a page offers the person to choose or type, or a frame that may hold one. */
const CONTROLS =
  "button,a[href],input:not([type=hidden]),select,textarea,summary,iframe,frame,[role=button],[role=link],[role=menuitem],[role=option],[role=radio],[role=checkbox],[role=switch],[role=tab],[contenteditable=true]";
/**
 * Whether an IdP page offers the person anything to choose, read from the whole page
 * whatever its observation says (ADR 0026, amendment of 2026-11-18).
 */
export const offersControls = (document: Document) =>
  queryAll<HTMLElement>(document, CONTROLS).some((element) => {
    if (!visible(element)) return false;
    // A control without an area, as a tracking frame of no size, offers nothing.
    const box = element.getBoundingClientRect();
    return box.width > 0 && box.height > 0;
  });
/**
 * Generic finite IdP pages; no provider catalogue and no consent-as-continue rule. A
 * finite step needs a page whose own title or heading names it: an account list, an
 * account confirmation or a stay-signed-in question, with no sharing or access wording.
 */
export function readSsoIdp(document: Document, username: string): SsoIdpReading {
  if (ssoUnsafePage(document)) return { kind: "unsafe", reason: "permission-or-account-creation" };
  let observation = extractSignedInObservation(document);
  if (!observation.ok) observation = extractEntryObservation(document);
  if (!observation.ok || !observation.observation.complete)
    return { kind: "unknown", controls: offersControls(document) };
  if (extractPasskeyObservation(document).ok) return { kind: "native" };
  const page = observation.observation;
  if (
    page.candidates.some((candidate) =>
      ["text", "email", "tel", "number", "password"].includes(candidate.role),
    )
  )
    return { kind: "native" };
  const step = idpStep(document, username);
  // A list or question that names a destination app shares the account with it.
  if (step.sharing) return { kind: "unsafe", reason: "permission-or-account-creation" };
  const controls = page.candidates.filter(
    (candidate) => candidate.role === "button" || candidate.role === "link",
  );
  const exact = controls.filter((candidate) => {
    const matches = findTargets(document, candidate.target, { links: true });
    if (matches.length !== 1) return false;
    // The rendered text, so the lines of an account tile (a name, the account and its
    // state) stay apart rather than running into one token.
    const element = matches[0]!;
    const text = (element instanceof HTMLElement ? element.innerText : element.textContent) ?? "";
    const accounts = exactAccounts(text);
    return (
      !/[*●•]/u.test(text) &&
      (normalized(text) === normalized(username) ||
        (accounts.length === 1 && normalized(accounts[0]!) === normalized(username)))
    );
  });
  if (exact.length === 1 && exact[0]!.target.by !== "href" && step.chooser)
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
  const { stays } = step;
  if (!stays && !step.confirms.length)
    return { kind: "unknown", controls: offersControls(document) };
  const candidates = controls.filter((candidate) => {
    if (candidate.target.by === "href") return false;
    const label = candidate.label?.trim() ?? "";
    if (stays) return /^(?:yes|はい)$/iu.test(label);
    if (/^(?:continue|next|続行|次へ)$/iu.test(label)) return true;
    const named = /^continue as (.+)$/iu.exec(label)?.[1] ?? /^(.+)でログイン$/u.exec(label)?.[1];
    return named !== undefined && normalized(named) === normalized(username);
  });
  if (!sameAccount || candidates.length !== 1 || candidates[0]!.target.by === "href")
    return { kind: "unknown", controls: offersControls(document) };
  const target = candidates[0]!.target;
  const pressed = findTargets(document, target, { links: true });
  // A confirmation says nothing but which account continues: any other text may be what
  // the app receives, whatever its wording, so it is no finite step.
  if (
    !stays &&
    (pressed.length !== 1 ||
      confirmExtraLetters(
        document,
        username,
        step.confirms,
        pressed[0]!,
        candidates[0]!.label ?? "",
      ) > CONFIRM_TEXT_LETTERS)
  )
    return { kind: "unknown", controls: offersControls(document) };
  return { kind: stays ? "stay-signed-in" : "continue", target };
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
function idpCurrent(document: Document, target: LoginTarget, expected: SsoIdpExpectation): boolean {
  const current = readSsoIdp(document, expected.username);
  return (
    current.kind === expected.kind && "target" in current && sameLoginTarget(current.target, target)
  );
}
/**
 * A prepared DOM object is single-use. The background must authorize after intent is durable.
 * The same reading and press answer a native login's stay-signed-in question after it sent
 * its credential (ADR 0065 amendment of 2026-11-22): `login.stay.prepare` reads the page
 * with `readSsoIdp` and prepares only its `stay-signed-in` target, and `login.stay.commit`
 * presses it under the same checks, with the worker's `authorizeStay` before the pointer
 * events and the click, at most once in this document and never for a native attempt the
 * SSO coordinator cancelled here (`attemptCancelled`).
 */
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
    /** The worker's authorization of a stay-signed-in press's phase; none refuses it. */
    authorizeStay?: (input: {
      attemptId: string;
      operationId: string;
      handle: string;
      phase: "pointer" | "click";
    }) => Promise<boolean>;
    /** Whether the SSO coordinator cancelled this native attempt in the document. */
    attemptCancelled?: (attemptId: string) => boolean;
  },
) {
  type Held = {
    flowId: string;
    operationId: string;
    target: LoginTarget;
    element: HTMLElement;
    url: string;
    destinations: string[];
    idp?: SsoIdpExpectation;
    /** A native login's stay-signed-in press, whose `flowId` is its attempt's ID. */
    stay?: true;
    expiresAt: number;
    timer: ReturnType<typeof setTimeout>;
  };
  const prepared = new Map<string, Held>();
  // A stay-signed-in question is pressed once in a document, whatever the worker asks.
  let stayPressed = false;
  const clearPrepared = () => {
    for (const held of prepared.values()) {
      clearTimeout(held.timer);
      if (held.idp) held.idp.username = "";
    }
    prepared.clear();
  };
  /**
   * Holds `found` for one commit within 30 seconds, under a new handle. A stay-signed-in
   * preparation and an SSO one in the same document clear each other's handle here.
   */
  const hold = (
    found: { element: HTMLElement; destinations: string[] },
    entry: Omit<Held, "element" | "destinations" | "url" | "expiresAt" | "timer">,
  ) => {
    clearPrepared();
    const handle = newId();
    const { idp } = entry;
    prepared.set(handle, {
      ...found,
      ...entry,
      url: document.URL,
      expiresAt: Date.now() + 30_000,
      timer: setTimeout(() => {
        if (idp) idp.username = "";
        prepared.delete(handle);
      }, 30_000),
    });
    return { ok: true as const, url: document.URL, destinations: found.destinations, handle };
  };
  /**
   * Presses a prepared target: each check runs again before the pointer events, after
   * them and before the click, and `authorize` is asked before each phase.
   */
  const press = async (
    held: Held,
    authorize: (phase: "pointer" | "click") => Promise<boolean>,
  ): Promise<{ ok: boolean; reason?: string }> => {
    try {
      if (!(await authorize("pointer"))) return { ok: false, reason: "not-authorized" };
      const current = () => {
        if (
          options.cancelled() ||
          (held.stay && options.attemptCancelled?.(held.flowId)) ||
          document.URL !== held.url ||
          Date.now() >= held.expiresAt ||
          (held.idp && !idpCurrent(document, held.target, held.idp))
        )
          return false;
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
      if (!(await authorize("click")) || !current()) return { ok: false, reason: "not-authorized" };
      HTMLElement.prototype.click.call(held.element);
      return { ok: true };
    } finally {
      clearTimeout(held.timer);
      if (held.idp) held.idp.username = "";
    }
  };
  return async (
    command: SsoContentCommand,
  ): Promise<
    SsoInspection | SsoIdpReading | { ok: boolean } | ReturnType<typeof readSsoReturn>
  > => {
    if (options.cancelled()) {
      clearPrepared();
      return { ok: false, reason: "cancelled" };
    }
    if (command.type === "login.sso.return") return readSsoReturn(document, command.username);
    if (command.type === "login.sso.idp") return readSsoIdp(document, command.username);
    if (command.type === "login.stay.prepare") {
      const idp = { username: command.username, kind: "stay-signed-in" as const };
      command.username = "";
      if (stayPressed || options.attemptCancelled?.(command.attemptId)) {
        idp.username = "";
        return { ok: false, reason: stayPressed ? "already-pressed" : "cancelled" };
      }
      const reading = readSsoIdp(document, idp.username);
      const found =
        reading.kind === "stay-signed-in" ? inspected(document, reading.target) : undefined;
      if (reading.kind !== "stay-signed-in" || !found || "reason" in found) {
        idp.username = "";
        return {
          ok: false,
          reason: found && "reason" in found ? found.reason : `idp-${reading.kind}`,
        };
      }
      return hold(found, {
        flowId: command.attemptId,
        operationId: command.operationId,
        target: reading.target,
        idp,
        stay: true,
      });
    }
    if (command.type === "login.sso.commit" || command.type === "login.stay.commit") {
      const stay = command.type === "login.stay.commit";
      const flowId = command.type === "login.stay.commit" ? command.attemptId : command.flowId;
      const held = prepared.get(command.handle);
      prepared.delete(command.handle);
      if (
        !held ||
        held.flowId !== flowId ||
        held.operationId !== command.operationId ||
        (held.stay === true) !== stay ||
        (stay && stayPressed)
      )
        return { ok: false, reason: "operation-gone" };
      if (command.type === "login.sso.commit")
        return press(held, (phase) => options.authorize({ ...command, phase }));
      // Spent before the press, so a press the page stopped is never tried again here.
      stayPressed = true;
      const { authorizeStay } = options;
      return press(held, async (phase) =>
        authorizeStay
          ? authorizeStay({
              attemptId: command.attemptId,
              operationId: command.operationId,
              handle: command.handle,
              phase,
            })
          : false,
      );
    }
    const found = inspected(document, command.target);
    if ("reason" in found) return { ok: false, reason: found.reason };
    if (command.type === "login.sso.inspect")
      return { ok: true, url: document.URL, destinations: found.destinations };
    if (command.idp && !idpCurrent(document, command.target, command.idp))
      return { ok: false, reason: "idp-identity-changed" };
    return hold(found, {
      flowId: command.flowId,
      operationId: command.operationId,
      target: command.target,
      ...(command.idp ? { idp: { ...command.idp } } : {}),
    });
  };
}
