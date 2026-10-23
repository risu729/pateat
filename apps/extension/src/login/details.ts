import {
  getItemEligibility,
  itemAsksForMasterPassword,
  resolveDetailSourceField,
  type DatePart,
  type DetailField,
  type DetailFormat,
  type DetailPart,
  type DetailLink,
  type LocalSettings,
  type LoginDetail,
  type VaultCatalog,
  type VaultConnectionMetadata,
  type VaultItemMetadata,
} from "@pateat/contracts";
import type { CardBrand } from "../page/card-hints";
import type { LoginSecretKind } from "./wire";

// Personal details asked during a login (ADR 0061): which vault fields may give each
// detail, the owner's links to them, and the value a page wants made from a field's
// value. Values are made here, in the service worker, right after the vault read, so a
// whole phone number never reaches the page, nor a whole card number except for a
// `card-number` input, and a value split over several inputs reaches it only as its
// parts: a date's year, month and day, or a card number's or PIN's digit groups.

/** The login item a link belongs to: its site and its vault account and item. */
export type DetailOwner = Pick<DetailLink, "origin" | "provider" | "userId" | "itemId">;

/** The built-in fields each detail may be read from; custom fields are checked by kind. */
const builtinSources: Readonly<Record<LoginDetail, readonly string[]>> = {
  "birth-date": [],
  "phone-last-4": ["identity.phone"],
  "card-last-4": ["card.number"],
  "card-code": ["card.code"],
  "card-number": ["card.number"],
  // The expiry's month names the link; its year is read from the same card item.
  "card-expiry": ["card.expMonth"],
  pin: [],
  "secret-answer": [],
  "member-id": [],
};
/** Custom field names that read as a birth date, compared without case. */
const birthWords = ["birth", "dob", "生年月日", "誕生日"];
/**
 * A custom field name that reads as a PIN, after NFKC and without case: `pin` as a word of
 * its own (so not "shipping"), `暗証` or `passcode`.
 */
const pinName = /(?:^|[^a-z])pin(?:$|[^a-z])|暗証|passcode/u;
/** The details read only from a card item's built-in fields. */
const cardDetails: readonly LoginDetail[] = [
  "card-last-4",
  "card-code",
  "card-number",
  "card-expiry",
];
/** Custom field names that read as a member or customer number, compared without case. */
const memberWords = ["id", "number", "no", "番号", "会員", "お客様", "customer", "member", "契約"];
/**
 * Names that read as a PIN, password, code or card value, which a member ID never is,
 * even when they also hold one of `memberWords` (暗証番号, PIN number, card number).
 */
const notMemberWords = [
  "暗証",
  "pin",
  "pass",
  "パスワード",
  "code",
  "コード",
  "card",
  "カード",
  "phone",
  "電話",
  "hidden",
  "note",
];
/** The details read only from the login item's own custom fields (ADR 0061). */
export const ownItemDetails: readonly LoginDetail[] = ["secret-answer", "member-id"];

/** Whether an item is a card: it has a card's built-in fields. */
const isCard = (item: Pick<VaultItemMetadata, "fields">) =>
  item.fields.some((field) => field.id.startsWith("card."));

/**
 * Whether `detail` may be read from `item` for the login item `loginItemId` (ADR 0061): an
 * answer or member ID only from the login item; a PIN, a credential of one account, only
 * from the login item or a card item, never an identity or another login item; any other
 * detail from any item.
 */
export function readsFrom(
  detail: LoginDetail,
  item: Pick<VaultItemMetadata, "id" | "fields">,
  loginItemId: string,
): boolean {
  if (ownItemDetails.includes(detail)) return item.id === loginItemId;
  if (detail === "pin") return item.id === loginItemId || isCard(item);
  return true;
}

/**
 * Where a detail is read (ADR 0061, decided by the owner 2026-10-23 21:50 UTC): the page's
 * URL, and whether this login already holds the master password for the vault account,
 * typed in Pateat's chooser window before it started or before a detail was read.
 */
export type DetailSite = { url: string; verified: boolean };

