import {
  passwordVariants,
  recipeSlots,
  type LoginMarkerTarget,
  type LoginRecipe,
  type ManageRecipe,
  type StoredLoginRecipe,
} from "@pateat/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import { describeError, ManageApiError, type ManageClient } from "./api";
import { Button } from "./button";
import { formatTime } from "./devices";
import { Badge, ErrorNotice, KeyValues, Panel, ROW_CLASSES, RowList, RowMain } from "./ui";

export const RECIPES_QUERY_KEY = ["recipes"] as const;

export type ActiveRecipe = ManageRecipe & { change: { state: "active" } };

export function useRecipes(client: ManageClient) {
  return useQuery({ queryKey: RECIPES_QUERY_KEY, queryFn: () => client.recipes() });
}

export const isActive = (entry: ManageRecipe): entry is ActiveRecipe =>
  entry.change.state === "active";

type Step = LoginRecipe["steps"][number];

const describeTarget = (target: LoginMarkerTarget) => `${target.by} "${target.value}"`;

/**
 * A slot name quoted and isolated, as a name taken from the page's text (ADR 0027) may hold
 * commas, brackets or right-to-left text, such as `会員番号 (ログインID)`.
 */
const slotName = (slot: string) => (
  <>
    "<bdi>{slot}</bdi>"
  </>
);
/** Entries joined by commas, each shown by `item`. */
const joined = <T,>(
  entries: readonly T[],
  key: (entry: T) => string,
  item: (entry: T) => ReactNode,
) =>
  entries.map((entry, index) => (
    <Fragment key={key(entry)}>
      {index > 0 ? ", " : null}
      {item(entry)}
    </Fragment>
  ));
const slotNames = (slots: readonly string[]) => joined(slots, (slot) => slot, slotName);

function describeStep(step: Step): ReactNode {
  switch (step.kind) {
    case "fill": {
      const fields = joined(
        step.fields,
        (field) => field.slot,
        (field) => (
          <>
            {slotName(field.slot)} into {describeTarget(field.target)}
          </>
        ),
      );
      const trigger = step.event ? ` on ${step.event}` : "";
      return (
        <>
          Fill {fields} ({step.effect}
          {trigger})
        </>
      );
    }
    case "click":
      return `Click ${describeTarget(step.target)} to ${step.purpose}`;
    case "wait":
      return `Wait up to ${step.timeoutMs} ms for ${describeTarget(step.target)} to be ${step.present ? "present" : "absent"}`;
    case "assert":
      return `Check that ${describeTarget(step.target)} is ${step.present ? "present" : "absent"}`;
  }
}

/** What a recipe does, as label and value pairs, and its steps when it has any. */
function recipeFacts(recipe: StoredLoginRecipe): {
  facts: [string, ReactNode][];
  variants: ReturnType<typeof passwordVariants>;
} {
  // A recipe with only a sign-in entry (ADR 0031), which devices do not press yet.
  if ("entry" in recipe)
    return {
      facts: [
        [
          "Sign-in entry",
          `Click ${describeTarget(recipe.entry.target)} on ${recipe.entry.path} to open the site's login page. Devices do not click it yet.`,
        ],
      ],
      variants: [],
    };
  // A recipe that starts on a list of accounts (ADR 0028), which devices do not start yet.
  if ("chooser" in recipe) {
    const { chooser } = recipe;
    const branch = (route: LoginRecipe | undefined) =>
      route ? `${route.steps.length} steps from ${route.steps[0]!.path}` : "Not generated yet";
    return {
      facts: [
        [
          "Account list",
          `On ${chooser.path}, click the entry of the chosen item's account. Devices do not do this yet.`,
        ],
        ["Shown account", chooser.continue ? `Click ${describeTarget(chooser.continue)}` : "None"],
        ["Another account", chooser.other ? `Click ${describeTarget(chooser.other)}` : "None"],
        ["After an account", branch(chooser.afterAccount)],
        ["After another account", branch(chooser.afterOther)],
      ],
      variants: [],
    };
  }
  return {
    facts: [
      ["Slots", slotNames(recipeSlots(recipe))],
      [
        "Signed-in markers",
        recipe.completion
          ? `${recipe.completion.map((marker) => describeTarget(marker.target)).join(", ")} on any page`
          : "Not learned yet; set from the page after the first sign-in",
      ],
      ["Rejection", recipe.rejection ? describeTarget(recipe.rejection) : "None"],
      [
        "Passkey sign-in",
        recipe.passkey
          ? `Click ${describeTarget(recipe.passkey.target)} on ${recipe.passkey.path} for an account with a discoverable passkey`
          : "None",
      ],
      [
        "Handlers",
        recipe.handlers?.length
          ? recipe.handlers
              .map((handler) =>
                handler.kind === "totp"
                  ? `totp fills ${describeTarget(handler.field)} and clicks ${describeTarget(handler.target)} on ${handler.path}`
                  : `${handler.kind} clicks ${describeTarget(handler.target)} on ${handler.path}`,
              )
              .join("; ")
          : "None",
      ],
      ["Submissions", `At most ${recipe.maxSubmissions}`],
    ],
    // A password route with several identifier sets lists each with its own steps (ADR 0027).
    variants: passwordVariants(recipe),
  };
}

