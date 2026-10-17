import {
  wifIdentifiersSchema,
  type ManageClaudeTest,
  type WifIdentifiers,
} from "@pateat/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Archive, KeyRound } from "lucide-react";
import { useId, useRef, useState, type FormEvent } from "react";
import * as v from "valibot";
import { describeError, ManageApiError, type ManageClient } from "./api";
import { Button } from "./button";
import {
  ErrorNotice,
  KeyValues,
  Line,
  Lines,
  PAGE_TITLE_CLASSES,
  Panel,
  SuccessNotice,
} from "./ui";

export const CLAUDE_QUERY_KEY = ["claude"] as const;

type FieldName = keyof WifIdentifiers;

/** The identifiers in the order the Console shows them, with what each must look like. */
const FIELDS: readonly { name: FieldName; label: string; placeholder: string; hint: string }[] = [
  {
    name: "federationRuleId",
    label: "Federation rule ID",
    placeholder: "fdrl_…",
    hint: "Enter the rule's ID, which starts with fdrl_.",
  },
  {
    name: "organizationId",
    label: "Organization ID",
    placeholder: "00000000-0000-0000-0000-000000000000",
    hint: "Enter the organization's UUID.",
  },
  {
    name: "serviceAccountId",
    label: "Service account ID",
    placeholder: "svac_…",
    hint: "Enter the service account's ID, which starts with svac_.",
  },
  {
    name: "workspaceId",
    label: "Workspace ID",
    placeholder: "wrkspc_…",
    hint: "Enter the workspace's ID, which starts with wrkspc_.",
  },
];

const STORED_INVALID = "The saved identifiers are no longer valid. Enter them again.";

const EMPTY: Record<FieldName, string> = {
  federationRuleId: "",
  organizationId: "",
  serviceAccountId: "",
  workspaceId: "",
};

function validFor(seconds: number) {
  return seconds < 120
    ? `${seconds} second${seconds === 1 ? "" : "s"}`
    : `${Math.round(seconds / 60)} minutes`;
}

const withStatus = (text: string, httpStatus: number | undefined) =>
  httpStatus ? `${text} (HTTP ${httpStatus})` : text;

/** What a token exchange's outcome means to the owner. */
export function describeTestResult(result: ManageClaudeTest["result"]): string {
  switch (result.status) {
    case "ready":
      return `Anthropic issued a token valid for ${validFor(result.expiresInSeconds)}.`;
    case "not_configured":
      return "Save the identifiers first.";
    case "stored_invalid":
      return STORED_INVALID;
    case "issuer_unavailable":
      return "This service's OIDC issuer is not configured, so nothing can be signed.";
    case "rejected":
      return `${withStatus("Anthropic refused the assertion", result.httpStatus)}. Check the identifiers and the rule, then look at the authentication history in the Claude Console for the reason.`;
    case "failed":
      return `${withStatus("The token exchange did not complete", result.httpStatus)}. Try again later.`;
  }
}

/**
 * Claude credentials (ADR 0015): the values to enter in the owner's Claude Console, the
 * federation rule's identifiers saved here, and a free test of the token exchange.
 */
export function ClaudePage({ client }: { client: ManageClient }) {
  const queryClient = useQueryClient();
  const claude = useQuery({ queryKey: CLAUDE_QUERY_KEY, queryFn: () => client.claude() });
  const [notice, setNotice] = useState("");
  const save = useMutation({
    mutationFn: (identifiers: WifIdentifiers) => client.saveClaude(identifiers),
    onSuccess: (state) => {
      queryClient.setQueryData(CLAUDE_QUERY_KEY, state);
      setNotice("Identifiers saved");
    },
  });

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <h1 className={PAGE_TITLE_CLASSES}>Claude</h1>
        <p className="text-ink-muted">
          Pateat generates recipes with Claude in your own Anthropic organization, which pays for
          them. It signs in through Workload Identity Federation, so no API key is stored here.
        </p>
      </div>
      <SuccessNotice id="claude-saved" message={notice} />
      {claude.isPending ? (
        <output id="claude-status" className="block">
          Loading Claude settings…
        </output>
      ) : claude.isError ? (
        <ErrorNotice id="claude-status">{describeError(claude.error)}</ErrorNotice>
      ) : (
        <>
          <Panel id="claude-console-heading" title="Claude Console">
            <p>
              In the Claude Console, open Settings, Workload identity, Connect workload, Custom
              OIDC, and use these values:
            </p>
            <KeyValues
              entries={[
                ["Issuer URL", claude.data.console.issuer ?? "Not configured on this service"],
                ["Subject (exact match)", claude.data.console.subject],
                ["Audience (optional match)", claude.data.console.audience],
                [
                  "Scope",
                  "workspace:inference if the Console offers it, otherwise workspace:developer",
                ],
              ]}
            />
          </Panel>
          <IdentifiersPanel
            // Saving replaces the form with what the service stored.
            key={`identifiers-${JSON.stringify(claude.data.identifiers)}`}
            saved={claude.data.identifiers}
            storedInvalid={claude.data.storedInvalid}
            busy={save.isPending}
            error={save.isError ? save.error : undefined}
            onSave={(identifiers) => {
              setNotice("");
              save.mutate(identifiers);
            }}
          />
          <TestPanel
            // A result for identifiers that were since replaced is not shown.
            key={`test-${JSON.stringify(claude.data.identifiers)}`}
            client={client}
            canTest={claude.data.identifiers !== null}
          />
        </>
      )}
      <Lines>
        <Line icon={<KeyRound size={16} aria-hidden />}>
          None of these values is a secret; tokens last minutes and never reach this page
        </Line>
        <Line icon={<Archive size={16} aria-hidden />}>
          To stop Pateat's access to Claude, archive the federation rule in the Claude Console
        </Line>
      </Lines>
    </div>
  );
}