/**
 * Whether the master password has to be asked before a detail is read from `item`: an
 * item other than the login item `loginItemId`, as an identity or a card, with Bitwarden's
 * re-prompt on a site in `repromptSites`, while the login does not hold the password yet.
 * The login item's own answers and member IDs are read as its login is, which started
 * only after the password.
 */
export function waitsForMasterPassword(
  settings: LocalSettings,
  item: Pick<VaultItemMetadata, "id" | "reprompt">,
  loginItemId: string,
  site: DetailSite,
): boolean {
  return (
    item.id !== loginItemId && !site.verified && itemAsksForMasterPassword(settings, item, site.url)
  );
}

/**
 * Whether `field` of an item may give `detail`: a built-in source, or a Text or Hidden
 * custom field whose name says it holds the detail, a birth date's, a phone number's or a
 * PIN's. A field named as a PIN gives no other detail but an answer named after its
 * question, so a link never reads a PIN into a birth date's, phone number's or member ID's
 * input.
 */
export function givesDetail(
  detail: LoginDetail,
  field: VaultItemMetadata["fields"][number],
): boolean {
  if (builtinSources[detail].includes(field.id)) return true;
  if (cardDetails.includes(detail)) return false;
  if (!field.id.startsWith("custom.") || (field.kind !== "text" && field.kind !== "hidden"))
    return false;
  const name = field.name?.normalize("NFKC").toLowerCase() ?? "";
  // A secret question's answer is in a field named after its question, checked against
  // the page's own question before any fill.
  if (detail === "secret-answer") return name.length > 0;
  if (detail === "member-id")
    return (
      memberWords.some((word) => name.includes(word)) &&
      !notMemberWords.some((word) => name.includes(word))
    );
  if (detail === "pin") return pinName.test(name);
  if (pinName.test(name)) return false;
  return detail === "birth-date"
    ? birthWords.some((word) => name.includes(word))
    : /phone|tel|電話/u.test(name);
}

/** The ASCII digits of a value, after NFKC so full-width digits count. */
const digitsOf = (value: string) => value.normalize("NFKC").replace(/[^0-9]/gu, "");

/** A stored birth date's year, month and day, or undefined when the text is no date. */
export function readBirthDate(
  value: string,
): { year: number; month: number; day: number } | undefined {
  const text = value.normalize("NFKC").trim();
  const match =
    /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/u.exec(text) ??
    /^(\d{4})年\s*(\d{1,2})月\s*(\d{1,2})日$/u.exec(text) ??
    /^(\d{4})(\d{2})(\d{2})$/u.exec(text);
  if (!match) return undefined;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
    ? { year, month, day }
    : undefined;
}

/**
 * The fields a linked detail's value is made from: the link's field, and for a card's
 * expiry date, whose link names its month, the same card's year after it.
 */
export function detailFieldIds(detail: LoginDetail, fieldId: string): string[] {
  return detail === "card-expiry" ? [fieldId, "card.expYear"] : [fieldId];
}

/** A card's expiry month (1 to 12) and four-digit year, or undefined when either is not one. */
function readExpiry(month: string, year: string): { month: string; year: string } | undefined {
  const monthDigits = digitsOf(month);
  const yearDigits = digitsOf(year);
  const number = Number(monthDigits);
  if (!/^\d{1,2}$/u.test(monthDigits) || number < 1 || number > 12) return undefined;
  // A two-digit year is in this century, as card years are.
  const full = /^\d{2}$/u.test(yearDigits)
    ? `20${yearDigits}`
    : /^\d{4}$/u.test(yearDigits)
      ? yearDigits
      : undefined;
  return full ? { month: String(number).padStart(2, "0"), year: full } : undefined;
}

/**
 * The value a page's input wants for `detail`, made from the linked field's value (and,
 * for a card's expiry date, `cardYear`, its card's year): the date in `format`, the last four
 * digits, a card code of 3 or 4 digits as it is, a card number's 12 to 19 digits or a
 * PIN's 4 to 12, written as digits alone with optional spaces or hyphens, or an answer
 * (up to 128 characters) or member ID (up to 64) trimmed.
 * Undefined when the value is no date, has too few or too many digits, or is empty or too
 * long.
 */