function RecipeDetails({ entry }: { entry: ActiveRecipe }) {
  const { recipe, revision } = entry.change;
  const { facts, variants } = recipeFacts(recipe);
  return (
    <>
      <KeyValues
        entries={[["Revision", `${revision}, updated ${formatTime(entry.updatedAt)}`], ...facts]}
      />
      {variants.map((variant, variantIndex) => (
        // Variants have no identity of their own; the executor tries them in this order.
        // oxlint-disable-next-line no-array-index-key
        <section key={variantIndex} className="space-y-2">
          {variants.length > 1 ? (
            <h4 className="text-sm font-semibold">
              Identifier set {variantIndex + 1} ({slotNames(variant.slots)})
            </h4>
          ) : null}
          <ol className="flex flex-col gap-2">
            {variant.steps.map((step, index) => (
              // Steps have no identity of their own; their order is the recipe.
              // oxlint-disable-next-line no-array-index-key
              <li key={index} className="flex items-start gap-2 text-sm">
                <Badge tone="muted">{index + 1}</Badge>
                <span className="[overflow-wrap:anywhere]">
                  <span className="text-ink-muted">{step.path}</span> {describeStep(step)}
                </span>
              </li>
            ))}
          </ol>
        </section>
      ))}
      <details>
        <summary className="flex min-h-9 cursor-pointer items-center text-sm font-semibold text-accent-ink">
          JSON<span className="sr-only"> of {recipe.id}</span>
        </summary>
        <pre className="overflow-x-auto rounded-lg bg-surface-sunken p-3 font-mono text-[13px]/5">
          {JSON.stringify(recipe, null, 2)}
        </pre>
      </details>
    </>
  );
}

type RevokeTarget = { recipeId: string; revision: number };

/**
 * Revocation of the recipes one list shows. Revocation cannot be undone here, so it
 * takes a second, explicit confirmation of the revision the owner saw when they asked.
 * `ids.heading` takes focus after a revocation and when the control the owner used is gone;
 * `ids.fallback` does when the heading is gone too.
 */
function useRecipeRevoke(
  client: ManageClient,
  announce: (message: string) => void,
  ids: { heading: string; error: string; fallback?: string },
) {
  const queryClient = useQueryClient();
  const recipes = useRecipes(client);
  const [confirming, setConfirming] = useState<RevokeTarget | null>(null);
  // The element to focus once the control the owner used has gone away.
  // A write's target waits for the refresh it starts, which may remove the recipe.
  const focusTarget = useRef<{ id: string; afterRefresh: boolean } | null>(null);
  const revoke = useMutation({
    mutationFn: (entry: RevokeTarget) => client.revokeRecipe(entry.recipeId, entry.revision),
    onMutate: () => announce(""),
    onSuccess: (_result, entry) => {
      announce(`${entry.recipeId} revoked`);
      focusTarget.current = { id: ids.heading, afterRefresh: true };
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
    (
      document.getElementById(target.id) ??
      document.getElementById(ids.heading) ??
      (ids.fallback ? document.getElementById(ids.fallback) : null)
    )?.focus();
    focusTarget.current = null;
  });

  /** The Revoke button of one recipe, or its confirmation while the owner is asked. */
  function control({ recipeId, revision }: RevokeTarget) {
    return confirming?.recipeId === recipeId ? (
      <div className="flex flex-wrap items-center gap-2">
        <span>
          Revoke {recipeId}, revision {confirming.revision}?
        </span>
        <Button
          id={`confirm-${recipeId}`}
          variant="danger"
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
            focusTarget.current = { id: `revoke-${recipeId}`, afterRefresh: false };
          }}
        >
          Cancel
        </Button>
      </div>
    ) : (
      <Button
        variant="danger"
        aria-label={`Revoke recipe ${recipeId}`}
        id={`revoke-${recipeId}`}
        disabled={revoke.isPending}
        onClick={() => {
          setConfirming({ recipeId, revision });
          focusTarget.current = { id: `confirm-${recipeId}`, afterRefresh: false };
        }}
      >
        Revoke
      </Button>
    );
  }

  const error = revoke.isError ? (
    <ErrorNotice id={ids.error}>
      {revoke.error instanceof ManageApiError && revoke.error.code === "not_found"
        ? "That recipe no longer exists. The page now shows the current recipes."
        : describeError(revoke.error)}
    </ErrorNotice>
  ) : null;

  return { recipes, control, error };
}

