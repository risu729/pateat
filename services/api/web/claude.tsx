import {
  wifIdentifiersSchema,
  type ManageClaudeTest,
  type WifIdentifiers,
} from "@pateat/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Archive, CircleX, KeyRound } from "lucide-react";
import { useId, useRef, useState, type FormEvent } from "react";
import * as v from "valibot";
import { describeError, ManageApiError, type ManageClient } from "./api";
import { Button } from "./button";
import { ModelsPanel } from "./models";
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
const FIELDS: readonly {
  name: FieldName;
  label: string;
  placeholder: string;
  hint: string;
  error: string;
}[] = [
  {
    name: "federationRuleId",
    label: "Federation rule ID",
    error: "This is not a federation rule ID.",
    placeholder: "fdrl_…",
    hint: "Enter the rule's ID, which starts with fdrl_.",
  },
  {
    name: "organizationId",
    label: "Organization ID",
    error: "This is not an organization ID.",
    placeholder: "00000000-0000-0000-0000-000000000000",
    hint: "Enter the organization's UUID.",
  },
  {
    name: "serviceAccountId",
    label: "Service account ID",
    error: "This is not a service account ID.",
    placeholder: "svac_…",
    hint: "Enter the service account's ID, which starts with svac_.",
  },
  {
    name: "workspaceId",
    label: "Workspace ID",
    error: "This is not a workspace ID.",
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
 * Everything the service needs to call Claude for the owner (owner, 2026-10-23 12:46 UTC):
 * the values to enter in the owner's Claude Console, the federation rule's identifiers
 * saved here and a free test of the token exchange (ADR 0015), then each role's models
 * (ADR 0014).
 */
export function ClaudePage({ client }: { client: ManageClient }) {
  const queryClient = useQueryClient();
  const claude = useQuery({ queryKey: CLAUDE_QUERY_KEY, queryFn: () => client.claude() });
  const [notice, setNotice] = useState("");
  const test = useMutation({
    mutationFn: () => client.testClaude(),
    onSuccess: ({ result }) => {
      // The page's copy predates a row that stopped validating; show the current state.
      if (result.status === "stored_invalid" || result.status === "not_configured")
        void queryClient.invalidateQueries({ queryKey: CLAUDE_QUERY_KEY });
    },
  });
  const save = useMutation({
    mutationFn: (identifiers: WifIdentifiers) => client.saveClaude(identifiers),
    onSuccess: (state) => {
      queryClient.setQueryData(CLAUDE_QUERY_KEY, state);
      setNotice("Identifiers saved");
      // A result for the identifiers this save replaced no longer applies.
      test.reset();
    },
  });

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <h1 className={PAGE_TITLE_CLASSES}>Claude</h1>
        <p className="text-ink-muted">
          Pateat generates recipes and judges sign-ins with Claude in your own Anthropic
          organization, which pays for them. It signs in through Workload Identity Federation, so no
          API key is stored here.
        </p>
      </div>
      <SuccessNotice id="claude-saved" message={notice} />
      {claude.isPending ? (
        <output id="claude-status" className="block">
          Loading Claude settings…
        </output>
      ) : !claude.data ? (
        <ErrorNotice id="claude-status">{describeError(claude.error)}</ErrorNotice>
      ) : (
        <>
          {/* A failed refetch keeps the page and what the owner typed. */}
          {claude.isError && (
            <ErrorNotice id="claude-status">{describeError(claude.error)}</ErrorNotice>
          )}
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
                  <span key="scope" className="font-sans text-sm">
                    <code className="font-mono text-[13px]">workspace:inference</code> if the
                    Console offers it, otherwise{" "}
                    <code className="font-mono text-[13px]">workspace:developer</code>
                  </span>,
                ],
              ]}
            />
          </Panel>
          <IdentifiersPanel
            saved={claude.data.identifiers}
            storedInvalid={claude.data.storedInvalid}
            busy={save.isPending}
            error={save.isError ? save.error : undefined}
            onSave={(identifiers, saved) => {
              setNotice("");
              save.mutate(identifiers, { onSuccess: saved });
            }}
          />
          <TestPanel
            canTest={claude.data.identifiers !== null}
            pending={test.isPending}
            result={test.data?.result}
            error={test.isError ? test.error : undefined}
            onTest={() => test.mutate()}
          />
          <ModelsPanel client={client} />
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

/**
 * The identifiers form. It starts from the saved identifiers and keeps what the owner
 * types across refetches; a successful save shows the values that were stored.
 */
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
  onSave: (identifiers: WifIdentifiers, saved: () => void) => void;
}) {
  const [values, setValues] = useState<Record<FieldName, string>>(saved ?? EMPTY);
  const [errors, setErrors] = useState<Partial<Record<FieldName, string>>>({});
  // Each failed save renders its errors anew, so they are announced again.
  const [attempt, setAttempt] = useState(0);
  const inputs = useRef<Partial<Record<FieldName, HTMLInputElement | null>>>({});
  const baseId = useId();

  function submit(event: FormEvent) {
    event.preventDefault();
    const trimmed = Object.fromEntries(
      FIELDS.map(({ name }) => [name, values[name].trim()]),
    ) as Record<FieldName, string>;
    const invalid = Object.fromEntries(
      FIELDS.filter(({ name }) => !v.is(wifIdentifiersSchema.entries[name], trimmed[name])).map(
        ({ name, error }) => [name, error],
      ),
    ) as Partial<Record<FieldName, string>>;
    setErrors(invalid);
    setAttempt(attempt + 1);
    const first = FIELDS.find(({ name }) => invalid[name]);
    if (first) {
      inputs.current[first.name]?.focus();
      return;
    }
    onSave(trimmed, () => setValues(trimmed));
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
          : storedInvalid
            ? "Copy them from the federation rule in the Console and save them again."
            : "None are saved yet. Copy them from the federation rule the Console created."}
      </p>
      <form noValidate onSubmit={submit} className="grid gap-4 sm:grid-cols-2">
        {FIELDS.map(({ name, label, placeholder, hint }) => {
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
                aria-required
                aria-invalid={error ? true : undefined}
                aria-describedby={error ? `${id}-error ${id}-hint` : `${id}-hint`}
                className="min-h-10 rounded-lg border border-border-strong bg-surface px-3 font-mono text-[13px] placeholder:text-ink-muted aria-invalid:border-danger"
              />
              {error && (
                <p
                  key={attempt}
                  id={`${id}-error`}
                  role="alert"
                  className="flex items-start gap-1.5 text-[13px]/5 font-semibold text-danger"
                >
                  <CircleX size={14} aria-hidden className="mt-0.5 flex-none" />
                  {error}
                </p>
              )}
              <p id={`${id}-hint`} className="text-[13px]/5 text-ink-muted">
                {hint}
              </p>
            </div>
          );
        })}
        <div className="sm:col-span-2">
          {/* Focus stays on the button while the save runs. */}
          <Button type="submit" focusableWhenDisabled disabled={busy}>
            Save identifiers
          </Button>
        </div>
      </form>
    </Panel>
  );
}

function TestPanel({
  canTest,
  pending,
  result,
  error,
  onTest,
}: {
  canTest: boolean;
  pending: boolean;
  result: ManageClaudeTest["result"] | undefined;
  error: Error | undefined;
  onTest: () => void;
}) {
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
      {error && <ErrorNotice id="claude-test-error">{describeError(error)}</ErrorNotice>}
      {result && result.status !== "ready" && (
        <ErrorNotice id="claude-test-error">{describeTestResult(result)}</ErrorNotice>
      )}
      <Button
        variant="outline"
        // Focus stays on the button while a test runs and when nothing is left to test.
        focusableWhenDisabled
        disabled={!canTest || pending}
        onClick={onTest}
      >
        {pending ? "Testing…" : "Test the token exchange"}
      </Button>
    </Panel>
  );
}
