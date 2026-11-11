import type { LocalSettings, ModelProvider } from "@pateat/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Cloud, Info, KeyRound, Wallet } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import * as v from "valibot";
import { i18n } from "../i18n";
import {
  currentSpend,
  DEFAULT_DEVICE_DAILY_LIMIT_USD,
  DEFAULT_DEVICE_MONTHLY_LIMIT_USD,
  DEVICE_CLEF_KEY,
  DEVICE_MODEL_KEY,
  DEVICE_MODEL_SPEND_KEY,
  deviceClefSettingSchema,
  deviceModelKeySchema,
  deviceModelSettingSchema,
  MAX_DEVICE_LIMIT_USD,
  parseDeviceClefSetting,
  parseDeviceModelSetting,
  spendLimits,
  type DeviceClefSetting,
  type DeviceModelSetting,
} from "../service/device-model";
import { trustedRecord } from "../storage";
import { Button } from "./button";
import { controlClass, fieldClass, Panel, StatusLines } from "./ui";

/** What the panel shows of this device's key (ADR 0040); the key itself never comes back. */
export type DeviceModelView =
  | { saved: false }
  | {
      saved: true;
      provider: ModelProvider;
      /** The key's last four characters, to tell keys apart. */
      ending: string;
      spentTodayUsd: number;
      spentMonthUsd: number;
    };

/** What the panel shows of this device's Cloudflare token for Clef (ADR 0083). */
export type DeviceClefView = { saved: false } | { saved: true; accountEnding: string };

/** Reads and writes this device's Cloudflare account and token, which are never synced. */
export interface DeviceClefClient {
  read(): Promise<DeviceClefView>;
  save(change: { accountId: string; apiToken: string }): Promise<void>;
  remove(): Promise<void>;
}

/** Reads and writes this device's key, which is never synced. */
export interface DeviceModelClient {
  read(): Promise<DeviceModelView>;
  save(change: { provider: ModelProvider; apiKey: string }): Promise<void>;
  remove(): Promise<void>;
  /** This device's Cloudflare token for Clef (ADR 0083). */
  clef?: DeviceClefClient;
}

/** The settings page's own `storage.local` records; the service worker reads them per request. */
export function createDeviceModelClient(now: () => number = Date.now): DeviceModelClient {
  const record = trustedRecord<DeviceModelSetting>(DEVICE_MODEL_KEY);
  const spend = trustedRecord(DEVICE_MODEL_SPEND_KEY);
  return {
    async read() {
      const setting = parseDeviceModelSetting(await record.read());
      if (!setting) return { saved: false };
      const spent = currentSpend(await spend.read().catch(() => undefined), now());
      return {
        saved: true,
        provider: setting.provider,
        ending: setting.apiKey.slice(-4),
        spentTodayUsd: spent.dayMicroUsd / 1_000_000,
        spentMonthUsd: spent.monthMicroUsd / 1_000_000,
      };
    },
    async save({ provider, apiKey }) {
      await record.write(v.parse(deviceModelSettingSchema, { version: 1, provider, apiKey }));
    },
    remove: () => record.clear(),
    clef: createDeviceClefClient(),
  };
}

function createDeviceClefClient(): DeviceClefClient {
  const record = trustedRecord<DeviceClefSetting>(DEVICE_CLEF_KEY);
  return {
    async read() {
      const setting = parseDeviceClefSetting(await record.read());
      return setting
        ? { saved: true, accountEnding: setting.accountId.slice(-4) }
        : { saved: false };
    },
    async save(change) {
      await record.write(v.parse(deviceClefSettingSchema, { version: 1, ...change }));
    },
    remove: () => record.clear(),
  };
}

const QUERY_KEY = ["settings", "device-model"] as const;
const usd = (amount: number) =>
  amount.toLocaleString(i18n.language, { style: "currency", currency: "USD" });

/** A dollar amount as typed, or undefined when it is not one in range. */
function limitOf(text: string): number | undefined {
  const amount = Number(text);
  return text.trim() !== "" &&
    Number.isFinite(amount) &&
    amount >= 0 &&
    amount <= MAX_DEVICE_LIMIT_USD
    ? Math.round(amount * 100) / 100
    : undefined;
}

