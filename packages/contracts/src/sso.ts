import * as v from "valibot";
import { canonicalJson } from "./canonical-json";
import type {
  LayoutMeta,
  LoginHandler,
  LoginRouteBody,
  recipeLanguageSchema,
  recipeLayoutKeySchema,
} from "./login/route-schema";
import type {
  LoginTarget,
  loginMarkerTargetSchema,
  loginPathSchema,
  loginTargetSchema,
} from "./login/targets";
import type { RecipeDocument, StoredLoginRecipe } from "./login/document-schema";

/** The most SSO methods one item enables (ADR 0085), so the most entries one layout holds. */
export const MAX_SSO_LABELS = 32;
/**
 * The most labels one generation request names: those of the chosen account's methods.
 * Its answer names each by index beside an ASCII candidate ID, so 8 fit the role's
 * 1,024 output tokens (`ssoPlanSchema` in `@pateat/inference`).
 */
export const MAX_SSO_REQUEST_LABELS = 8;
/** Labels are compared ignoring surrounding white space and letter case, as discovery does. */
export const normalizeSsoLabel = (label: string) => label.trim().toLowerCase();
/**
 * A bracket-form label as local discovery reads it (ADR 0085 amendment of 2026-11-12):
 * trimmed, 1 to 128 UTF-16 units, with no bracket, control, format, line or paragraph
 * separator character and no lone surrogate.
 */
export const ssoLabelSchema = v.pipe(
  v.string(),
  v.minLength(1),
  v.maxLength(128),
  v.check(
    (label) => label === label.trim() && !/[[\]\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u.test(label),
    "Invalid SSO label",
  ),
);
/**
 * A request's labels. Labels that differ only by letter case name one entry, so the first
 * spelling is kept and the others dropped rather than refusing the request.
 */
export const ssoLabelsSchema = v.pipe(
  v.array(ssoLabelSchema),
  v.minLength(1),
  v.maxLength(MAX_SSO_REQUEST_LABELS),
  v.transform((labels) =>
    labels.filter(
      (label, index) =>
        labels.findIndex((other) => normalizeSsoLabel(other) === normalizeSsoLabel(label)) ===
        index,
    ),
  ),
);
/** An element on a path, compared canonically, so member order never tells two apart. */
export const ssoTargetKey = (path: string, target: unknown) => `${path}\n${canonicalJson(target)}`;

/** A separate route family: these targets are never ordinary LoginSteps. */
export function createSsoRoutesSchema(schemas: {
  path: typeof loginPathSchema;
  target: typeof loginTargetSchema;
  marker: typeof loginMarkerTargetSchema;
  key: typeof recipeLayoutKeySchema;
  language: typeof recipeLanguageSchema;
  layouts: number;
}) {
  // Several labels may name one element, as two of an item's methods may sign in through
  // one provider's button; one generation answer still names a button of its own per label.
  const entries = v.pipe(
    v.array(v.strictObject({ label: ssoLabelSchema, target: schemas.target })),
    v.minLength(1),
    v.maxLength(MAX_SSO_LABELS),
    v.check(
      (values) =>
        new Set(values.map((entry) => normalizeSsoLabel(entry.label))).size === values.length,
      "Duplicate SSO labels",
    ),
  );
  return v.strictObject({
    path: schemas.path,
    layouts: v.pipe(
      v.array(
        v.strictObject({
          key: schemas.key,
          createdAt: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
          language: v.optional(schemas.language),
          entries,
          completion: v.optional(
            v.pipe(
              v.array(v.strictObject({ target: schemas.marker })),
              v.minLength(1),
              v.maxLength(4),
              v.check(
                (markers) =>
                  new Set(markers.map((entry) => canonicalJson(entry.target))).size ===
                  markers.length,
                "Duplicate SSO completion markers",
              ),
            ),
          ),
        }),
      ),
      v.minLength(1),
      v.maxLength(schemas.layouts),
    ),
  });
}
export type SsoRoutes = v.InferOutput<ReturnType<typeof createSsoRoutesSchema>>;
export type SsoLayout = SsoRoutes["layouts"][number];
export type SsoEntry = SsoLayout["entries"][number];
export type SsoRecipeDocument = RecipeDocument & { sso: SsoRoutes };
export const isSsoDocument = (recipe: StoredLoginRecipe): recipe is SsoRecipeDocument =>
  "sso" in recipe && recipe.sso !== undefined;
/** Metadata of this separate route family, never a native executable projection. */
export const ssoLayoutMeta = (recipe: StoredLoginRecipe): LayoutMeta[] =>
  isSsoDocument(recipe)
    ? recipe.sso.layouts.map(({ key, createdAt, language }) => ({
        key,
        createdAt,
        ...(language ? { language } : {}),
      }))
    : [];
/**
 * Every element, as `ssoTargetKey` names it, that a native route of the document uses on
 * `path`, the SSO path: a form or chooser branch step, a list of accounts' own button, a
 * passkey button, an account switch, rejection or signed-in marker, or a handler control.
 */
export function nativeSsoTargets(
  recipe: RecipeDocument,
  chooserBranches: readonly LoginRouteBody[],
  handlerTargets: (handler: LoginHandler) => LoginTarget[],
  path: string,
): Set<string> {
  const used = new Set(
    [...(recipe.layouts ?? []), ...chooserBranches].flatMap((route) => [
      ...[route, ...(route.alternatives ?? [])].flatMap((variant) =>
        variant.steps.flatMap((step) =>
          (step.kind === "fill" ? step.fields.map((field) => field.target) : [step.target]).map(
            (target) => ssoTargetKey(step.path, target),
          ),
        ),
      ),
      ...(route.passkey ? [ssoTargetKey(route.passkey.path, route.passkey.target)] : []),
      ...[route.accountSwitch, route.rejection, ...(route.completion ?? []).map((m) => m.target)]
        .filter((target) => target !== undefined)
        .map((target) => ssoTargetKey(path, target)),
      ...(route.handlers ?? []).flatMap((handler) =>
        handlerTargets(handler).map((target) => ssoTargetKey(handler.path, target)),
      ),
    ]),
  );
  // A list of accounts' own buttons, which its branches start with.
  for (const layout of recipe.chooser?.layouts ?? [])
    for (const target of [layout.other, layout.continue])
      if (target) used.add(ssoTargetKey(recipe.chooser!.path, target));
  return used;
}
/**
 * Whether no SSO entry names an element a native route uses (`nativeSsoTargets`): an SSO
 * entry never runs as a native step, nor a native step as an SSO entry.
 */
export function ssoTargetsSeparate(
  recipe: RecipeDocument,
  chooserBranches: readonly LoginRouteBody[],
  handlerTargets: (handler: LoginHandler) => LoginTarget[],
): boolean {
  const sso = recipe.sso;
  if (!sso) return true;
  const used = nativeSsoTargets(recipe, chooserBranches, handlerTargets, sso.path);
  return sso.layouts.every((layout) =>
    layout.entries.every((entry) => !used.has(ssoTargetKey(sso.path, entry.target))),
  );
}
