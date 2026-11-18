import * as v from "valibot";
import { loginTargetSchema, sameLoginTarget, type LoginTarget } from "@pateat/contracts";
import { trustedRecord } from "../../../storage";

/**
 * Which IdP origin a broker page's provider entry reached when a flow pressed it (ADR 0085
 * amendment of 2026-11-18). A page's SSO layout names its entries but not where each one
 * goes, so an automatic press of a learned entry also needs this evidence for the mapped
 * origin: one learned for another provider is never pressed for it. Local to the device,
 * bounded, and holds no account, username or credential.
 */
const KEY = "pateat.login.sso-entries.v1";
const MAX = 200;
const entrySchema = v.strictObject({
  origin: v.string(),
  path: v.string(),
  target: loginTargetSchema,
  idp: v.string(),
});
type LearnedEntry = v.InferOutput<typeof entrySchema>;
const record = trustedRecord<LearnedEntry[]>(KEY);
let queue: Promise<unknown> = Promise.resolve();

async function read(): Promise<LearnedEntry[]> {
  const parsed = v.safeParse(v.array(entrySchema), await record.read().catch(() => undefined));
  return parsed.success ? parsed.output : [];
}
const same = (entry: LearnedEntry, origin: string, path: string, target: LoginTarget) =>
  entry.origin === origin && entry.path === path && sameLoginTarget(entry.target, target);

/** Records that pressing `target` on `origin` and `path` reached `idp`; the newest wins. */
export function learnSsoEntry(
  origin: string,
  path: string,
  target: LoginTarget,
  idp: string,
): Promise<void> {
  const next = queue.then(async () => {
    const kept = (await read()).filter((entry) => !same(entry, origin, path, target));
    return record.write([...kept, { origin, path, target, idp }].slice(-MAX));
  });
  queue = next.catch(() => undefined);
  return next;
}

/** Whether pressing `target` on `origin` and `path` last reached `idp`. */
export async function ssoEntryReaches(
  origin: string,
  path: string,
  target: LoginTarget,
  idp: string,
): Promise<boolean> {
  await queue;
  return (await read()).some((entry) => same(entry, origin, path, target) && entry.idp === idp);
}