/** One site's active recipes with their revocation. */
export function SiteRecipes({
  client,
  origin,
  announce,
  shownError,
}: {
  client: ManageClient;
  origin: string;
  announce: (message: string) => void;
  /** An error the page already shows, such as a signed-out owner's; it is not repeated. */
  shownError?: string | undefined;
}) {
  const { recipes, control, error } = useRecipeRevoke(client, announce, {
    heading: "recipes-heading",
    error: "recipes-error",
  });
  const active = (recipes.data?.recipes ?? [])
    .filter(isActive)
    .filter((entry) => entry.change.recipe.origin === origin);

  return (
    <Panel id="recipes-heading" title="Recipes">
      {error}
      {recipes.isPending ? (
        <output id="recipes-status" className="block">
          Loading recipes…
        </output>
      ) : recipes.isError && describeError(recipes.error) !== shownError ? (
        <ErrorNotice id="recipes-status">
          {recipes.data && "The list below could not be refreshed and may be out of date. "}
          {describeError(recipes.error)}
        </ErrorNotice>
      ) : null}
      {!recipes.data ? null : active.length === 0 ? (
        <p>No recipes</p>
      ) : (
        <ul id="recipes" className="divide-y divide-border">
          {active.map((entry) => (
            <li key={entry.change.recipeId} className="space-y-4 py-4 first:pt-0 last:pb-0">
              <div className="flex flex-wrap items-center gap-3">
                <h3 className="min-w-0 flex-1 font-mono font-[650] [overflow-wrap:anywhere]">
                  {entry.change.recipeId}
                </h3>
                {control(entry.change)}
              </div>
              <RecipeDetails entry={entry} />
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

/**
 * Active recipes whose stored document the service can no longer read. Devices already
 * drop them; they keep no readable origin, so they are listed apart from the sites, and
 * revoking one frees its place in the recipe limits.
 */
export function UnreadableRecipes({
  client,
  announce,
}: {
  client: ManageClient;
  announce: (message: string) => void;
}) {
  // A revoked recipe moves to Revoked recipes, whose heading takes focus once this list is gone.
  const { recipes, control, error } = useRecipeRevoke(client, announce, {
    heading: "unreadable-heading",
    error: "unreadable-error",
    fallback: "revoked-heading",
  });
  const unreadable = recipes.data?.unreadable ?? [];
  if (unreadable.length === 0 && !error) return null;
  return (
    <section aria-labelledby="unreadable-heading" className="space-y-4">
      <h2 id="unreadable-heading" tabIndex={-1} className="text-xl/7 font-[650] outline-none">
        Unreadable recipes
      </h2>
      {error}
      {unreadable.length > 0 && (
        <>
          <p>
            The service can no longer read these recipes, so devices do not use them. Revoke them to
            free their place.
          </p>
          <RowList id="unreadable-recipes">
            {unreadable.map((entry) => (
              <li key={entry.recipeId} className={ROW_CLASSES}>
                <RowMain
                  title={<span className="font-mono">{entry.recipeId}</span>}
                  sub={`Revision ${entry.revision}, updated ${formatTime(entry.updatedAt)}`}
                />
                {control(entry)}
              </li>
            ))}
          </RowList>
        </>
      )}
    </section>
  );
}

/** Revoked recipes keep no origin, so they are listed apart from the sites. */
export function RevokedRecipes({ recipes }: { recipes: ManageRecipe[] }) {
  const revoked = recipes.filter((entry) => entry.change.state === "revoked");
  return (
    <section aria-labelledby="revoked-heading" className="space-y-4">
      <h2 id="revoked-heading" tabIndex={-1} className="text-xl/7 font-[650] outline-none">
        Revoked recipes
      </h2>
      {revoked.length === 0 ? (
        <p>No revoked recipes</p>
      ) : (
        <RowList id="revoked-recipes">
          {revoked.map(({ change, updatedAt }) => (
            <li key={change.recipeId} className={ROW_CLASSES}>
              <RowMain
                title={<span className="font-mono">{change.recipeId}</span>}
                sub={`Revision ${change.revision}, revoked ${formatTime(updatedAt)}`}
              />
            </li>
          ))}
        </RowList>
      )}
    </section>
  );
}