export function detailValue(
  detail: LoginDetail,
  format: DetailFormat | undefined,
  value: string,
  cardYear?: string,
): string | undefined {
  if (detail === "card-expiry") {
    const expiry = cardYear === undefined ? undefined : readExpiry(value, cardYear);
    if (!expiry) return undefined;
    const short = expiry.year.slice(2);
    const made: Partial<Record<DetailFormat, string>> = {
      mmyy: `${expiry.month}${short}`,
      "mm/yy": `${expiry.month}/${short}`,
      mmyyyy: `${expiry.month}${expiry.year}`,
      "mm/yyyy": `${expiry.month}/${expiry.year}`,
    };
    return format === undefined ? undefined : made[format];
  }
  if (detail === "birth-date") {
    const date = readBirthDate(value);
    if (!date || !format) return undefined;
    const year = String(date.year);
    const month = String(date.month).padStart(2, "0");
    const day = String(date.day).padStart(2, "0");
    const made: Partial<Record<DetailFormat, string>> = {
      yyyymmdd: `${year}${month}${day}`,
      yyyymm: `${year}${month}`,
      "yyyy-mm-dd": `${year}-${month}-${day}`,
      "yyyy/mm/dd": `${year}/${month}/${day}`,
      mmdd: `${month}${day}`,
    };
    return made[format];
  }
  if (detail === "secret-answer" || detail === "member-id") {
    const text = value.trim();
    return text.length >= 1 && text.length <= (detail === "secret-answer" ? 128 : 64)
      ? text
      : undefined;
  }
  if (detail === "card-number" || detail === "pin") {
    // Digits alone, perhaps grouped by spaces or hyphens: any other text, such as a note
    // beside the number, is no value.
    const text = value.normalize("NFKC").trim();
    if (!/^[0-9]+(?:[ -]+[0-9]+)*$/u.test(text)) return undefined;
    const grouped = text.replace(/[ -]/gu, "");
    return (detail === "pin" ? /^\d{4,12}$/u : /^\d{12,19}$/u).test(grouped) ? grouped : undefined;
  }
  const digits = digitsOf(value);
  if (detail === "card-code") return /^\d{3,4}$/u.test(digits) ? digits : undefined;
  return digits.length >= 4 ? digits.slice(-4) : undefined;
}

/**
 * Which inputs a detail's value may fill (`acceptsSecret`): a card's security code, its
 * whole number and a PIN each by their own rule; a question's answer is filled as
 * `answer` with its question, and every other detail as `detail`.
 */
export function detailSecret(
  detail: Exclude<LoginDetail, "secret-answer">,
): Extract<LoginSecretKind, "card-code" | "card-number" | "pin" | "detail"> {
  return detail === "card-code" || detail === "card-number" || detail === "pin" ? detail : "detail";
}

/** One value a `detail` fill types or chooses, and which inputs it may go into. */
export type DetailFillValue = {
  value: string;
  secret: LoginSecretKind;
  /**
   * A digit group's input's `maxlength`: the group's length, or, for the last group, the
   * length its input declared when its digits are fewer.
   */
  group?: number;
  /** A split date's part, whose range a select's option values must lie in. */
  part?: DatePart;
  /** A card expiry year, which a select may write with two or four digits. */
  shortYear?: true;
};

/** A split date's part as its format writes it: `yyyy` or `yy`, `mm` or `m`, `dd` or `d`. */
function datePartText(
  date: { year: string; month: number; day: number },
  part: DatePart,
  format: DetailPart["format"],
): string | undefined {
  if (part === "year") return format === "yy" ? date.year.slice(-2) : date.year;
  const number = part === "month" ? date.month : date.day;
  return format === "m" || format === "d" ? String(number) : String(number).padStart(2, "0");
}

