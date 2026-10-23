import {
  DEFAULT_MODEL_CONFIG,
  MAX_MODEL_CHOICES,
  modelRoles,
  type ManageModelOption,
  type ManageModels,
  type ModelChoice,
  type ModelConfig,
  type ModelRole,
} from "@pateat/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, Gauge, ListOrdered, TriangleAlert } from "lucide-react";
import { useState } from "react";
import { describeError, ManageApiError, type ManageClient } from "./api";
import { Button } from "./button";
import { ErrorNotice, Line, Lines, Panel, SuccessNotice } from "./ui";

export const MODELS_QUERY_KEY = ["models"] as const;

const ROLE_TITLES: Record<ModelRole, string> = {
  generate: "Recipe generation",
  judge: "Sign-in judge",
};
const EFFORT_LABELS = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
};
const SELECT_CLASSES = "min-h-10 rounded-lg border border-border-strong bg-surface px-3";

const price = (rates: { input: number; output: number }) =>
  `$${rates.input} / $${rates.output} per million tokens`;

/** Why a model cannot be chosen, or nothing when it can. */
function unavailable(model: ManageModelOption) {
  if (model.rates === null) return "no published price yet";
  if (model.efforts.length === 0) return "no longer offered";
  return undefined;
}

/** Whether every choice names a model the list offers, as the service checks on saving. */
function offersConfig(models: readonly ManageModelOption[], config: ModelConfig) {
  return [...config.generate, ...config.judge].every((choice) => {
    const model = models.find((entry) => entry.id === choice.model);
    return (
      model !== undefined &&
      unavailable(model) === undefined &&
      model.efforts.includes(choice.effort) &&
      (choice.speed === "standard" || model.fast === "available")
    );
  });
}

/** A choice moved to another model keeps its effort and speed where that model allows them. */
function withModel(choice: ModelChoice, model: ManageModelOption): ModelChoice {
  return {
    ...choice,
    model: model.id,
    effort: model.efforts.includes(choice.effort) ? choice.effort : (model.efforts[0] ?? "low"),
    speed: model.fast === "available" ? choice.speed : "standard",
  };
}

/**
 * The owner's model configuration (ADR 0014): for each role, the model, effort and speed
 * to ask first, then the fallbacks asked in order after a refusal. Fast mode that fails
 * asks the same model at the standard speed. Only the Claude page reads or changes it.
 */
export function ModelsPanel({ client }: { client: ManageClient }) {
  const queryClient = useQueryClient();
  // Read once per visit: each read exchanges a new token and calls the Models API.
  const models = useQuery({
    queryKey: MODELS_QUERY_KEY,
    queryFn: () => client.models(),
    staleTime: Number.POSITIVE_INFINITY,
    refetchOnWindowFocus: false,
  });
  // The owner's unsaved edit; null while the panel shows the saved configuration.
  const [draft, setDraft] = useState<ModelConfig | null>(null);
  const save = useMutation({
    mutationFn: (config: ModelConfig) => client.saveModels(config),
    onSuccess: (view) => {
      queryClient.setQueryData(MODELS_QUERY_KEY, view);
      setDraft(null);
    },
    onError: (error) => {
      if (error instanceof ManageApiError && error.code === "model_unavailable")
        void queryClient.invalidateQueries({ queryKey: MODELS_QUERY_KEY });
    },
  });

  return (
    <Panel id="models-heading" title="Models">
      <SuccessNotice id="models-saved" message={save.isSuccess && "Models saved"} />
      {save.isError && <ErrorNotice id="models-error">{describeError(save.error)}</ErrorNotice>}
      {models.isPending ? (
        <output id="models-status" className="block">
          Loading models…
        </output>
      ) : models.isError ? (
        <ErrorNotice id="models-status">{describeError(models.error)}</ErrorNotice>
      ) : (
        <ModelsForm
          view={models.data}
          config={draft ?? models.data.config}
          onChange={setDraft}
          saving={save.isPending}
          onSave={(config) => save.mutate(config)}
        />
      )}
      <Lines>
        <Line icon={<ListOrdered size={16} aria-hidden />}>
          A refusal asks the next model in the list; any other failure ends the request
        </Line>
        <Line icon={<Gauge size={16} aria-hidden />}>
          Fast mode costs more; when it fails, the same model is asked at the standard speed
        </Line>
      </Lines>
    </Panel>
  );
}

