import {
  type LoginDetail,
  type DetailFormat,
  loginDetailSchema,
  detailFormatSchema,
  detailFormatFits,
  datePartSchema,
  detailPartFormatSchema,
  type DatePart,
  type DetailPartFormat,
  detailPartFormatFits,
} from "../settings";
import * as v from "valibot";
import { loginFieldTargetSchema, unique, type LoginFieldTarget } from "./targets";

/**
 * The details Pateat never fills, though it learns the page that asks for them (ADR 0061):
 * none, since the owner decided that every linked value is filled, a whole card number
 * and a PIN included (2026-10-23 11:41 UTC). Kept for a detail a later decision stops
 * filling.
 */
export const manualDetails: readonly LoginDetail[] = [];
/**
 * The fewest characters a detail's value has once made, which an input's `maxlength` must
 * hold: a dated value's format, 12 digits of a card number, and 4 of a PIN.
 */
export function detailLength(entry: {
  detail: LoginDetail;
  format?: DetailFormat | undefined;
}): number {
  switch (entry.detail) {
    case "secret-answer":
    case "member-id":
      return 1;
    case "card-code":
      return 3;
    case "card-number":
      return 12;
    case "birth-date":
      return entry.format?.length ?? 8;
    case "card-expiry":
      return entry.format?.length ?? 4;
    default:
      return 4;
  }
}
/** One input asks for the whole value. */
const wholeDetailFieldSchema = v.pipe(
  v.strictObject({
    detail: loginDetailSchema,
    format: v.optional(detailFormatSchema),
    target: loginFieldTargetSchema,
  }),
  v.check(
    (entry) => detailFormatFits(entry.detail, entry.format),
    "A birth date or card expiry input has a format of its own, and no other input has one",
  ),
);
/**
 * At most this many inputs hold one split value (ADR 0061): a 19-digit card number in
 * groups of four takes five.
 */
export const MAX_DETAIL_PARTS = 6;
/**
 * One input of a value split over several (ADR 0061): a date's `year`, `month` or `day`
 * with its own `format`, which may be a select, or a card number's or PIN's digit group,
 * numbered from 1 in order, with its `length`, the input's `maxlength` when the page was
 * judged.
 */
export const detailPartSchema = v.strictObject({
  part: v.union([
    datePartSchema,
    v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(MAX_DETAIL_PARTS)),
  ]),
  format: v.optional(detailPartFormatSchema),
  length: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(19))),
  target: loginFieldTargetSchema,
});
/** The parts a split date may have together, each once, as its one-input formats do. */
const datePartSets: Partial<Record<LoginDetail, readonly (readonly DatePart[])[]>> = {
  "birth-date": [
    ["year", "month", "day"],
    ["year", "month"],
    ["month", "day"],
  ],
  "card-expiry": [["month", "year"]],
};
/** The digits a split card number or PIN has in all, as its whole value does. */
const groupDigits: Partial<Record<LoginDetail, readonly [number, number]>> = {
  "card-number": [12, 19],
  pin: [4, 12],
};
/**
 * Whether `parts` make one value of `detail` split over several inputs (ADR 0061): a
 * birth date's year, month and day, its year and month, or its month and day, or a card
 * expiry date's month and year, each part once with a format of its own and no length;
 * or a card number's or a PIN's digit groups numbered 1 to n in order, each with a length
 * and no format, that add up to a whole card number's 12 to 19 digits or a PIN's 4 to 12.
 * No other detail is split.
 */
export function detailPartsFit(
  detail: LoginDetail,
  parts: readonly {
    part: DatePart | number;
    format?: DetailPartFormat | undefined;
    length?: number | undefined;
  }[],
): boolean {
  const sets = datePartSets[detail];
  if (sets) {
    const names = parts.map((entry) => entry.part);
    return (
      parts.every(
        (entry) =>
          typeof entry.part === "string" &&
          entry.length === undefined &&
          detailPartFormatFits(detail, entry.part, entry.format),
      ) &&
      unique(names.map(String)) &&
      sets.some((set) => set.length === names.length && set.every((name) => names.includes(name)))
    );
  }
  const digits = groupDigits[detail];
  if (!digits) return false;
  const total = parts.reduce((sum, entry) => sum + (entry.length ?? 0), 0);
  return (
    parts.every(
      (entry, index) =>
        entry.part === index + 1 && entry.format === undefined && entry.length !== undefined,
    ) &&
    total >= digits[0] &&
    total <= digits[1]
  );
}
/**
 * Several inputs ask for one value split over them (ADR 0061), such as a birth date's
 * year, month and day selects or a card number's four boxes; a login fills them together.
 */
const splitDetailFieldSchema = v.pipe(
  v.strictObject({
    detail: loginDetailSchema,
    parts: v.pipe(v.array(detailPartSchema), v.minLength(2), v.maxLength(MAX_DETAIL_PARTS)),
  }),
  v.check(
    (entry) => detailPartsFit(entry.detail, entry.parts),
    "A split value has each of its parts once, as its detail allows",
  ),
);
/** What a `detail` handler's field asks for: a value in one input, or one split over several. */
export const detailFieldSchema = v.union([wholeDetailFieldSchema, splitDetailFieldSchema]);
export type DetailField = v.InferOutput<typeof detailFieldSchema>;
export type DetailPart = v.InferOutput<typeof detailPartSchema>;
/** One input a detail field fills, with the part of the value it takes when split. */
export type DetailInput = {
  detail: LoginDetail;
  format?: DetailFormat | DetailPartFormat | undefined;
  part?: DetailPart["part"] | undefined;
  length?: number | undefined;
  target: LoginFieldTarget;
};
/** The inputs a detail field fills: its one input, or its parts in order. */
export function detailFieldInputs(field: DetailField): DetailInput[] {
  return "parts" in field
    ? field.parts.map((part) => ({ detail: field.detail, ...part }))
    : [field];
}
/**
 * The one-input format a split birth date reads as (its year and month as `yyyymm`, its
 * month and day as `mmdd`), so the popup names it as it names such an input; a field's own
 * format otherwise.
 */
export function detailFieldFormat(field: DetailField): DetailFormat | undefined {
  if (!("parts" in field)) return field.format;
  if (field.detail !== "birth-date") return undefined;
  const names = field.parts.map((entry) => entry.part);
  if (!names.includes("day")) return "yyyymm";
  return names.includes("year") ? undefined : "mmdd";
}
