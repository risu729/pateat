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
/**
 * The most letters a confirmation page may show besides its confirmation heading, the
 * account and the controls set aside below, as in "Not you?" or a short footer line. More
 * says something else about the step, such as what the app receives, so the page is no
 * finite step.
 */
const CONFIRM_TEXT_LETTERS = 16;
/** The longest label a set-aside control or language picker may carry. */
const CONTROL_LABEL_LETTERS = 24;
/** The most controls besides the pressed one a confirmation's check sets aside. */
const SIDE_CONTROLS = 8;
/**
 * What a confirmation's other controls may say: another account, leaving, or the IdP's own
 * footer. A control saying anything else, such as what the app gets, counts as text.
 */
const sideControl =
  /^(?:cancel|back|no|not you\??|use (?:another|a different) account|(?:sign|log) ?in with (?:another|a different) account|switch (?:account|user)s?|(?:sign|log) ?out|help|privacy(?: (?:policy|statement|(?:&|and) cookies))?|terms(?: (?:of (?:use|service)|(?:&|and) conditions))?|cookies?(?: (?:policy|settings))?|legal|accessibility|contact(?: us)?|about|キャンセル|戻る|いいえ|別のアカウント(?:を使用|を使う|でログイン|でサインイン)?|アカウントを切り替え(?:る)?|ログアウト|サインアウト|ヘルプ|プライバシー(?:ポリシー)?|(?:利用)?規約|お問い合わせ)[.?？]?$/iu;
const sideControls = "button,a[href],[role=button],[role=link]";
const languagePickers = "select,[role=combobox],[aria-haspopup=listbox]";
const letters = (text: string) => text.match(/\p{L}/gu)?.length ?? 0;
const oneLine = (text: string) => text.replace(/\s+/gu, " ").trim();
const occurrences = (text: string, part: string) =>
  part ? text.toLowerCase().split(part.toLowerCase()).length - 1 : 0;
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
/**
 * Whether a control stands on its own rather than inside a sentence: no text beside it in
 * its line, outside other controls, up to the nearest block around it.
 */
function standsAlone(element: HTMLElement): boolean {
  let child: Element = element;
  for (let parent = element.parentElement; parent; parent = parent.parentElement) {
    for (const node of parent.childNodes) {
      if (node === child) continue;
      if (node.nodeType === Node.TEXT_NODE && letters(node.textContent ?? "")) return false;
      if (
        node instanceof HTMLElement &&
        visible(node) &&
        !node.matches(sideControls) &&
        getComputedStyle(node).display.startsWith("inline") &&
        letters(node.innerText)
      )
        return false;
    }
    if (!getComputedStyle(parent).display.startsWith("inline")) return true;
    child = parent;
  }
  return true;
}
/**
 * The letters a confirmation page shows besides the heading that names it, the account's
 * identifier, the control pressed, a few controls standing alone that offer another
 * account, leaving or the IdP's own help, privacy and terms, and one language picker.
 * Whole elements are set aside, never matching words, so a label inside a sentence keeps
 * the sentence whole. Fails closed: anything else counts.
 */
