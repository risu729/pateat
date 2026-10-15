import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { CircleCheck, CloudUpload, Info, TriangleAlert } from "lucide-react";
import {
  MAX_RECIPE_FILE_BYTES,
  type LocalRecipeError,
  type LocalRecipeResponse,
  type LocalRecipeState,
  type RecipeFile,
} from "../service/local-recipes";
import { Button } from "./button";
import type { RecipeClient } from "./recipe-client";
import { Panel, Row, RowList, RowSub, RowTitle, StatusLines } from "./ui";

/** How often the panel rereads its state, so a pairing elsewhere on the page shows. */
export const RECIPES_POLL_MS = 10_000;

function errorMessage(error: LocalRecipeError): string {
  switch (error) {
    case "invalid-request":
      return "That request was not valid.";
    case "invalid-file":
      return "That file is not a Pateat recipe file, or a recipe in it is not valid. Nothing was imported.";
    case "too-large":
      return "These recipes do not fit in Pateat's storage on this device. Nothing was imported.";
    case "paired":
      return "This device is paired with a sync service, which provides its recipes. Disconnect it first to keep recipes on this device.";
    case "storage-unavailable":
      return "Pateat could not read or save the recipes on this device.";
    case "storage-corrupt":
      return "Pateat cannot read the recipes saved on this device. Remove them all, then import them again.";
  }
}

