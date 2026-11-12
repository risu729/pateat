import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { describeError, type ManageClient } from "./api";
import { Button } from "./button";
import { MODELS_QUERY_KEY, ModelsPanel } from "./models";
import { ErrorNotice, PAGE_TITLE_CLASSES, Panel, SuccessNotice } from "./ui";

const OPENAI_QUERY_KEY = ["openai"] as const;

/** The owner's key is entered once and never returned by the service. */
export function OpenAIPage({ client }: { client: ManageClient }) {
  const cache = useQueryClient();
  const state = useQuery({ queryKey: OPENAI_QUERY_KEY, queryFn: () => client.openai() });
  const [apiKey, setApiKey] = useState("");
  const [notice, setNotice] = useState("");
  const fieldId = useId();
  const save = useMutation({
    mutationFn: (key: string) => client.saveOpenAI(key),
    onSuccess: (next) => {
      setApiKey("");
      setNotice("OpenAI key saved");
      cache.setQueryData(OPENAI_QUERY_KEY, next);
      void cache.invalidateQueries({ queryKey: MODELS_QUERY_KEY });
    },
  });
  const remove = useMutation({
    mutationFn: () => client.deleteOpenAI(),
    onSuccess: (next) => {
      setNotice("OpenAI key removed");
      cache.setQueryData(OPENAI_QUERY_KEY, next);
      void cache.invalidateQueries({ queryKey: MODELS_QUERY_KEY });
    },
  });
  const busy = save.isPending || remove.isPending;
  const failed = save.error ?? remove.error;
  return (
    <section className="space-y-6">
      <h1 className={PAGE_TITLE_CLASSES}>OpenAI</h1>
      <p>
        Save your own OpenAI API key to generate recipes and judge sign-ins on this service. Your
        OpenAI project pays for its calls. Choose OpenAI models below to use it.
      </p>
      <Panel id="openai-key-heading" title="API key">
        <SuccessNotice id="openai-notice" message={notice} />
        {failed && <ErrorNotice id="openai-error">{describeError(failed)}</ErrorNotice>}
        {state.isPending ? (
          <output>Loading OpenAI settings...</output>
        ) : state.isError ? (
          <ErrorNotice id="openai-state-error">{describeError(state.error)}</ErrorNotice>
        ) : (
          <>
            <p>
              {state.data.configured
                ? "A key is saved. Enter another key to replace it."
                : "No key is saved."}
            </p>
            {state.data.storage === "unavailable" && (
              <ErrorNotice id="openai-storage">
                The operator has not configured credential storage. Saving and using a key are
                unavailable.
              </ErrorNotice>
            )}
            {state.data.storedInvalid && (
              <ErrorNotice id="openai-invalid">
                The saved key could not be opened. Replace or remove it.
              </ErrorNotice>
            )}
            <form
              className="space-y-3"
              onSubmit={(event) => {
                event.preventDefault();
                if (!apiKey.trim() || busy) return;
                setNotice("");
                remove.reset();
                save.mutate(apiKey.trim());
              }}
            >
              <label className="block text-sm font-semibold" htmlFor={fieldId}>
                OpenAI API key
              </label>
              <input
                id={fieldId}
                type="password"
                autoComplete="off"
                spellCheck={false}
                maxLength={512}
                value={apiKey}
                className="min-h-10 w-full rounded-lg border border-border-strong bg-surface px-3 font-mono text-sm"
                onChange={(event) => {
                  setApiKey(event.target.value);
                  setNotice("");
                }}
              />
              <div className="flex flex-wrap gap-2">
                <Button
                  type="submit"
                  disabled={busy || !apiKey.trim() || state.data.storage !== "ready"}
                >
                  Save key
                </Button>
                <Button
                  type="button"
                  variant="danger"
                  disabled={busy || !state.data.configured}
                  onClick={() => {
                    setNotice("");
                    save.reset();
                    remove.mutate();
                  }}
                >
                  Remove saved key
                </Button>
              </div>
            </form>
            <p className="text-sm text-ink-muted">
              The key is encrypted in the service database and never shown again. Saving makes no
              OpenAI request and does not verify API access.
            </p>
          </>
        )}
      </Panel>
      <ModelsPanel client={client} />
    </section>
  );
}
