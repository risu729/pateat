// Words in a control's name that an account switch's logout never clicks (ADR 0063): a
// logout of other devices, of every session or account, and a control that deletes,
// closes or cancels the account. Shared by the extension, which reads them before a click,
// and the service, which refuses a model's answer that names such a control. No site is
// named.

/**
 * `other` and the like within three words before a word for a device, session or browser,
 * or `other` before an account; "Sign out and use another account" logs this session out.
 */
const otherWords = new Set(["other", "others", "another"]);
const placeWords = /^(?:devices?|sessions?|browsers?|computers?|phones?|places?|locations?)$/u;
const accountWords = /^(?:accounts?|memberships?|subscriptions?|profiles?|data)$/u;
const elsewherePhrases = /(?:^| )(?:(?:except|but) this|everywhere else)(?: |$)/u;
/** Every session or account at once: "Sign out of all devices", "Log out everywhere". */
const everyWords = /(?:^| )(?:all|every|everywhere|everything|everyone)(?: |$)/u;
const otherPlaces =
  /(?:他|ほか|別)の[^、。]{0,8}?(?:端末|デバイス|セッション|ブラウザ|場所|機器)|(?:他|ほか)の[^、。]{0,8}?アカウント|他端末|以外|すべて|全て|全部|全(?:端末|デバイス|セッション|ブラウザ|機器|アカウント)/u;
/** A verb that ends or erases the account or its data wherever it stands. */
const destroyWords = /(?:^| )(?:delete|deactivate|erase|destroy|terminate|unsubscribe)(?: |$)/u;
/** A verb that ends the account only before an account word, as "Close account". */
const endWords = new Set(["close", "remove", "cancel", "disable", "suspend", "end"]);
const destroyParts = /削除|退会|解約|閉鎖|抹消|消去|無効化|利用停止|アカウント停止/u;

/**
 * What a control's name says beyond logging this session out: `destructive` when it
 * deletes, closes, cancels or deactivates the account or its data, `elsewhere` when it
 * logs other devices, sessions or accounts out, or all of them, else nothing. English words
 * match whole after NFKC and lowercasing, Japanese parts anywhere.
 */
export function logoutRisk(name: string): "destructive" | "elsewhere" | undefined {
  const text = name.normalize("NFKC");
  const words = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
  const list = words.split(" ");
  const ends = list.some(
    (word, index) =>
      endWords.has(word) &&
      list.slice(index + 1, index + 4).some((later) => accountWords.test(later)),
  );
  if (destroyWords.test(words) || ends || destroyParts.test(text)) return "destructive";
  const elsewhere =
    list.some((word, index) => {
      if (!otherWords.has(word)) return false;
      const next = list.slice(index + 1, index + 4);
      return (
        next.some((later) => placeWords.test(later)) ||
        (word !== "another" && next.some((later) => accountWords.test(later)))
      );
    }) ||
    elsewherePhrases.test(words) ||
    everyWords.test(words) ||
    otherPlaces.test(text);
  return elsewhere ? "elsewhere" : undefined;
}

/**
 * Whether an account switch may click a control of this name for `purpose` (ADR 0063):
 * never one that is `destructive`, and a logout or confirmation never one that logs out
 * `elsewhere`; a menu's name may say "all", as "All services".
 */
export function safeLogoutName(name: string, purpose: "menu" | "logout" | "confirm"): boolean {
  const risk = logoutRisk(name);
  return risk === undefined || (risk === "elsewhere" && purpose === "menu");
}
