import * as v from "valibot";
import {
  LOG_EVENTS,
  LOG_LEVELS,
  MAX_FIELD_LENGTH,
  type FieldKind,
  type FieldValue,
  type LogEventName,
} from "./log-events";

/** A parameter name kept in a page URL: a name a site gives a parameter, not a value. */
const NAME = String.raw`[A-Za-z_][\w.\-[\]]{0,39}`;
export const PARAMETER_NAME = new RegExp(`^${NAME}$`, "u");
const NAMES = `(?:${NAME}=(?:&${NAME}=)*)?`;

/** The only shape a stored page URL has: a path, then parameter names or a route. */
const STORED_PATH = new RegExp(
  String.raw`^/[^?#]*(?:\?${NAMES})?(?:#(?:${NAMES}|!?/[^=?#]*(?:\?${NAMES})?))?$`,
  "u",
);

export const integer = v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(Number.MAX_SAFE_INTEGER));
export const KIND_SCHEMAS: Record<
  Exclude<FieldKind, "origin" | "rpId" | "connection" | "item" | "url">,
  v.GenericSchema<unknown, FieldValue>
> = {
  code: v.pipe(v.string(), v.regex(/^[a-z0-9][a-z0-9.:-]{0,63}$/u)),
  name: v.pipe(v.string(), v.regex(/^[A-Za-z][A-Za-z0-9]{0,63}$/u)),
  count: integer,
  time: integer,
  flag: v.boolean(),
  revision: v.pipe(v.string(), v.regex(/^[0-9A-Za-z._-]{1,64}$/u)),
  recipe: v.pipe(v.string(), v.regex(/^[a-zA-Z0-9_.:-]{1,120}$/u)),
  stack: v.pipe(v.string(), v.regex(/^[\w.-]+\.js:\d+:\d+(?: [\w.-]+\.js:\d+:\d+){0,4}$/u)),
};
const pseudonymSchema = (prefix: string, length: number) =>
  v.pipe(v.string(), v.regex(new RegExp(`^${prefix}:[0-9a-f]{${length}}$`, "u")));
export const originValueSchema = v.union([
  v.pipe(
    v.string(),
    v.url(),
    v.check((value) => new URL(value).origin === value),
  ),
  pseudonymSchema("origin", 8),
]);
export const rpIdValueSchema = v.union([
  v.pipe(v.string(), v.regex(/^[a-z0-9.-]{1,253}$/u)),
  pseudonymSchema("rp", 8),
]);
/** What a stored value of each kind may look like after recording. */
export const STORED_SCHEMAS: Record<FieldKind, v.GenericSchema<unknown, FieldValue>> = {
  ...KIND_SCHEMAS,
  origin: originValueSchema,
  rpId: rpIdValueSchema,
  connection: pseudonymSchema("bitwarden", 6),
  item: pseudonymSchema("item", 8),
  // A URL an older build stored with its parameters' values is left out, unless the value
  // was a single token ending in `=` and so has this shape too.
  url: v.pipe(v.string(), v.startsWith("/"), v.maxLength(MAX_FIELD_LENGTH), v.regex(STORED_PATH)),
};

export const entrySchema = v.object({
  time: integer,
  level: v.picklist(LOG_LEVELS),
  event: v.picklist(Object.keys(LOG_EVENTS) as [LogEventName, ...LogEventName[]]),
  fields: v.record(v.string(), v.union([v.string(), v.number(), v.boolean()])),
  /** The build revision that wrote the entry; entries of older builds have none. */
  build: v.optional(v.pipe(v.string(), v.maxLength(64))),
});
export type LogEntry = v.InferOutput<typeof entrySchema>;