function IdentifiersPanel({
  saved,
  storedInvalid,
  busy,
  error: saveError,
  onSave,
}: {
  saved: WifIdentifiers | null;
  storedInvalid: boolean;
  busy: boolean;
  error: Error | undefined;
  onSave: (identifiers: WifIdentifiers) => void;
}) {
  const [values, setValues] = useState<Record<FieldName, string>>(saved ?? EMPTY);
  const [errors, setErrors] = useState<Partial<Record<FieldName, string>>>({});
  const inputs = useRef<Partial<Record<FieldName, HTMLInputElement | null>>>({});
  const baseId = useId();

  function submit(event: FormEvent) {
    event.preventDefault();
    const trimmed = Object.fromEntries(
      FIELDS.map(({ name }) => [name, values[name].trim()]),
    ) as Record<FieldName, string>;
    const invalid = Object.fromEntries(
      FIELDS.filter(({ name }) => !v.is(wifIdentifiersSchema.entries[name], trimmed[name])).map(
        ({ name, hint }) => [name, hint],
      ),
    ) as Partial<Record<FieldName, string>>;
    setErrors(invalid);
    const first = FIELDS.find(({ name }) => invalid[name]);
    if (first) {
      inputs.current[first.name]?.focus();
      return;
    }
    onSave(trimmed);
  }

  return (
    <Panel id="claude-identifiers-heading" title="Federation identifiers">
      {storedInvalid && <ErrorNotice id="claude-stored-invalid">{STORED_INVALID}</ErrorNotice>}
      {saveError && (
        <ErrorNotice id="claude-save-error">
          {saveError instanceof ManageApiError && saveError.code === "bad_request"
            ? "The service refused the identifiers. Check them and save again."
            : describeError(saveError)}
        </ErrorNotice>
      )}
      <p>
        {saved
          ? "These identifiers are saved. Copy new ones from the rule in the Console to replace them."
          : "None are saved yet. Copy them from the federation rule the Console created."}
      </p>
      <form noValidate onSubmit={submit} className="grid gap-4 sm:grid-cols-2">
        {FIELDS.map(({ name, label, placeholder }) => {
          const id = `${baseId}-${name}`;
          const error = errors[name];
          return (
            <div key={name} className="flex flex-col gap-1.5">
              <label htmlFor={id} className="text-sm font-semibold">
                {label}
              </label>
              <input
                ref={(element) => {
                  inputs.current[name] = element;
                }}
                id={id}
                name={name}
                autoComplete="off"
                spellCheck={false}
                placeholder={placeholder}
                value={values[name]}
                onChange={(event) => setValues({ ...values, [name]: event.target.value })}
                aria-invalid={error ? true : undefined}
                aria-describedby={error ? `${id}-error` : undefined}
                className="min-h-10 rounded-lg border border-border-strong bg-surface px-3 font-mono text-[13px] placeholder:text-ink-muted"
              />
              {error && (
                <p id={`${id}-error`} className="text-sm text-danger">
                  {error}
                </p>
              )}
            </div>
          );
        })}
        <div className="sm:col-span-2">
          <Button type="submit" disabled={busy}>
            Save
          </Button>
        </div>
      </form>
    </Panel>
  );
}

function TestPanel({ client, canTest }: { client: ManageClient; canTest: boolean }) {
  const queryClient = useQueryClient();
  const test = useMutation({
    mutationFn: () => client.testClaude(),
    onSuccess: ({ result }) => {
      // The page's copy predates a row that stopped validating; show the current state.
      if (result.status === "stored_invalid" || result.status === "not_configured")
        void queryClient.invalidateQueries({ queryKey: CLAUDE_QUERY_KEY });
    },
  });
  const result = test.data?.result;

  return (
    <Panel id="claude-test-heading" title="Test the connection">
      <p>
        Asks Anthropic for a token with the saved identifiers. It does not call Claude, so it costs
        nothing.
      </p>
      <SuccessNotice
        id="claude-test-result"
        message={result?.status === "ready" && describeTestResult(result)}
      />
      {test.isError && (
        <ErrorNotice id="claude-test-error">{describeError(test.error)}</ErrorNotice>
      )}
      {result && result.status !== "ready" && (
        <ErrorNotice id="claude-test-error">{describeTestResult(result)}</ErrorNotice>
      )}
      <Button variant="outline" disabled={!canTest || test.isPending} onClick={() => test.mutate()}>
        {test.isPending ? "Testing…" : "Test the token exchange"}
      </Button>
    </Panel>
  );
}
