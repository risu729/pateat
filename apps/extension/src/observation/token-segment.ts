// Imports nothing, so Pateat's page-world passkey script can redact paths with it too.

/**
 * True for a run whose letters and digits, ignoring `-` and `_`, switch between digits,
 * lower case and upper case at least once every three or so characters, as a random
 * base64url token does and a slug such as `campaign-2024-summer-login` does not.
 */
function scrambled(run: string): boolean {
  const kinds = [...run.replace(/[-_]/gu, "")].map((character) =>
    /\d/u.test(character) ? 0 : /[a-z]/u.test(character) ? 1 : 2,
  );
  const changes = kinds.filter((kind, at) => at > 0 && kind !== kinds[at - 1]).length;
  return changes >= run.length * 0.3;
}

/**
 * True for a path segment that may carry a session ID, a tenant or account ID or another
 * token, which an observation would otherwise send to the service and its request log: as
 * it is or percent-decoded up to three times, it holds a matrix parameter such as
 * `;jsessionid=`, an ASP.NET cookieless part such as `(S(lit3py55t21z5))`, a query such
 * as Magento's base64-encoded `referer/<URL with ?SID=...>` (`?`, `&` or `=`), an email
 * address such as `taro.yamada@example.com` (`@` after another character and before a
 * dot and a letter, so `@handle` and `pkg@1.2.3` are not), a UUID, a
 * run of 16 or more letters and digits that contains a digit, or a run of 16 or more
 * letters, digits, `-` and `_` that contains a digit and switches between them as often
 * as a base64url token does. Short or plain-looking tokens are missed. The same test
 * keeps such a value out of a locator where `locate` asks for it.
 */
export function tokenSegment(raw: string): boolean {
  const forms = [raw];
  for (let round = 0; round < 3; round += 1) {
    try {
      const decoded = decodeURIComponent(forms.at(-1)!);
      if (decoded === forms.at(-1)) break;
      forms.push(decoded);
    } catch {
      // A malformed escape is checked as it is.
      break;
    }
  }
  return forms.some(
    (segment) =>
      /[;?&=]|\([A-Z]\(|[^@]@[^@]*\.\p{L}/u.test(segment) ||
      /[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}/iu.test(segment) ||
      (segment.match(/[A-Za-z\d]{16,}/gu) ?? []).some((run) => /\d/u.test(run)) ||
      (segment.match(/[\w-]{16,}/gu) ?? []).some((run) => /\d/u.test(run) && scrambled(run)),
  );
}

/** `pathname` with each segment that may carry a token (`tokenSegment`) replaced by `marker`. */
export const redactPath = (pathname: string, marker: string): string =>
  pathname
    .split("/")
    .map((segment) => (tokenSegment(segment) ? marker : segment))
    .join("/");