/**
 * The values a `detail` field's inputs want, in their order (ADR 0061), made from the
 * linked field's value (and, for a card's expiry date, `cardYear`): one input's value as
 * `detailValue` makes it, or one per part of a split value: a date's year, month and day
 * each in its part's format, chosen in a select by that number; a card number's or PIN's
 * digits cut into its groups' lengths, every group but the last exactly and the last
 * with the digits left, at least one and at most its length. Undefined when the value is
 * unreadable or the field is a secret question's, whose answer goes with its question;
 * `unfit` when a readable card number's or PIN's digits do not fit its groups.
 */
export function detailFieldValues(
  field: DetailField,
  value: string,
  cardYear?: string,
): DetailFillValue[] | "unfit" | undefined {
  if (field.detail === "secret-answer") return undefined;
  if (!("parts" in field)) {
    const made = detailValue(field.detail, field.format, value, cardYear);
    return made === undefined ? undefined : [{ value: made, secret: detailSecret(field.detail) }];
  }
  if (field.detail === "birth-date" || field.detail === "card-expiry") {
    const read = field.detail === "birth-date" ? readBirthDate(value) : undefined;
    const expiry =
      field.detail === "card-expiry" && cardYear !== undefined
        ? readExpiry(value, cardYear)
        : undefined;
    const date = read
      ? { year: String(read.year), month: read.month, day: read.day }
      : expiry && { year: expiry.year, month: Number(expiry.month), day: 0 };
    if (!date) return undefined;
    const made: DetailFillValue[] = [];
    for (const part of field.parts) {
      if (typeof part.part !== "string") return undefined;
      const text = datePartText(date, part.part, part.format);
      if (text === undefined) return undefined;
      made.push({
        value: text,
        secret: "date-part",
        part: part.part,
        ...(field.detail === "card-expiry" && part.part === "year"
          ? { shortYear: true as const }
          : {}),
      });
    }
    return made;
  }
  const whole = detailValue(field.detail, undefined, value);
  if (whole === undefined) return undefined;
  const lengths = field.parts.map((part) => part.length ?? 0);
  const earlier = lengths.slice(0, -1).reduce((sum, length) => sum + length, 0);
  const last = whole.length - earlier;
  if (last < 1 || last > lengths.at(-1)!) return "unfit";
  const secret = detailSecret(field.detail);
  let at = 0;
  return lengths.map((length, index) => {
    const size = index === lengths.length - 1 ? last : length;
    const group = whole.slice(at, at + size);
    at += size;
    return { value: group, secret, group: length };
  });
}

/**
 * The owner's saved links for the login item's `detail`: one at most, or for a secret
 * question's answer one per question field.
 */
export function savedDetailLinks(
  settings: Pick<LocalSettings, "detailLinks">,
  owner: DetailOwner,
  detail: LoginDetail,
): DetailLink[] {
  return (settings.detailLinks ?? []).filter(
    (link) =>
      link.origin === owner.origin &&
      link.provider === owner.provider &&
      link.userId === owner.userId &&
      link.itemId === owner.itemId &&
      link.detail === detail,
  );
}

/** The owner's saved link for the login item's `detail`, if any. */
export function savedDetailLink(
  settings: Pick<LocalSettings, "detailLinks">,
  owner: DetailOwner,
  detail: LoginDetail,
): DetailLink | undefined {
  return settings.detailLinks?.find(
    (link) =>
      link.origin === owner.origin &&
      link.provider === owner.provider &&
      link.userId === owner.userId &&
      link.itemId === owner.itemId &&
      link.detail === detail,
  );
}

/**
 * The live field a link reads, when the device may read it (ADR 0061): its item is in the
 * login item's connection, active, not quarantined, selected and not excluded, and its
 * field resolves, is allowed and may give the detail. Undefined otherwise.
 */
