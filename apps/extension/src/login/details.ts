import {
  getItemEligibility,
  resolveDetailSourceField,
  type BirthDateFormat,
  type DetailLink,
  type LocalSettings,
  type LoginDetail,
  type VaultCatalog,
  type VaultConnectionMetadata,
  type VaultItemMetadata,
} from "@pateat/contracts";

// Personal details asked during a login (ADR 0061): which vault fields may give each
// detail, the owner's links to them, and the value a page wants made from a field's
// value. Values are made here, in the service worker, right after the vault read, so a
// whole phone or card number never reaches the page.

/** The login item a link belongs to: its site and its vault account and item. */
export type DetailOwner = Pick<DetailLink, "origin" | "provider" | "userId" | "itemId">;

/** The built-in fields each detail may be read from; custom fields are checked by kind. */
const builtinSources: Readonly<Record<LoginDetail, readonly string[]>> = {
  "birth-date": [],
  "phone-last-4": ["identity.phone"],
  "card-last-4": ["card.number"],
  "card-code": ["card.code"],
  "secret-answer": [],
  "member-id": [],
};
/** Custom field names that read as a birth date, compared without case. */
const birthWords = ["birth", "dob", "生年月日", "誕生日"];
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

/**
 * Whether `field` of an item may give `detail`: a built-in source, or a Text or Hidden
 * custom field whose name says it holds the detail, a birth date's or a phone number's,
 * so a link never reads another custom field, such as a PIN, into a page's input.
 */
export function givesDetail(
  detail: LoginDetail,
  field: VaultItemMetadata["fields"][number],
): boolean {
  if (builtinSources[detail].includes(field.id)) return true;
  if (detail === "card-last-4" || detail === "card-code") return false;
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
 * The value a page's input wants for `detail`, made from the linked field's value: the
 * date in `format`, the last four digits, a card code of 3 or 4 digits as it is, or an
 * answer (up to 128 characters) or member ID (up to 64) trimmed. Undefined when the value
 * is no date, has too few digits, or is empty or too long.
 */
export function detailValue(
  detail: LoginDetail,
  format: BirthDateFormat | undefined,
  value: string,
): string | undefined {
  if (detail === "birth-date") {
    const date = readBirthDate(value);
    if (!date || !format) return undefined;
    const year = String(date.year);
    const month = String(date.month).padStart(2, "0");
    const day = String(date.day).padStart(2, "0");
    return {
      yyyymmdd: `${year}${month}${day}`,
      yyyymm: `${year}${month}`,
      "yyyy-mm-dd": `${year}-${month}-${day}`,
      "yyyy/mm/dd": `${year}/${month}/${day}`,
      mmdd: `${month}${day}`,
    }[format];
  }
  if (detail === "secret-answer" || detail === "member-id") {
    const text = value.trim();
    return text.length >= 1 && text.length <= (detail === "secret-answer" ? 128 : 64)
      ? text
      : undefined;
  }
  const digits = digitsOf(value);
  if (detail === "card-code") return /^\d{3,4}$/u.test(digits) ? digits : undefined;
  return digits.length >= 4 ? digits.slice(-4) : undefined;
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
  // An answer or member ID is read from the login item itself, never another item.
  if (ownItemDetails.includes(link.detail) && link.source.itemId !== link.itemId) return undefined;
  const item = connection.items.find((entry) => entry.id === link.source.itemId);
  if (!item || item.inactive || connection.quarantinedItemIds?.includes(item.id)) return undefined;
  const eligibility = getItemEligibility(settings, catalog, connection.id, item.id);
  if (!eligibility.eligible) return undefined;
  const fieldId = resolveDetailSourceField(link.source.field, item.fields);
  const field = item.fields.find((entry) => entry.id === fieldId);
  if (!field || !eligibility.fieldIds.includes(field.id) || !givesDetail(link.detail, field))
    return undefined;
  return { itemId: item.id, fieldId: field.id, name: field.name };
}

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
 * `limit`, under the rules of `linkedField`: identity phone numbers, card numbers and
 * codes, and Text or Hidden custom fields whose name reads as a birth date, a phone or a
 * member ID; an answer or member ID only from `loginItemId`, the login item. An item
 * whose name shares a run of three or more ASCII letters or digits with the page's host
 * name, or appears whole in its title, comes first; otherwise the catalog's order is kept.
 */
export function detailCandidates(
  settings: LocalSettings,
  catalog: VaultCatalog,
  connection: VaultConnectionMetadata,
  detail: LoginDetail,
  page: { host: string; title?: string | undefined; loginItemId: string },
  limit = 20,
): DetailCandidate[] {
  const found: (DetailCandidate & { near: boolean })[] = [];
  for (const item of connection.items) {
    if (item.inactive || connection.quarantinedItemIds?.includes(item.id)) continue;
    if (ownItemDetails.includes(detail) && item.id !== page.loginItemId) continue;
    const eligibility = getItemEligibility(settings, catalog, connection.id, item.id);
    if (!eligibility.eligible) continue;
    for (const field of item.fields) {
      if (!eligibility.fieldIds.includes(field.id) || !givesDetail(detail, field)) continue;
      found.push({
        connectionId: connection.id,
        itemId: item.id,
        fieldId: field.id,
        itemLabel: item.label,
        fieldLabel: field.label,
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