/**
 * This device's own text-model API key (ADR 0040): with one saved, this device makes the
 * model calls for recipes itself, also while paired, and stops at the spend limits. The key
 * stays on the device; the limits are the profile setting `modelSpendLimits`, synced with
 * the others (ADR 0024).
 */
export function DeviceModelPanel({
  client,
  draft,
  edit,
}: {
  client: DeviceModelClient;
  /** Absent until the settings are loaded; the limits wait for them. */
  draft?: LocalSettings;
  edit: (update: (value: LocalSettings) => void) => boolean;
}) {
  const { t } = useTranslation(undefined, { i18n });
  const queryClient = useQueryClient();
  const [message, setMessage] = useState("");
  const [key, setKey] = useState("");
  const [selectedProvider, setProvider] = useState<ModelProvider>();
  // The limits as typed; saved once they are amounts in range.
  const [daily, setDaily] = useState<string>();
  const [monthly, setMonthly] = useState<string>();
  const view = useQuery({ queryKey: QUERY_KEY, queryFn: () => client.read(), retry: false });
  const refresh = () => queryClient.invalidateQueries({ queryKey: QUERY_KEY });
  const save = useMutation({
    mutationFn: (change: Parameters<DeviceModelClient["save"]>[0]) => client.save(change),
    onMutate: () => setMessage(t("Saving…")),
    onSuccess: () => {
      setKey("");
      setMessage(t("Saved on this device."));
      void refresh();
    },
    onError: () => setMessage(t("The key could not be saved. Try again.")),
  });
  const remove = useMutation({
    mutationFn: () => client.remove(),
    onMutate: () => setMessage(t("Removing…")),
    onSuccess: () => {
      setMessage(t("The key was removed from this device."));
      void refresh();
    },
    onError: () => setMessage(t("The key could not be removed. Try again.")),
  });
  const current = view.data;
  const provider = selectedProvider ?? (current?.saved ? current.provider : "anthropic");
  const providerName = provider === "openai" ? "OpenAI" : "Anthropic";
  const busy = !current || save.isPending || remove.isPending;
  const limits = draft && spendLimits(draft);
  function saveKey() {
    const parsed = v.safeParse(deviceModelKeySchema, key);
    if (!parsed.success) {
      setMessage(t("Paste the whole API key for the selected provider."));
      return;
    }
    save.mutate({ provider, apiKey: parsed.output });
  }
  function saveLimit(which: "dailyUsd" | "monthlyUsd", text: string) {
    if (!limits) return;
    const amount = limitOf(text);
    if (amount === undefined) {
      setMessage(
        t("Enter an amount in US dollars from 0 to {{max}}.", {
          max: MAX_DEVICE_LIMIT_USD.toLocaleString(i18n.language),
        }),
      );
      return;
    }
    // Enter and then leaving the field save once.
    if (amount === limits[which]) {
      if (which === "dailyUsd") setDaily(undefined);
      else setMonthly(undefined);
      return;
    }
    const next = { ...limits, [which]: amount };
    // Stored only when it differs from the defaults, as in the synced document.
    const saved = edit((value) => {
      if (
        next.dailyUsd === DEFAULT_DEVICE_DAILY_LIMIT_USD &&
        next.monthlyUsd === DEFAULT_DEVICE_MONTHLY_LIMIT_USD
      )
        delete value.modelSpendLimits;
      else value.modelSpendLimits = next;
    });
    if (saved) {
      setMessage("");
      if (which === "dailyUsd") setDaily(undefined);
      else setMonthly(undefined);
    }
  }
  const limitField = (
    which: "dailyUsd" | "monthlyUsd",
    label: string,
    typed: string | undefined,
    setTyped: (text: string) => void,
  ) => (
    <label className={fieldClass}>
      {label}
      <input
        id={which === "dailyUsd" ? "device-model-daily" : "device-model-monthly"}
        className={controlClass}
        type="number"
        inputMode="decimal"
        min={0}
        max={MAX_DEVICE_LIMIT_USD}
        step={0.01}
        disabled={!limits}
        value={typed ?? (limits ? String(limits[which]) : "")}
        onChange={(event) => setTyped(event.target.value)}
        onBlur={(event) => saveLimit(which, event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") saveLimit(which, event.currentTarget.value);
        }}
      />
    </label>
  );
  return (
    <Panel id="ai-key" headingId="ai-key-heading" title={t("AI key")}>
      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          saveKey();
        }}
      >
        <label className={fieldClass}>
          {t("Text model provider")}
          <select
            id="device-model-provider"
            className={controlClass}
            value={provider}
            disabled={busy}
            onChange={(event) => {
              setProvider(event.target.value as ModelProvider);
              setKey("");
              setMessage("");
            }}
          >
            <option value="anthropic">Anthropic</option>
            <option value="openai">OpenAI</option>
          </select>
        </label>
        <label className={`${fieldClass} min-w-0 flex-[1_1_18rem]`}>
          {current?.saved && current.provider === provider
            ? t("Replace the {{provider}} API key", { provider: providerName })
            : t("{{provider}} API key", { provider: providerName })}
          <input
            id="device-model-key"
            className={controlClass}
            type="password"
            autoComplete="off"
            spellCheck={false}
            disabled={busy}
            value={key}
            placeholder={
              current?.saved && current.provider === provider
                ? `••••${current.ending}`
                : provider === "openai"
                  ? "sk-…"
                  : "sk-ant-…"
            }
            aria-describedby="device-model-note"
            onChange={(event) => setKey(event.target.value)}
          />
        </label>
        <Button id="device-model-save" type="submit" disabled={busy || key.trim() === ""}>
          {t("Save key")}
        </Button>
        {current?.saved && (
          <Button
            id="device-model-remove"
            type="button"
            variant="danger"
            disabled={busy}
            onClick={() => remove.mutate()}
          >
            {t("Remove key")}
          </Button>
        )}
      </form>
      {client.clef && <DeviceClefForm client={client.clef} />}
      <div className="grid gap-x-4 gap-y-3 sm:grid-cols-2">
        {limitField("dailyUsd", t("Daily limit (USD)"), daily, setDaily)}
        {limitField("monthlyUsd", t("Monthly limit (USD)"), monthly, setMonthly)}
      </div>
      <output id="device-model-message" className="text-sm" aria-live="polite">
        {message}
      </output>
      <StatusLines
        id="device-model-note"
        muted
        lines={[
          current?.saved
            ? {
                tone: "ok" as const,
                icon: KeyRound,
                text: t(
                  "{{provider}} key ending in {{ending}} saved. This device uses it, also while paired: the sync service then only keeps and shares the recipes and settings.",
                  {
                    ending: current.ending,
                    provider: current.provider === "openai" ? "OpenAI" : "Anthropic",
                  },
                ),
              }
            : {
                tone: "idle" as const,
                icon: KeyRound,
                text: view.isError
                  ? t("The saved key could not be read.")
                  : t(
                      "Without a key, the paired sync service uses its owner's configured provider, and a device without a pairing makes no recipes.",
                    ),
              },
          ...(current?.saved
            ? [
                {
                  tone: "idle" as const,
                  icon: Wallet,
                  text: t(
                    "Spent on this device: {{today}} today and {{month}} this month (UTC), estimated from provider usage. Requests stop at either limit. Changing keys or providers keeps this total.",
                    { today: usd(current.spentTodayUsd), month: usd(current.spentMonthUsd) },
                  ),
                },
              ]
            : []),
          {
            tone: "idle",
            icon: Info,
            text: t(
              "The limits apply on all your devices, each counting its own spend; keys are saved per device.",
            ),
          },
          {
            tone: "idle",
            icon: Info,
            text: t(
              "The key stays on this device and is sent to its selected provider only, never to the sync service. Without a paired sync service, this device makes recipes with it and keeps them here.",
            ),
          },
        ]}
      />
    </Panel>
  );
}