export function linkedField(
  settings: LocalSettings,
  catalog: VaultCatalog,
  connection: VaultConnectionMetadata,
  link: Pick<DetailLink, "detail" | "source" | "itemId">,
): { itemId: string; fieldId: string; name: string | null } | undefined {
  const item = connection.items.find((entry) => entry.id === link.source.itemId);
  // An answer, member ID or PIN is read only from the items `readsFrom` allows.
  if (
    !item ||
    !readsFrom(link.detail, item, link.itemId) ||
    item.inactive ||
    connection.quarantinedItemIds?.includes(item.id)
  )
    return undefined;
  const eligibility = getItemEligibility(settings, catalog, connection.id, item.id);
  if (!eligibility.eligible) return undefined;
  const fieldId = resolveDetailSourceField(link.source.field, item.fields);
  const field = item.fields.find((entry) => entry.id === fieldId);
  if (
    !field ||
    !givesDetail(link.detail, field) ||
    !readable(link.detail, field.id, item, eligibility.fieldIds)
  )
    return undefined;
  return { itemId: item.id, fieldId: field.id, name: field.name };
}

/** Whether every field a detail's value is made from is in the item and allowed. */
function readable(
  detail: LoginDetail,
  fieldId: string,
  item: VaultItemMetadata,
  allowed: readonly string[],
): boolean {
  return detailFieldIds(detail, fieldId).every(
    (id) => allowed.includes(id) && item.fields.some((entry) => entry.id === id),
  );
}

/** The most candidates the popup lists for a detail. */
export const MAX_DETAIL_CANDIDATES = 20;

/** One vault field that could give a detail, as the popup offers it. */
export type DetailCandidate = {
  connectionId: string;
  itemId: string;
  fieldId: string;
  itemLabel: string;
  fieldLabel: string;
};

/**
 * The fields of the login item's connection that could give `detail` (ADR 0061), at most
 * `limit`, under the rules of `linkedField`: identity phone numbers, card numbers, codes
 * and expiry months (with their card's year), and Text or Hidden custom fields whose name
 * reads as a birth date, a phone, a PIN or a member ID; an answer or member ID only from
 * `loginItemId`, the login item, and a PIN only from it or a card item. An item whose name
 * shares a run of three or more ASCII letters or digits with the page's host name, or
 * appears whole in its title, comes first; otherwise the catalog's order is kept.
 */
export function detailCandidates(
  settings: LocalSettings,
  catalog: VaultCatalog,
  connection: VaultConnectionMetadata,
  detail: LoginDetail,
  page: { host: string; title?: string | undefined; loginItemId: string },
  limit = MAX_DETAIL_CANDIDATES,
): DetailCandidate[] {
  const found: (DetailCandidate & { near: boolean })[] = [];
  for (const item of connection.items) {
    if (item.inactive || connection.quarantinedItemIds?.includes(item.id)) continue;
    if (!readsFrom(detail, item, page.loginItemId)) continue;
    const eligibility = getItemEligibility(settings, catalog, connection.id, item.id);
    if (!eligibility.eligible) continue;
    for (const field of item.fields) {
      if (!givesDetail(detail, field) || !readable(detail, field.id, item, eligibility.fieldIds))
        continue;
      found.push({
        connectionId: connection.id,
        itemId: item.id,
        fieldId: field.id,
        itemLabel: item.label,
        fieldLabel: detailFieldLabel(detail, field.id, item),
        near: nearPage(item.label, page),
      });
    }
  }
  return found
    .map((entry, index) => ({ entry, index }))
    .sort(
      (left, right) =>
        Number(right.entry.near) - Number(left.entry.near) || left.index - right.index,
    )
    .slice(0, limit)
    .map(({ entry: { near: _near, ...candidate } }) => candidate);
}

/** How the popup names the fields a detail reads: their labels, the month's and year's for an expiry. */
export function detailFieldLabel(
  detail: LoginDetail,
  fieldId: string,
  item: Pick<VaultItemMetadata, "fields">,
): string {
  return detailFieldIds(detail, fieldId)
    .map((id) => item.fields.find((entry) => entry.id === id)?.label ?? id)
    .join(" / ");
}

/** Whether an item's name points at the page: an ASCII word of 3 or more in its host, or the whole name in its title. */
function nearPage(name: string, page: { host: string; title?: string | undefined }): boolean {
  const host = page.host.toLowerCase();
  const words =
    name
      .normalize("NFKC")
      .toLowerCase()
      .match(/[a-z0-9]{3,}/gu) ?? [];
  if (words.some((word) => host.includes(word))) return true;
  const title = page.title?.normalize("NFKC");
  return (
    title !== undefined && name.trim().length > 0 && title.includes(name.normalize("NFKC").trim())
  );
}

