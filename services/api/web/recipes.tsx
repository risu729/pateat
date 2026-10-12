import {
  passwordVariants,
  recipeSlots,
  type LoginChooserRecipe,
  type LoginEntryRecipe,
  type LoginRecipe,
  type ManageRecipe,
  type StoredLoginRecipe,
} from "@pateat/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { describeError, ManageApiError, type ManageClient } from "./api";
import { Button } from "./button";
import { PAGE_TITLE_CLASSES } from "./ui";

export const RECIPES_QUERY_KEY = ["recipes"] as const;

type Step = LoginRecipe["steps"][number];
type Target = Extract<Step, { kind: "click" }>["target"];

function formatTime(milliseconds: number) {
  return `${new Date(milliseconds).toISOString().replace("T", " ").slice(0, 16)} UTC`;
}

const describeTarget = (target: Target) => `${target.by} "${target.value}"`;

function describeStep(step: Step): string {
  switch (step.kind) {
    case "fill": {
      const fields = step.fields
        .map((field) => `${field.slot} into ${describeTarget(field.target)}`)
        .join(", ");
      const trigger = step.event ? ` on ${step.event}` : "";
      return `Fill ${fields} (${step.effect}${trigger})`;
    }
    case "click":
      return `Click ${describeTarget(step.target)} to ${step.purpose}`;
    case "wait":
      return `Wait up to ${step.timeoutMs} ms for ${describeTarget(step.target)} to be ${step.present ? "present" : "absent"}`;
    case "assert":
      return `Check that ${describeTarget(step.target)} is ${step.present ? "present" : "absent"}`;
  }
}

/** A recipe with only a sign-in entry (ADR 0031), which devices do not press yet. */
function EntryDetails({ recipe }: { recipe: LoginEntryRecipe }) {
  return (
    <details className="space-y-2">
      <summary className="cursor-pointer text-accent-ink">
        Entry and JSON<span className="sr-only"> for {recipe.id}</span>
      </summary>
      <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1">
        <dt className="font-medium">Sign-in entry</dt>
        <dd>
          Click {describeTarget(recipe.entry.target)} on {recipe.entry.path} to open the site's
          login page. Devices do not click it yet.
        </dd>
      </dl>
      <pre className="overflow-x-auto rounded-lg bg-surface-sunken p-3 text-sm">
        {JSON.stringify(recipe, null, 2)}
      </pre>
    </details>
  );
}

/** A recipe that starts on a list of accounts (ADR 0028), which devices do not start yet. */
function ChooserDetails({ recipe }: { recipe: LoginChooserRecipe }) {
  const { chooser } = recipe;
  const branch = (route: LoginRecipe | undefined) =>
    route ? `${route.steps.length} steps from ${route.steps[0]!.path}` : "Not generated yet";
  return (
    <details className="space-y-2">
      <summary className="cursor-pointer text-accent-ink">
        Account list and JSON<span className="sr-only"> for {recipe.id}</span>
      </summary>
      <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1">
        <dt className="font-medium">Account list</dt>
        <dd>
          On {chooser.path}, click the entry of the chosen item's account. Devices do not do this
          yet.
        </dd>
        <dt className="font-medium">Shown account</dt>
        <dd>{chooser.continue ? `Click ${describeTarget(chooser.continue)}` : "None"}</dd>
        <dt className="font-medium">Another account</dt>
        <dd>{chooser.other ? `Click ${describeTarget(chooser.other)}` : "None"}</dd>
        <dt className="font-medium">After an account</dt>
        <dd>{branch(chooser.afterAccount)}</dd>
        <dt className="font-medium">After another account</dt>
        <dd>{branch(chooser.afterOther)}</dd>
      </dl>
      <pre className="overflow-x-auto rounded-lg bg-surface-sunken p-3 text-sm">
        {JSON.stringify(recipe, null, 2)}
      </pre>
    </details>
  );
}