/** Saves the file through a temporary link; extension pages need no download permission. */
export function downloadRecipeFile(file: RecipeFile) {
  const url = URL.createObjectURL(
    new Blob([`${JSON.stringify(file, null, 2)}\n`], { type: "application/json" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = "pateat-recipes.json";
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

const plural = (count: number, one: string, many = `${one}s`) =>
  `${count} ${count === 1 ? one : many}`;

/**
 * Recipes without a sync service (ADR 0039): with no service paired, logins use the
 * recipes kept on this device, which come from a recipe file. Export works in both modes.
 */
export function RecipesPanel({
  client,
  download = downloadRecipeFile,
  pollMs = RECIPES_POLL_MS,
}: {
  client: RecipeClient;
  download?: (file: RecipeFile) => void;
  pollMs?: number;
}) {
  const [state, setState] = useState<LocalRecipeState | undefined>();
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const acting = useRef(false);
  const mounted = useRef(true);
  const fileInput = useRef<HTMLInputElement>(null);

  function receive(response: LocalRecipeResponse, success?: string) {
    if (!mounted.current) return;
    if (response.state) setState(response.state);
    if (response.ok) {
      if (success !== undefined) setMessage(success);
    } else setMessage(errorMessage(response.error));
  }
  async function act(run: () => Promise<void>) {
    if (acting.current) return;
    acting.current = true;
    setBusy(true);
    try {
      await run();
    } catch {
      if (mounted.current) setMessage("The extension did not answer. Reload this page to retry.");
    } finally {
      acting.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  useEffect(() => {
    mounted.current = true;
    const load = () => {
      if (acting.current) return;
      void client.get().then(
        (response) => receive(response),
        () => undefined,
      );
    };
    load();
    const timer = setInterval(load, pollMs);
    return () => {
      mounted.current = false;
      clearInterval(timer);
    };
    // `receive` touches only state setters and refs; load once per client.
    // oxlint-disable-next-line react/exhaustive-effect-dependencies
  }, [client, pollMs]);

  async function importChosen(event: ChangeEvent<HTMLInputElement>) {
    const input = event.currentTarget;
    const chosen = input.files?.[0];
    // The same file can be chosen again after a change.
    input.value = "";
    if (!chosen) return;
    await act(async () => {
      if (chosen.size > MAX_RECIPE_FILE_BYTES) {
        setMessage(errorMessage("too-large"));
        return;
      }
      let file: unknown;
      try {
        file = JSON.parse(await chosen.text());
      } catch {
        setMessage(errorMessage("invalid-file"));
        return;
      }
      const response = await client.importFile(file);
      if (!response.ok || !response.imported) {
        receive(response);
        return;
      }
      const { added, updated, unchanged, skipped } = response.imported;
      receive(
        response,
        `Imported ${plural(added, "new recipe")} and ${plural(updated, "newer revision")}.` +
          (unchanged ? ` ${plural(unchanged, "recipe was", "recipes were")} already here.` : "") +
          (skipped
            ? ` ${plural(skipped, "recipe was", "recipes were")} skipped: this device keeps the same or a newer revision with other content.`
            : ""),
      );
    });
  }

  const paired = state?.source === "service";
  const unreadable = state?.unreadable === true;
  const device = state?.source === "device";
  const lines: Parameters<typeof StatusLines>[0]["lines"] = [];
  if (device)
    lines.push({
      tone: "idle",
      icon: Info,
      text: "No sync service is paired, so logins use the recipes saved on this device. Pateat creates no recipes without a service: import a recipe file to add them.",
    });
  if (paired)
    lines.push({
      tone: "ok",
      icon: CircleCheck,
      text: "Logins use the recipes synced from the service.",
    });
  if (paired && state.waiting > 0)
    lines.push({
      tone: "warn",
      icon: CloudUpload,
      text: `${plural(state.waiting, "recipe")} saved on this device before pairing ${state.waiting === 1 ? "is" : "are"} not on the service yet. The next sync uploads ${state.waiting === 1 ? "it" : "them"}.`,
    });
  if (unreadable)
    lines.push({
      tone: "err",
      icon: TriangleAlert,
      text: "Pateat cannot read the recipes saved on this device. Remove them all, then import them again.",
    });
  else if (state?.source === "unavailable")
    lines.push({
      tone: "err",
      icon: TriangleAlert,
      text: "Pateat cannot read its service connection, so it uses no recipes. Forget the connection under Sync service.",
    });

  return (
    <Panel
      id="recipes"
      headingId="recipes-heading"
      title="Recipes"
      actions={
        <div className="flex flex-wrap items-center gap-2">
          {device && (
            <>
              <input
                ref={fileInput}
                id="recipe-file"
                type="file"
                accept="application/json,.json"
                className="visually-hidden"
                tabIndex={-1}
                aria-hidden
                onChange={(event) => void importChosen(event)}
              />
              <Button
                id="import-recipes"
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => fileInput.current?.click()}
              >
                Import recipe file
              </Button>
            </>
          )}
          {state && state.source !== "unavailable" && (
            <Button
              id="export-recipes"
              type="button"
              variant="ghost"
              disabled={busy || state.recipes.length === 0}
              onClick={() =>
                void act(async () => {
                  const response = await client.exportFile();
                  if (response.ok && response.file) {
                    download(response.file);
                    receive(
                      response,
                      `Exported ${plural(response.file.recipes.length, "recipe")}.`,
                    );
                  } else receive(response);
                })
              }
            >
              Export recipes
            </Button>
          )}
        </div>
      }
    >
      {lines.length > 0 && <StatusLines id="recipes-status" lines={lines} />}
      {state && state.recipes.length > 0 && (
        <RowList id="recipe-list">
          {state.recipes.map((recipe) => (
            <Row
              key={recipe.id}
              main={
                <>
                  <RowTitle>{recipe.origin}</RowTitle>
                  <RowSub>
                    {recipe.id} · revision {recipe.revision}
                    {recipe.kind === "login" ? "" : ` · ${recipe.kind} page`}
                  </RowSub>
                </>
              }
              actions={
                device && (
                  <Button
                    type="button"
                    variant="danger"
                    disabled={busy}
                    aria-label={`Remove recipe ${recipe.id}`}
                    onClick={() =>
                      void act(async () =>
                        receive(await client.remove(recipe.id), `Removed recipe ${recipe.id}.`),
                      )
                    }
                  >
                    Remove
                  </Button>
                )
              }
            />
          ))}
        </RowList>
      )}
      {device && state.recipes.length === 0 && (
        <p className="m-0 text-sm text-ink-muted">No recipes are saved on this device.</p>
      )}
      {(unreadable || (paired && state.waiting > 0)) && (
        <div>
          <Button
            id="clear-recipes"
            type="button"
            variant="danger"
            disabled={busy}
            onClick={() =>
              void act(async () =>
                receive(await client.clear(), "Removed the recipes saved on this device."),
              )
            }
          >
            {unreadable ? "Remove all saved recipes" : "Discard recipes not uploaded"}
          </Button>
        </div>
      )}
      <output
        id="recipes-message"
        className="settings-status block text-sm leading-5"
        aria-live="polite"
        aria-atomic="true"
      >
        {message}
      </output>
    </Panel>
  );
}
