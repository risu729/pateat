import { visible } from "../page/code-submission";
import { queryAll, shadowRootOf } from "../page/shadow";

/**
 * The most letters a confirmation page may show besides its confirmation heading, the
 * account and the controls set aside below, as in "Not you?" or a short footer line. It
 * is a small allowance, not a reading: a phrase this short, such as "Gets your email",
 * still passes, while a sentence or a list of what the app receives does not.
 */
export const CONFIRM_TEXT_LETTERS = 16;
/** The longest label a set-aside control or language picker may carry. */
const CONTROL_LABEL_LETTERS = 24;
/** The most controls besides the pressed one a confirmation's check sets aside. */
const SIDE_CONTROLS = 8;
/** The most elements a confirmation's check reads for text shown outside its own text. */
const READ_ELEMENTS = 4000;
/**
 * What a confirmation's other controls may say: another account, leaving, or the IdP's own
 * footer. A control saying anything else, such as what the app gets, counts as text.
 */
const sideControl =
  /^(?:cancel|back|no|not you\??|use (?:another|a different) account|(?:sign|log) ?in with (?:another|a different) account|switch (?:account|user)s?|(?:sign|log) ?out|help|privacy(?: (?:policy|statement|(?:&|and) cookies))?|terms(?: (?:of (?:use|service)|(?:&|and) conditions))?|cookies?(?: (?:policy|settings))?|legal|accessibility|contact(?: us)?|about|キャンセル|戻る|いいえ|別のアカウント(?:を使用|を使う|でログイン|でサインイン)?|アカウントを切り替え(?:る)?|ログアウト|サインアウト|ヘルプ|プライバシー(?:ポリシー)?|(?:利用)?規約|お問い合わせ)[.?？]?$/iu;
const sideControls = "button,a[href],[role=button],[role=link]";
const languagePickers = "select,[role=combobox],[aria-haspopup=listbox]";
const inputButtons = "input[type=button],input[type=submit],input[type=reset]";
const letters = (text: string) => text.match(/\p{L}/gu)?.length ?? 0;
export const oneLine = (text: string) => text.replace(/\s+/gu, " ").trim();
const occurrences = (text: string, part: string) =>
  part ? text.toLowerCase().split(part.toLowerCase()).length - 1 : 0;
const shownText = (element: Element) =>
  element instanceof HTMLElement ? element.innerText : (element.textContent ?? "");
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
/** A side control or input button whose label offers another account, leaving or help. */
const sideLabelled = (element: HTMLElement, label: string) =>
  visible(element) && sideControl.test(oneLine(label)) && standsAlone(element);
/** Visible letters in a shadow root, which the page's own text never includes. */
function shadowLetters(root: ShadowRoot): number {
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let count = 0;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    // Text right under the root is shown as its host is.
    const parent = node.parentElement ?? root.host;
    if (parent.closest("style,script,noscript,template")) continue;
    if (parent instanceof HTMLElement && !visible(parent)) continue;
    count += letters(node.textContent ?? "");
  }
  return count;
}
/**
 * Whether the page shows letters its own text leaves out: generated `::before` or
 * `::after` content, an open or reachable shadow root, a visible frame, or an input
 * button labelled otherwise than the pressed control or a side control. None of these
 * can be read as the page's text, so a confirmation showing one is no finite step.
 */
function showsTextElsewhere(document: Document, pressed: Element): boolean {
  const elements = queryAll<Element>(document, "*");
  if (elements.length > READ_ELEMENTS) return true;
  const view = document.defaultView;
  for (const element of elements) {
    if (!(element instanceof HTMLElement) || !visible(element)) continue;
    if (element.matches("iframe,frame,object,embed")) return true;
    for (const pseudo of ["::before", "::after"]) {
      const content = view?.getComputedStyle(element, pseudo).content ?? "none";
      if (content !== "none" && content !== "normal" && letters(content)) return true;
    }
    const root = shadowRootOf(element);
    if (root && shadowLetters(root)) return true;
    if (
      element !== pressed &&
      element.matches(inputButtons) &&
      letters((element as HTMLInputElement).value) &&
      !sideLabelled(element, (element as HTMLInputElement).value)
    )
      return true;
  }
  return false;
}
/**
 * The letters a confirmation page shows besides the heading that names it, the account's
 * identifier, the control pressed, a few controls standing alone that offer another
 * account, leaving or the IdP's own help, privacy and terms, and one language picker.
 * Whole elements are set aside, never matching words, so a label inside a sentence keeps
 * the sentence whole; a pressed control with more text than a label sets aside only its
 * label. Fails closed: anything else counts, and text shown outside the page's own text
 * counts as too much.
 */
export function confirmExtraLetters(
  document: Document,
  username: string,
  confirmHeadings: readonly string[],
  pressed: Element,
  pressedLabel: string,
): number {
  const body = document.body?.innerText ?? "";
  if (body.length > 16_384 || showsTextElsewhere(document, pressed)) return Infinity;
  const headings = queryAll<HTMLElement>(document, "h1,h2,[role=heading]").filter(
    (element) => visible(element) && confirmHeadings.includes(oneLine(element.textContent ?? "")),
  );
  const sides = queryAll<HTMLElement>(document, sideControls)
    .filter(
      (element) =>
        element !== pressed &&
        !element.contains(pressed) &&
        sideLabelled(element, element.innerText),
    )
    .slice(0, SIDE_CONTROLS);
  // Only a closed dropdown shows just its chosen language; its other options, which the
  // page's text still holds, are not shown. A list box shows every option, so it counts.
  const picker = queryAll<HTMLElement>(document, languagePickers)
    .filter(
      (element) =>
        visible(element) &&
        (!(element instanceof HTMLSelectElement) || (element.size <= 1 && !element.multiple)) &&
        letters(
          element instanceof HTMLSelectElement
            ? (element.selectedOptions[0]?.text ?? "")
            : element.innerText,
        ) <= CONTROL_LABEL_LETTERS &&
        standsAlone(element),
    )
    .slice(0, 1);
  // The pressed control is set aside whole only when it says no more than a label and the
  // account; otherwise only its label, where its text shows it, is set aside.
  const pressedText = shownText(pressed);
  const whole = letters(pressedText) <= CONTROL_LABEL_LETTERS + letters(username);
  const label = oneLine(pressedLabel);
  const labelLetters =
    !whole && label && oneLine(pressedText).toLowerCase().includes(label.toLowerCase())
      ? letters(label)
      : 0;
  const known = [...new Set([...headings, ...(whole ? [pressed] : []), ...sides, ...picker])];
  // Each element counts once, even when one set aside holds another.
  const texts = known
    .filter((element) => !known.some((other) => other !== element && other.contains(element)))
    .map(shownText);
  const accounts =
    occurrences(body, username) - texts.reduce((sum, text) => sum + occurrences(text, username), 0);
  return (
    letters(body) -
    texts.reduce((sum, text) => sum + letters(text), 0) -
    labelLetters -
    Math.max(0, accounts) * letters(username)
  );
}