function RecipeDetails({ recipe }: { recipe: StoredLoginRecipe }) {
  if ("entry" in recipe) return <EntryDetails recipe={recipe} />;
  if ("chooser" in recipe) return <ChooserDetails recipe={recipe} />;
  // A password route with several identifier sets lists each with its own steps (ADR 0027).
  const variants = passwordVariants(recipe);
  return (
    <details className="space-y-2">
      <summary className="cursor-pointer text-accent-ink">
        Steps and JSON<span className="sr-only"> for {recipe.id}</span>
      </summary>
      <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1">
        <dt className="font-medium">Slots</dt>
        <dd>{recipeSlots(recipe).join(", ")}</dd>
        <dt className="font-medium">Signed-in markers</dt>
        <dd>
          {recipe.completion
            ? `${recipe.completion.map((marker) => describeTarget(marker.target)).join(", ")} on any page`
            : "Not learned yet; set from the page after the first sign-in"}
        </dd>
        <dt className="font-medium">Rejection</dt>
        <dd>{recipe.rejection ? describeTarget(recipe.rejection) : "None"}</dd>
        <dt className="font-medium">Passkey sign-in</dt>
        <dd>
          {recipe.passkey
            ? `Click ${describeTarget(recipe.passkey.target)} on ${recipe.passkey.path} for an account with a discoverable passkey`
            : "None"}
        </dd>
        <dt className="font-medium">Handlers</dt>
        <dd>
          {recipe.handlers?.length
            ? recipe.handlers
                .map((handler) =>
                  handler.kind === "totp"
                    ? `totp: fill ${describeTarget(handler.field)}, click ${describeTarget(handler.target)} on ${handler.path}`
                    : `${handler.kind}: click ${describeTarget(handler.target)} on ${handler.path}`,
                )
                .join("; ")
            : "None"}
        </dd>
        <dt className="font-medium">Submissions</dt>
        <dd>At most {recipe.maxSubmissions}</dd>
      </dl>
      {variants.map((variant, variantIndex) => (
        // Variants have no identity of their own; the executor tries them in this order.
        // oxlint-disable-next-line no-array-index-key
        <section key={variantIndex} className="space-y-1">
          {variants.length > 1 ? (
            <h4 className="font-medium">
              Identifier set {variantIndex + 1}: {variant.slots.join(", ")}
            </h4>
          ) : null}
          <ol className="list-decimal space-y-1 pl-6">
            {variant.steps.map((step, index) => (
              // Steps have no identity of their own; their order is the recipe.
              // oxlint-disable-next-line no-array-index-key
              <li key={index}>
                <span className="text-ink-muted">{step.path}</span> {describeStep(step)}
              </li>
            ))}
          </ol>
        </section>
      ))}
      <pre className="overflow-x-auto rounded-lg bg-surface-sunken p-3 text-sm">
        {JSON.stringify(recipe, null, 2)}
      </pre>
    </details>
  );
}

