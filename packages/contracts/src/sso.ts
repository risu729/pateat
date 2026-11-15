import * as v from "valibot";
import type {
  LayoutMeta,
  LoginHandler,
  LoginRouteBody,
  LoginTarget,
  loginPathSchema,
  loginTargetSchema,
  RecipeDocument,
  recipeLanguageSchema,
  recipeLayoutKeySchema,
  StoredLoginRecipe,
} from "./login";

/** The most SSO methods one item enables (ADR 0085), so the most labels one request names. */
export const MAX_SSO_LABELS = 32;
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
export const ssoLabelsSchema = v.pipe(
  v.array(ssoLabelSchema),
  v.minLength(1),
  v.maxLength(MAX_SSO_LABELS),
  v.check(
    (labels) => new Set(labels.map(normalizeSsoLabel)).size === labels.length,
    "Duplicate SSO labels",
  ),
);

/** A separate route family: these targets are never ordinary LoginSteps. */
export function createSsoRoutesSchema(schemas: {
  path: typeof loginPathSchema;
  target: typeof loginTargetSchema;
  key: typeof recipeLayoutKeySchema;
  language: typeof recipeLanguageSchema;
}) {
  const entries = v.pipe(
    v.array(v.strictObject({ label: ssoLabelSchema, target: schemas.target })),
    v.minLength(1),
    v.maxLength(MAX_SSO_LABELS),
    v.check(
      (values) =>
        new Set(values.map((entry) => normalizeSsoLabel(entry.label))).size === values.length,
      "Duplicate SSO labels",
    ),
    v.check(
      (values) =>
        new Set(values.map((entry) => JSON.stringify(entry.target))).size === values.length,
      "Duplicate SSO targets",
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
        }),
      ),
      v.minLength(1),
      v.maxLength(3),
    ),
  });
}
export type SsoRoutes = v.InferOutput<ReturnType<typeof createSsoRoutesSchema>>;
export type SsoLayout = SsoRoutes["layouts"][number];
export type SsoEntry = SsoLayout["entries"][number];
export type SsoRecipeDocument = RecipeDocument & { sso: SsoRoutes };
export const isSsoDocument = (recipe: StoredLoginRecipe): recipe is SsoRecipeDocument =>
  "sso" in recipe && recipe.sso !== undefined;
/** Selection names one explicit label; absent or ambiguous entries never choose another. */
export function ssoEntryFor(layout: SsoLayout, label: string): SsoEntry | undefined {
  const matches = layout.entries.filter(
    (entry) => normalizeSsoLabel(entry.label) === normalizeSsoLabel(label),
  );
  return matches.length === 1 ? matches[0] : undefined;
}
export function ssoStarts(
  recipe: StoredLoginRecipe,
): { path: string; layout: string; label: string; target: LoginTarget }[] {
  return isSsoDocument(recipe)
    ? recipe.sso.layouts.flatMap((layout) =>
        layout.entries.map((entry) => ({ path: recipe.sso.path, layout: layout.key, ...entry })),
      )
    : [];
}
/** A changed observed SSO entry is a new bounded layout; native siblings stay intact. */
export function withSsoLayout(
  recipe: RecipeDocument,
  path: string,
  layout: SsoLayout,
  lastUsed: (key: string) => number | undefined = () => undefined,
): RecipeDocument {
  const previous = recipe.sso;
  if (previous && previous.path !== path) return recipe;
  const equal = previous?.layouts.some(
    (entry) => JSON.stringify(entry.entries) === JSON.stringify(layout.entries),
  );
  if (equal) return recipe;
  let layouts = [...(previous?.layouts ?? []), layout];
  if (layouts.length > 3) {
    const least = layouts
      .slice(0, -1)
      .reduce((older, candidate) =>
        Math.max(candidate.createdAt, lastUsed(candidate.key) ?? 0) <
        Math.max(older.createdAt, lastUsed(older.key) ?? 0)
          ? candidate
          : older,
      );
    layouts = layouts.filter((entry) => entry !== least);
  }
  return { ...recipe, sso: { path, layouts } };
}
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
 * Whether no SSO entry names an element that a native route of the same document uses on
 * the SSO path: a form or chooser branch step, a list of accounts' own button, a passkey
 * button, an account switch, rejection or signed-in marker, or a handler control. An SSO entry never runs as a
 * native step, nor a native step as an SSO entry.
 */
export function ssoTargetsSeparate(
  recipe: RecipeDocument,
  routes: readonly LoginRouteBody[],
  handlerTargets: (handler: LoginHandler) => LoginTarget[],
): boolean {
  const sso = recipe.sso;
  if (!sso) return true;
  const at = (path: string, target: unknown) => `${path}\n${JSON.stringify(target)}`;
  const used = new Set(
    routes.flatMap((route) => [
      ...[route, ...(route.alternatives ?? [])].flatMap((variant) =>
        variant.steps.flatMap((step) =>
          (step.kind === "fill" ? step.fields.map((field) => field.target) : [step.target]).map(
            (target) => at(step.path, target),
          ),
        ),
      ),
      ...(route.passkey ? [at(route.passkey.path, route.passkey.target)] : []),
      ...[route.accountSwitch, route.rejection, ...(route.completion ?? []).map((m) => m.target)]
        .filter((target) => target !== undefined)
        .map((target) => at(sso.path, target)),
      ...(route.handlers ?? []).flatMap((handler) =>
        handlerTargets(handler).map((target) => at(handler.path, target)),
      ),
    ]),
  );
  // A list of accounts' own buttons, which its branches start with.
  for (const layout of recipe.chooser?.layouts ?? [])
    for (const target of [layout.other, layout.continue])
      if (target) used.add(at(recipe.chooser!.path, target));
  return sso.layouts.every((layout) =>
    layout.entries.every((entry) => !used.has(at(sso.path, entry.target))),
  );
}