const CLEF_QUERY_KEY = ["settings", "device-clef"] as const;

/**
 * This device's Cloudflare account and API token for Clef (ADR 0083): with them and the
 * text-model key, this device asks Clef first for a sign-in form, paired or not. They stay
 * on the device like the key, and Clef's spend counts toward the same limits.
 */
function DeviceClefForm({ client }: { client: DeviceClefClient }) {
  const { t } = useTranslation(undefined, { i18n });
  const queryClient = useQueryClient();
  const [message, setMessage] = useState("");
  const [accountId, setAccountId] = useState("");
  const [token, setToken] = useState("");
  const view = useQuery({ queryKey: CLEF_QUERY_KEY, queryFn: () => client.read(), retry: false });
  const refresh = () => queryClient.invalidateQueries({ queryKey: CLEF_QUERY_KEY });
  const save = useMutation({
    mutationFn: (change: Parameters<DeviceClefClient["save"]>[0]) => client.save(change),
    onMutate: () => setMessage(t("Saving…")),
    onSuccess: () => {
      setAccountId("");
      setToken("");
      setMessage(t("Saved on this device."));
      void refresh();
    },
    onError: () => setMessage(t("The token could not be saved. Try again.")),
  });
  const remove = useMutation({
    mutationFn: () => client.remove(),
    onMutate: () => setMessage(t("Removing…")),
    onSuccess: () => {
      setMessage(t("The token was removed from this device."));
      void refresh();
    },
    onError: () => setMessage(t("The token could not be removed. Try again.")),
  });
  const current = view.data;
  const busy = !current || save.isPending || remove.isPending;
  function saveToken() {
    const parsed = v.safeParse(deviceClefSettingSchema, { version: 1, accountId, apiToken: token });
    if (!parsed.success) {
      setMessage(
        t(
          "Paste the 32-character account ID and the whole API token from the Cloudflare dashboard.",
        ),
      );
      return;
    }
    save.mutate({ accountId: parsed.output.accountId, apiToken: parsed.output.apiToken });
  }
  return (
    <>
      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          saveToken();
        }}
      >
        <label className={`${fieldClass} min-w-0 flex-[1_1_14rem]`}>
          {t("Cloudflare account ID")}
          <input
            id="device-clef-account"
            className={controlClass}
            type="text"
            autoComplete="off"
            spellCheck={false}
            disabled={busy}
            value={accountId}
            placeholder={current?.saved ? `…${current.accountEnding}` : ""}
            aria-describedby="device-clef-note"
            onChange={(event) => setAccountId(event.target.value)}
          />
        </label>
        <label className={`${fieldClass} min-w-0 flex-[1_1_14rem]`}>
          {current?.saved ? t("Replace the Cloudflare API token") : t("Cloudflare API token")}
          <input
            id="device-clef-token"
            className={controlClass}
            type="password"
            autoComplete="off"
            spellCheck={false}
            disabled={busy}
            value={token}
            aria-describedby="device-clef-note"
            onChange={(event) => setToken(event.target.value)}
          />
        </label>
        <Button
          id="device-clef-save"
          type="submit"
          disabled={busy || accountId.trim() === "" || token.trim() === ""}
        >
          {t("Save token")}
        </Button>
        {current?.saved && (
          <Button
            id="device-clef-remove"
            type="button"
            variant="danger"
            disabled={busy}
            onClick={() => remove.mutate()}
          >
            {t("Remove token")}
          </Button>
        )}
      </form>
      <output id="device-clef-message" className="text-sm" aria-live="polite">
        {message}
      </output>
      <StatusLines
        id="device-clef-note"
        muted
        lines={[
          {
            tone: current?.saved ? ("ok" as const) : ("idle" as const),
            icon: Cloud,
            text: current?.saved
              ? t("Cloudflare token saved for the account ending in {{ending}}.", {
                  ending: current.accountEnding,
                })
              : view.isError
                ? t("The saved token could not be read.")
                : t(
                    "With a Cloudflare token as well, this device asks Cloudflare's Clef first for a sign-in form, also while paired, and the selected text model when Clef is not sure. Clef's spend counts toward the same limits.",
                  ),
          },
          {
            tone: "idle",
            icon: Info,
            text: t(
              "Create the token with Use REST API on the Workers AI page of the Cloudflare dashboard (Workers AI Read and Edit). It stays on this device and is sent to Cloudflare only, never to the sync service.",
            ),
          },
        ]}
      />
    </>
  );
}