function confirmExtraLetters(
  document: Document,
  username: string,
  confirmHeadings: readonly string[],
  pressed: Element,
): number {
  const body = document.body?.innerText ?? "";
  if (body.length > 16_384) return Infinity;
  const headings = queryAll<HTMLElement>(document, "h1,h2,[role=heading]").filter(
    (element) => visible(element) && confirmHeadings.includes(oneLine(element.textContent ?? "")),
  );
  const sides = queryAll<HTMLElement>(document, sideControls)
    .filter(
      (element) =>
        element !== pressed &&
        !element.contains(pressed) &&
        visible(element) &&
        sideControl.test(oneLine(element.innerText)) &&
        standsAlone(element),
    )
    .slice(0, SIDE_CONTROLS);
  const picker = queryAll<HTMLElement>(document, languagePickers)
    .filter(
      (element) =>
        visible(element) &&
        // A select shows only its chosen language; its other options are not a sentence.
        letters(
          element instanceof HTMLSelectElement
            ? (element.selectedOptions[0]?.text ?? "")
            : element.innerText,
        ) <= CONTROL_LABEL_LETTERS &&
        standsAlone(element),
    )
    .slice(0, 1);
  const known = [...new Set([...headings, pressed, ...sides, ...picker])];
  // Each element counts once, even when one set aside holds another.
  const texts = known
    .filter((element) => !known.some((other) => other !== element && other.contains(element)))
    .map((element) =>
      element instanceof HTMLElement ? element.innerText : (element.textContent ?? ""),
    );
  const accounts =
    occurrences(body, username) - texts.reduce((sum, text) => sum + occurrences(text, username), 0);
  return (
    letters(body) -
    texts.reduce((sum, text) => sum + letters(text), 0) -
    Math.max(0, accounts) * letters(username)
  );
}
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
/**
 * Generic finite IdP pages; no provider catalogue and no consent-as-continue rule. A
 * finite step needs a page whose own title or heading names it: an account list, an
 * account confirmation or a stay-signed-in question, with no sharing or access wording.
 */
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
  if (!stays && !step.confirms.length) return { kind: "unknown" };
  const candidates = controls.filter((candidate) => {
    if (candidate.target.by === "href") return false;
    const label = candidate.label?.trim() ?? "";
    if (stays) return /^(?:yes|はい)$/iu.test(label);
    if (/^(?:continue|next|続行|次へ)$/iu.test(label)) return true;
    const named = /^continue as (.+)$/iu.exec(label)?.[1] ?? /^(.+)でログイン$/u.exec(label)?.[1];
    return named !== undefined && normalized(named) === normalized(username);
  });
  if (!sameAccount || candidates.length !== 1 || candidates[0]!.target.by === "href")
    return { kind: "unknown" };
  const target = candidates[0]!.target;
  const pressed = findTargets(document, target, { links: true });
  // A confirmation says nothing but which account continues: any other text may be what
  // the app receives, whatever its wording, so it is no finite step.
  if (
    !stays &&
    (pressed.length !== 1 ||
      confirmExtraLetters(document, username, step.confirms, pressed[0]!) > CONFIRM_TEXT_LETTERS)
  )
    return { kind: "unknown" };
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
      idp?: SsoIdpExpectation;
      expiresAt: number;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  const clearPrepared = () => {
    for (const held of prepared.values()) {
      clearTimeout(held.timer);
      if (held.idp) held.idp.username = "";
    }
    prepared.clear();
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
    if (command.type === "login.sso.commit") {
      const held = prepared.get(command.handle);
      prepared.delete(command.handle);
      if (!held || held.flowId !== command.flowId || held.operationId !== command.operationId)
        return { ok: false, reason: "operation-gone" };
      try {
        if (!(await options.authorize({ ...command, phase: "pointer" })))
          return { ok: false, reason: "not-authorized" };
        const current = () => {
          if (
            options.cancelled() ||
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
        if (!(await options.authorize({ ...command, phase: "click" })) || !current())
          return { ok: false, reason: "not-authorized" };
        HTMLElement.prototype.click.call(held.element);
        return { ok: true };
      } finally {
        clearTimeout(held.timer);
        if (held.idp) held.idp.username = "";
      }
    }
    const found = inspected(document, command.target);
    if ("reason" in found) return { ok: false, reason: found.reason };
    if (command.type === "login.sso.inspect")
      return { ok: true, url: document.URL, destinations: found.destinations };
    if (command.idp && !idpCurrent(document, command.target, command.idp))
      return { ok: false, reason: "idp-identity-changed" };
    clearPrepared();
    const handle = newId();
    const idp = command.idp ? { ...command.idp } : undefined;
    prepared.set(handle, {
      ...found,
      flowId: command.flowId,
      operationId: command.operationId,
      target: command.target,
      url: document.URL,
      ...(idp ? { idp } : {}),
      expiresAt: Date.now() + 30_000,
      timer: setTimeout(() => {
        if (idp) idp.username = "";
        prepared.delete(handle);
      }, 30_000),
    });
    return { ok: true, url: document.URL, destinations: found.destinations, handle };
  };
}
