import type { DetailLink } from "./schema-primitives";

/** The login item a detail belongs to, across devices and provider servers. */
export type DetailOwner = Pick<DetailLink, "origin" | "provider" | "server" | "userId" | "itemId">;

const ownerParts = (owner: DetailOwner) => [
  owner.origin,
  owner.provider,
  owner.server,
  owner.userId,
  owner.itemId,
];

/** Whether two links or refusals belong to the same site's login item. */
export const sameDetailOwner = (left: DetailOwner, right: DetailOwner): boolean =>
  JSON.stringify(ownerParts(left)) === JSON.stringify(ownerParts(right));

/** A field reference as a key, independent of the order of its properties. */
export const detailSourceFieldKey = (field: DetailLink["source"]["field"]): string =>
  typeof field === "string"
    ? field
    : JSON.stringify([field.custom, field.position ?? null, field.count ?? null]);

/** A detail or refusal's identity; an answer may name one question field. */
export const detailKey = (
  owner: DetailOwner,
  detail: DetailLink["detail"],
  field?: DetailLink["source"]["field"],
): string =>
  JSON.stringify([
    ...ownerParts(owner),
    detail,
    detail === "secret-answer" && field !== undefined ? detailSourceFieldKey(field) : null,
  ]);

/** One link per detail, or one per source field for secret questions' answers. */
export const detailLinkKey = (link: DetailLink): string =>
  detailKey(link, link.detail, link.source.field);

/** A confirmed question belongs to one answer of this server's login item. */
export const detailQuestionKey = (link: DetailLink): string | undefined =>
  link.question === undefined ? undefined : JSON.stringify([...ownerParts(link), link.question]);