/** The most card items whose number and brand one guess reads (ADR 0061). */
export const MAX_CARD_GUESS_READS = 20;
/** What a page shows about the card it asks for (`login.detail.card`). */
export type CardHints = { last4: readonly string[]; brands: readonly CardBrand[] };
/** What a card item holds, as read for the guess: its number's last four digits and its brand. */
export type CardFacts = { last4?: string | undefined; brand?: CardBrand | undefined };

/** Whether `detail` is read only from a card item's built-in fields. */
export const isCardDetail = (detail: LoginDetail) => cardDetails.includes(detail);

/**
 * The fields of a card item the guess may read (ADR 0061): its number and its brand, each
 * only while the item may be used and the field is in it and allowed, as a fill reads it.
 */
export function cardGuessFields(
  settings: LocalSettings,
  catalog: VaultCatalog,
  connection: VaultConnectionMetadata,
  itemId: string,
): ("card.number" | "card.brand")[] {
  const item = connection.items.find((entry) => entry.id === itemId);
  if (!item || item.inactive || connection.quarantinedItemIds?.includes(item.id)) return [];
  const eligibility = getItemEligibility(settings, catalog, connection.id, item.id);
  if (!eligibility.eligible) return [];
  return (["card.number", "card.brand"] as const).filter(
    (id) => eligibility.fieldIds.includes(id) && item.fields.some((entry) => entry.id === id),
  );
}

/** A card number's last four digits, read as a `card-last-4` value is made. */
export const cardLast4 = (number: string) => detailValue("card-last-4", undefined, number);

/**
 * The card candidates in the order the popup proposes them (ADR 0061, owner 2026-10-23
 * 12:26 UTC), from what the page shows and what each card item holds (`facts`, by item):
 * the one card whose last four digits the page shows first; among several such cards, the
 * one whose brand the page names too, and otherwise those cards first with none selected,
 * so a tie is never chosen. When the page shows last digits and no card ends in them, the
 * cards whose digits are unknown come before those whose digits differ, the brand's
 * first, and none is selected. When it shows none, the only card of the brand it names
 * comes first. Otherwise the order by name is kept. A brand counts only when the page
 * names just one, and a candidate missing from `facts` was not read, so none is selected.
 */
export function rankCards<T extends { itemId: string }>(
  candidates: readonly T[],
  facts: ReadonlyMap<string, CardFacts>,
  hints: CardHints,
): { candidates: T[]; preselect: boolean } {
  const items = [...new Set(candidates.map((entry) => entry.itemId))];
  const brand = hints.brands.length === 1 ? hints.brands[0] : undefined;
  const shows = (id: string) => {
    const last4 = facts.get(id)?.last4;
    return last4 !== undefined && hints.last4.includes(last4);
  };
  const named = (id: string) => brand !== undefined && facts.get(id)?.brand === brand;
  const byDigits = items.filter(shows);
  let first: string[] = [];
  let preselect = true;
  if (byDigits.length === 1) first = byDigits;
  else if (byDigits.length > 1) {
    const both = byDigits.filter(named);
    first = both.length === 1 ? both : byDigits;
    preselect = both.length === 1;
  } else if (hints.last4.length > 0) {
    const unknown = items.filter((id) => facts.get(id)?.last4 === undefined);
    first = [...unknown.filter(named), ...unknown.filter((id) => !named(id))];
    preselect = false;
  } else {
    const byBrand = items.filter(named);
    if (byBrand.length === 1) first = byBrand;
  }
  if (items.some((id) => !facts.has(id))) preselect = false;
  return {
    candidates: [
      ...first.flatMap((id) => candidates.filter((entry) => entry.itemId === id)),
      ...candidates.filter((entry) => !first.includes(entry.itemId)),
    ],
    preselect,
  };
}
