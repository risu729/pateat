import * as v from "valibot";
import type { LoginTarget, StoredLoginRecipe, RecipeDocument, LayoutMeta } from "./login";

export const MAX_SSO_LABELS = 32;
export const normalizeSsoLabel = (label: string) => label.trim().toLowerCase();
export const ssoLabelSchema = v.pipe(
  v.string(),
  v.minLength(1),
  v.maxLength(128),
  v.check(
    (label) =>
      label === label.trim() &&
      ![...label].some((part) => {
        const code = part.charCodeAt(0);
        return (
          code < 32 ||
          (code >= 127 && code <= 159) ||
          code === 0x2028 ||
          code === 0x2029 ||
          (part.length === 1 && code >= 0xd800 && code <= 0xdfff)
        );
      }),
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
  path: typeof import("./login").loginPathSchema;
  target: typeof import("./login").loginTargetSchema;
  marker: typeof import("./login").loginMarkerTargetSchema;
  key: typeof import("./login").recipeLayoutKeySchema;
  language: typeof import("./login").recipeLanguageSchema;
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
          completion: v.optional(
            v.pipe(
              v.array(v.strictObject({ target: schemas.marker })),
              v.minLength(1),
              v.maxLength(4),
              v.check(
                (markers) =>
                  new Set(markers.map((entry) => JSON.stringify(entry.target))).size ===
                  markers.length,
                "Duplicate SSO completion markers",
              ),
            ),
          ),
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