function ModelsForm({
  view,
  config,
  onChange,
  saving,
  onSave,
}: {
  view: ManageModels;
  config: ModelConfig;
  onChange: (config: ModelConfig) => void;
  saving: boolean;
  onSave: (config: ModelConfig) => void;
}) {
  const setRole = (role: ModelRole, choices: ModelChoice[]) =>
    onChange({ ...config, [role]: choices });
  const offered = view.models.filter((model) => unavailable(model) === undefined);
  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        onSave(config);
      }}
    >
      {view.catalog === "pricing" && (
        <p className="flex items-start gap-2 rounded-xl bg-warning-tint px-3 py-2.5 text-sm">
          <TriangleAlert size={16} aria-hidden className="mt-0.5 flex-none" />
          The model list could not be read with your Claude credential, so every model on the
          pricing page is listed with every effort; one the model does not accept fails.
        </p>
      )}
      {!view.saved && <p className="text-sm text-ink-muted">These are the defaults.</p>}
      {modelRoles.map((role) => (
        <section key={role} aria-labelledby={`models-${role}`} className="space-y-3">
          <h3 id={`models-${role}`} className="text-base font-semibold">
            {ROLE_TITLES[role]}
          </h3>
          <ol className="space-y-3">
            {config[role].map((choice, index) => (
              <ChoiceRow
                // A row is its place in the order; keyed by model, changing one would
                // remount it and lose the select's focus.
                // oxlint-disable-next-line react/no-array-index-key
                key={index}
                role={role}
                index={index}
                count={config[role].length}
                choice={choice}
                models={view.models}
                taken={config[role].filter((_, at) => at !== index).map((entry) => entry.model)}
                onChange={(next) =>
                  setRole(
                    role,
                    config[role].map((entry, at) => (at === index ? next : entry)),
                  )
                }
                onMove={(offset) => {
                  const choices = [...config[role]];
                  const [moved] = choices.splice(index, 1);
                  choices.splice(index + offset, 0, moved!);
                  setRole(role, choices);
                }}
                onRemove={() =>
                  setRole(
                    role,
                    config[role].filter((_, at) => at !== index),
                  )
                }
              />
            ))}
          </ol>
          {(() => {
            const unused = offered.find(
              (model) => !config[role].some((choice) => choice.model === model.id),
            );
            return (
              config[role].length < MAX_MODEL_CHOICES &&
              unused && (
                <Button
                  variant="outline"
                  id={`models-${role}-add`}
                  onClick={() =>
                    setRole(role, [
                      ...config[role],
                      withModel(
                        {
                          provider: "anthropic",
                          model: unused.id,
                          effort: "low",
                          speed: "standard",
                        },
                        unused,
                      ),
                    ])
                  }
                >
                  Add a fallback
                </Button>
              )
            );
          })()}
        </section>
      ))}
      <div className="flex flex-wrap gap-3">
        <Button type="submit" id="models-save" disabled={saving}>
          Save models
        </Button>
        <Button
          variant="outline"
          id="models-defaults"
          // The defaults can be saved only while the list offers them.
          disabled={saving || !offersConfig(view.models, DEFAULT_MODEL_CONFIG)}
          onClick={() => onChange(DEFAULT_MODEL_CONFIG)}
        >
          Use the defaults
        </Button>
      </div>
    </form>
  );
}

function ChoiceRow({
  role,
  index,
  count,
  choice,
  models,
  taken,
  onChange,
  onMove,
  onRemove,
}: {
  role: ModelRole;
  index: number;
  count: number;
  choice: ModelChoice;
  models: ManageModelOption[];
  /** The models the role's other choices name: each appears once per role. */
  taken: string[];
  onChange: (choice: ModelChoice) => void;
  onMove: (offset: -1 | 1) => void;
  onRemove: () => void;
}) {
  const id = `models-${role}-${index}`;
  const model = models.find((entry) => entry.id === choice.model);
  const name = model?.displayName ?? choice.model;
  const fastNote =
    model?.fast === "failing"
      ? "Fast (unavailable: its last calls failed)"
      : model?.fast === "none"
        ? "Fast (not offered for this model)"
        : "Fast";
  return (
    <li className="space-y-2 border-t border-border pt-3 first:border-t-0 first:pt-0">
      <p className="text-sm font-semibold">
        {index === 0 ? "First" : `Fallback ${index} after a refusal`}
      </p>
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-sm">
          Model
          <select
            id={`${id}-model`}
            value={choice.model}
            className={SELECT_CLASSES}
            onChange={(event) => {
              const next = models.find((entry) => entry.id === event.target.value);
              if (next) onChange(withModel(choice, next));
            }}
          >
            {models.map((entry) => {
              const reason = taken.includes(entry.id) ? "already in this list" : unavailable(entry);
              return (
                <option key={entry.id} value={entry.id} disabled={reason !== undefined}>
                  {entry.displayName}
                  {reason ? ` (${reason})` : ` – ${price(entry.rates!)}`}
                </option>
              );
            })}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          Effort
          <select
            id={`${id}-effort`}
            value={choice.effort}
            className={SELECT_CLASSES}
            onChange={(event) =>
              onChange({ ...choice, effort: event.target.value as ModelChoice["effort"] })
            }
          >
            {(model?.efforts ?? [choice.effort]).map((effort) => (
              <option key={effort} value={effort}>
                {EFFORT_LABELS[effort]}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          Speed
          <select
            id={`${id}-speed`}
            value={choice.speed}
            className={SELECT_CLASSES}
            onChange={(event) =>
              onChange({ ...choice, speed: event.target.value as ModelChoice["speed"] })
            }
          >
            <option value="standard">Standard</option>
            <option value="fast" disabled={model?.fast !== "available"}>
              {fastNote}
              {model?.fast === "available" && model.fastRates ? ` – ${price(model.fastRates)}` : ""}
            </option>
          </select>
        </label>
        <span className="flex gap-1">
          <Button
            variant="ghost"
            aria-label={`Move ${name} up`}
            disabled={index === 0}
            onClick={() => onMove(-1)}
          >
            <ArrowUp size={16} aria-hidden />
          </Button>
          <Button
            variant="ghost"
            aria-label={`Move ${name} down`}
            disabled={index === count - 1}
            onClick={() => onMove(1)}
          >
            <ArrowDown size={16} aria-hidden />
          </Button>
          <Button
            variant="danger"
            aria-label={`Remove ${name}`}
            disabled={count === 1}
            onClick={onRemove}
          >
            Remove
          </Button>
        </span>
      </div>
      {model?.fast === "failing" && choice.speed === "fast" && (
        <p className="text-sm text-danger">
          Fast mode failed on this model's last calls, so it cannot be saved; choose Standard.
        </p>
      )}
    </li>
  );
}
