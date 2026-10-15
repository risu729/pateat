import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Info, Lock } from "lucide-react";
import { useState } from "react";
import { VAULT_TIMEOUTS, type VaultTimeout } from "../vault/timeout";
import { controlClass, fieldClass, Panel, StatusLines } from "./ui";

/** Reads and writes this device's vault timeout; it is never synced. */
export interface VaultTimeoutClient {
  read(): Promise<VaultTimeout>;
  write(value: VaultTimeout): Promise<void>;
}

const QUERY_KEY = ["settings", "vault-timeout"] as const;

export function vaultTimeoutLabel(value: VaultTimeout): string {
  if (value === "never") return "Never";
  if (value === "restart") return "On browser restart";
  if (value < 60)
    return `${value} ${value === 1 ? "minute" : "minutes"} unused, or on browser restart`;
  const hours = value / 60;
  return `${hours} ${hours === 1 ? "hour" : "hours"} unused, or on browser restart`;
}

/** The vault timeout, as the official Bitwarden extension offers one. */
export function VaultTimeoutPanel({ client }: { client: VaultTimeoutClient }) {
  const queryClient = useQueryClient();
  const [message, setMessage] = useState("");
  const timeout = useQuery({ queryKey: QUERY_KEY, queryFn: () => client.read(), retry: false });
  const save = useMutation({
    mutationFn: (value: VaultTimeout) => client.write(value),
    onMutate: () => setMessage("Saving…"),
    onSuccess: (_result, value) => {
      queryClient.setQueryData(QUERY_KEY, value);
      setMessage("Saved on this device");
    },
    onError: () => setMessage("The vault timeout could not be saved"),
  });
  return (
    <Panel id="vault-timeout" headingId="vault-timeout-heading" title="Vault timeout">
      <label className={`${fieldClass} max-w-[26rem]`}>
        Lock the vault
        <select
          id="vault-timeout-select"
          className={controlClass}
          disabled={!timeout.isSuccess || save.isPending}
          value={timeout.data ?? ""}
          aria-describedby="vault-timeout-note"
          onChange={(event) => {
            const value = VAULT_TIMEOUTS.find((entry) => String(entry) === event.target.value);
            if (value !== undefined) save.mutate(value);
          }}
        >
          {!timeout.isSuccess && (
            <option value="">{timeout.isError ? "Unavailable" : "Loading…"}</option>
          )}
          {VAULT_TIMEOUTS.map((value) => (
            <option key={value} value={String(value)}>
              {vaultTimeoutLabel(value)}
            </option>
          ))}
        </select>
      </label>
      <output id="vault-timeout-message" className="text-sm" aria-live="polite">
        {message}
      </output>
      <StatusLines
        id="vault-timeout-note"
        muted
        lines={[
          {
            tone: "idle",
            icon: Lock,
            text: "Locking turns automatic unlock off for every vault on this device; sign in again to unlock",
          },
          {
            tone: "idle",
            icon: Info,
            text: "Unused means no login filled from the vault and no passkey signed; this setting stays on this device",
          },
        ]}
      />
    </Panel>
  );
}
