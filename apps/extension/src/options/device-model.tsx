import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Info, KeyRound, Wallet } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import * as v from "valibot";
import { i18n } from "../i18n";
import {
  currentSpend,
  DEFAULT_DEVICE_DAILY_LIMIT_USD,
  DEFAULT_DEVICE_MONTHLY_LIMIT_USD,
  DEVICE_MODEL_KEY,
  DEVICE_MODEL_SPEND_KEY,
  deviceModelKeySchema,
  MAX_DEVICE_LIMIT_USD,
  parseDeviceModelSetting,
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
      /** The key's last four characters, to tell keys apart. */
      ending: string;
      dailyLimitUsd: number;
      monthlyLimitUsd: number;
      spentTodayUsd: number;
      spentMonthUsd: number;
    };

/** Reads and writes this device's key and spend stops; they are never synced. */
export interface DeviceModelClient {
  read(): Promise<DeviceModelView>;
  /** Saves a new key, or new stops for the saved one when `apiKey` is absent. */
  save(change: { apiKey?: string; dailyLimitUsd: number; monthlyLimitUsd: number }): Promise<void>;
  remove(): Promise<void>;
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
        ending: setting.apiKey.slice(-4),
        dailyLimitUsd: setting.dailyLimitUsd,
        monthlyLimitUsd: setting.monthlyLimitUsd,
        spentTodayUsd: spent.dayMicroUsd / 1_000_000,
        spentMonthUsd: spent.monthMicroUsd / 1_000_000,
      };
    },
    async save({ apiKey, dailyLimitUsd, monthlyLimitUsd }) {
      const key = apiKey ?? parseDeviceModelSetting(await record.read())?.apiKey;
      if (key === undefined) throw new Error("No key to keep");
      await record.write({
        version: 1,
        apiKey: v.parse(deviceModelKeySchema, key),
        dailyLimitUsd,
        monthlyLimitUsd,
      });
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
 * This device's own Anthropic API key (ADR 0040): with one saved, this device makes the
 * model calls for recipes itself, also while paired, and stops at its own spend limits.
 */
export function DeviceModelPanel({ client }: { client: DeviceModelClient }) {
  const { t } = useTranslation(undefined, { i18n });
  const queryClient = useQueryClient();
  const [message, setMessage] = useState("");
  const [key, setKey] = useState("");
  // The limits as typed; saved once they are amounts in range.
  const [daily, setDaily] = useState<string>();
  const [monthly, setMonthly] = useState<string>();
  const view = useQuery({ queryKey: QUERY_KEY, queryFn: () => client.read(), retry: false });
  const refresh = () => queryClient.invalidateQueries({ queryKey: QUERY_KEY });
  const save = useMutation({
    mutationFn: (change: Parameters<DeviceModelClient["save"]>[0]) => client.save(change),
    onMutate: () => setMessage(t("Saving…")),
    onSuccess: (_result, change) => {
      if (change.apiKey !== undefined) setKey("");
      setDaily(undefined);
      setMonthly(undefined);
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
  const busy = !current || save.isPending || remove.isPending;
  const limits = {
    dailyLimitUsd: current?.saved ? current.dailyLimitUsd : DEFAULT_DEVICE_DAILY_LIMIT_USD,
    monthlyLimitUsd: current?.saved ? current.monthlyLimitUsd : DEFAULT_DEVICE_MONTHLY_LIMIT_USD,
  };
  function saveKey() {
    const parsed = v.safeParse(deviceModelKeySchema, key);
    if (!parsed.success) {
      setMessage(t("Paste the whole API key from the Claude Console."));
      return;
    }
    save.mutate({ apiKey: parsed.output, ...limits });
  }
  function saveLimit(which: "dailyLimitUsd" | "monthlyLimitUsd", text: string) {
    // Enter and then leaving the field save once.
    if (!current?.saved || save.isPending) return;
    const amount = limitOf(text);
    if (amount === undefined) {
      setMessage(
        t("Enter an amount in US dollars from 0 to {{max}}.", {
          max: MAX_DEVICE_LIMIT_USD.toLocaleString(i18n.language),
        }),
      );
      return;
    }
    if (amount !== current[which]) save.mutate({ ...limits, [which]: amount });
  }
  const limitField = (
    which: "dailyLimitUsd" | "monthlyLimitUsd",
    label: string,
    typed: string | undefined,
    setTyped: (text: string) => void,
  ) => (
    <label className={fieldClass}>
      {label}
      <input
        id={which === "dailyLimitUsd" ? "device-model-daily" : "device-model-monthly"}
        className={controlClass}
        type="number"
        inputMode="decimal"
        min={0}
        max={MAX_DEVICE_LIMIT_USD}
        step={0.01}
        disabled={busy || !current?.saved}
        value={typed ?? String(limits[which])}
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
        <label className={`${fieldClass} min-w-0 flex-[1_1_18rem]`}>
          {current?.saved ? t("Replace the Anthropic API key") : t("Anthropic API key")}
          <input
            id="device-model-key"
            className={controlClass}
            type="password"
            autoComplete="off"
            spellCheck={false}
            disabled={busy}
            value={key}
            placeholder={current?.saved ? `••••${current.ending}` : "sk-ant-…"}
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
      <div className="grid gap-x-4 gap-y-3 sm:grid-cols-2">
        {limitField("dailyLimitUsd", t("Daily limit (USD)"), daily, setDaily)}
        {limitField("monthlyLimitUsd", t("Monthly limit (USD)"), monthly, setMonthly)}
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
                  "Key ending in {{ending}} saved. This device asks Claude with it, also while paired: the sync service then only keeps and shares the recipes and settings.",
                  { ending: current.ending },
                ),
              }
            : {
                tone: "idle" as const,
                icon: KeyRound,
                text: view.isError
                  ? t("The saved key could not be read.")
                  : t(
                      "Without a key, the paired sync service asks Claude with its owner's credentials, and a device without a pairing makes no recipes.",
                    ),
              },
          ...(current?.saved
            ? [
                {
                  tone: "idle" as const,
                  icon: Wallet,
                  text: t(
                    "Spent with this key: {{today}} today and {{month}} this month (UTC), estimated from the usage Anthropic reports. Requests stop at either limit.",
                    { today: usd(current.spentTodayUsd), month: usd(current.spentMonthUsd) },
                  ),
                },
              ]
            : []),
          {
            tone: "idle",
            icon: Info,
            text: t(
              "The key stays on this device and is sent to Anthropic only, never to the sync service. Without a paired sync service, this device makes recipes with it and keeps them here.",
            ),
          },
        ]}
      />
    </Panel>
  );
}