export function RecipesPage({ client }: { client: ManageClient }) {
  const queryClient = useQueryClient();
  const recipes = useQuery({ queryKey: RECIPES_QUERY_KEY, queryFn: () => client.recipes() });
  // Revocation cannot be undone here, so it takes a second, explicit confirmation of the
  // revision the owner saw when they asked to revoke.
  const [confirming, setConfirming] = useState<{ recipeId: string; revision: number } | null>(null);
  // The element to focus once the control the owner used has gone away.
  // A write's target waits for the refresh it starts, which may remove the row.
  const focusTarget = useRef<{ id: string; afterRefresh: boolean } | null>(null);
  const revoke = useMutation({
    mutationFn: (entry: { recipeId: string; revision: number }) =>
      client.revokeRecipe(entry.recipeId, entry.revision),
    onSuccess: () => {
      focusTarget.current = { id: "recipes-heading", afterRefresh: true };
    },
    onError: (_error, entry) => {
      focusTarget.current = { id: `revoke-${entry.recipeId}`, afterRefresh: true };
    },
    onSettled: () => {
      setConfirming(null);
      // Not awaited: the controls come back as soon as the write is answered.
      void queryClient.invalidateQueries({ queryKey: RECIPES_QUERY_KEY });
    },
  });
  // Runs after every render: a control appears, or stops being disabled, only then. The heading
  // stands in for a control the refresh removed.
  useEffect(() => {
    const target = focusTarget.current;
    if (!target || revoke.isPending || (target.afterRefresh && recipes.isFetching)) return;
    (document.getElementById(target.id) ?? document.getElementById("recipes-heading"))?.focus();
    focusTarget.current = null;
  });
  const entries = recipes.data?.recipes ?? [];
  const active = entries.filter(
    (entry): entry is ManageRecipe & { change: { state: "active" } } =>
      entry.change.state === "active",
  );
  const revoked = entries.filter((entry) => entry.change.state === "revoked");

  return (
    <div className="space-y-8">
      <output id="recipes-saved" className="block text-ink-muted">
        {revoke.isSuccess && `${revoke.variables.recipeId} was revoked.`}
      </output>
      {revoke.isError && (
        <p role="alert" id="recipes-error" className="text-danger">
          {revoke.error instanceof ManageApiError && revoke.error.code === "not_found"
            ? "That recipe no longer exists. The page now shows the current recipes."
            : describeError(revoke.error)}
        </p>
      )}
      <section aria-labelledby="recipes-heading" className="space-y-4">
        <h1 id="recipes-heading" tabIndex={-1} className={`${PAGE_TITLE_CLASSES} outline-none`}>
          Recipes
        </h1>
        <p className="text-ink-muted">
          The steps devices follow to log in on each site. Devices write recipes; this page does not
          edit them. Revoking one stops devices from using it after their next sync, and logins on
          that site then wait for a new recipe. This page cannot restore a revoked recipe.
        </p>
        {recipes.isPending ? (
          <output id="recipes-status" className="block">
            Loading recipes…
          </output>
        ) : recipes.isError && !recipes.data ? (
          <p role="alert" id="recipes-status" className="text-danger">
            {describeError(recipes.error)}
          </p>
        ) : null}
        {recipes.isError && recipes.data && (
          <p role="alert" id="recipes-status" className="text-danger">
            The list below could not be refreshed and may be out of date.{" "}
            {describeError(recipes.error)}
          </p>
        )}
        {!recipes.data ? null : active.length === 0 ? (
          <p>No active recipes.</p>
        ) : (
          <ul id="recipes" className="divide-y divide-border">
            {active.map(({ change, updatedAt }) => (
              <li key={change.recipeId} className="space-y-2 py-3">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <h3 className="font-semibold">{change.recipeId}</h3>
                    <p className="text-ink-muted">
                      {change.recipe.origin} · revision {change.revision} · updated{" "}
                      {formatTime(updatedAt)}
                    </p>
                  </div>
                  {confirming?.recipeId === change.recipeId ? (
                    <div className="flex items-center gap-2">
                      <span>Revoke {change.recipeId}?</span>
                      <Button
                        id={`confirm-${change.recipeId}`}
                        disabled={revoke.isPending}
                        onClick={() => revoke.mutate(confirming)}
                      >
                        Confirm
                      </Button>
                      <Button
                        variant="outline"
                        disabled={revoke.isPending}
                        onClick={() => {
                          setConfirming(null);
                          focusTarget.current = {
                            id: `revoke-${change.recipeId}`,
                            afterRefresh: false,
                          };
                        }}
                      >
                        Cancel
                      </Button>
                    </div>
                  ) : (
                    <Button
                      variant="outline"
                      aria-label={`Revoke recipe ${change.recipeId}`}
                      id={`revoke-${change.recipeId}`}
                      disabled={revoke.isPending}
                      onClick={() => {
                        setConfirming({ recipeId: change.recipeId, revision: change.revision });
                        focusTarget.current = {
                          id: `confirm-${change.recipeId}`,
                          afterRefresh: false,
                        };
                      }}
                    >
                      Revoke
                    </Button>
                  )}
                </div>
                <RecipeDetails recipe={change.recipe} />
              </li>
            ))}
          </ul>
        )}
      </section>
      {recipes.data && (
        <section aria-labelledby="revoked-heading" className="space-y-4">
          <h2 id="revoked-heading" className="text-xl font-semibold">
            Revoked recipes
          </h2>
          {revoked.length === 0 ? (
            <p>No revoked recipes.</p>
          ) : (
            <ul id="revoked-recipes" className="divide-y divide-border">
              {revoked.map(({ change, updatedAt }) => (
                <li key={change.recipeId} className="py-2">
                  {change.recipeId}{" "}
                  <span className="text-ink-muted">
                    (revision {change.revision}, revoked {formatTime(updatedAt)})
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}
