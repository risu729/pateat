import { loginRecordSchema, type LoginRecord } from "@pateat/contracts";
import * as v from "valibot";
import type { LoginReport } from "../login/runtime";
import { loginOutcomeOf } from "./outcomes";
import type { ServiceConnection } from "./runtime";
import type { OutcomeResult, ServiceTransport } from "./transport";

// Each login on a service recipe revision, when it ends, sends the service one record of
// how it ended and how long it took (ADR 0055): codes and milliseconds, never a URL,
// origin, page text, value or typing time. Sending is best-effort, once, after the login
// ended; it never waits on, throws into or changes a login, and a failed send is not
// retried: the local log keeps the login's `login.attempt` line.

/** One record that left the device, for the local log (ADR 0019): codes only. */
export type LoginRecordSent = {
  recipeId: string;
  revision: number;
  /** The layout the login ran (ADR 0060), and for a chooser login its branch. */
  branch?: string;
  /**
   * `kept`, `refused`, `rejected`, or `failed:<code>`; `failed:invalid-record` for a record
   * the contract refuses, which is not sent.
   */
  result: string;
};

/** A login that should send a record: the record, or why it cannot be sent. */
export type FoundLoginRecord =
  | { recipeId: string; record: LoginRecord }
  /** The contract refuses the record, as for a build it does not accept or a time over a day. */
  | { recipeId: string; invalid: { revision: number; branch?: string } };

/**
 * The record to send for a login report, or nothing. Only a login that just ended with its
 * times (`times`: signed in or blocked, a watched one when its watch ended, and never a
 * repeat report) and that would report a result code (`loginOutcomeOf`) sends one: a login
 * without a service recipe revision, a fill-only login, any login of an item without a
 * password, and a `policy-changed`, `account-switched` or cause-less `cancelled` end send
 * nothing, as for the first login's result code. A result that settled as unknown without
 * a watch has no end and no times, so it sends nothing here either. A record the contract
 * refuses, such as one with a time over a day or a build it does not accept, is not sent
 * but returned as `invalid`, so the local log says so.
 */
export function loginRecordOf(
  report: LoginReport,
  extensionBuild: string,
): FoundLoginRecord | undefined {
  if (report.type !== "attempt" || !report.times || report.repeat) return undefined;
  const found = loginOutcomeOf(report);
  if (!found) return undefined;
  const { revision, branch, outcome, cause } = found.report;
  const { totalMs, serviceMs, networkMs, personMs, pageMs } = report.times;
  const parsed = v.safeParse(loginRecordSchema, {
    version: 1,
    revision,
    ...(branch ? { branch } : {}),
    outcome,
    ...(cause ? { cause } : {}),
    extensionBuild,
    totalMs,
    serviceMs,
    networkMs,
    personMs,
    pageMs,
  });
  return parsed.success
    ? { recipeId: found.recipeId, record: parsed.output }
    : { recipeId: found.recipeId, invalid: { revision, ...(branch ? { branch } : {}) } };
}

/**
 * Sends one record of each ended login to the paired service (ADR 0055), in the background
 * after the login ended. Nothing is stored or retried.
 */
export function createLoginRecords(options: {
  service: { connection(): Promise<ServiceConnection | undefined> };
  transport: Pick<ServiceTransport, "reportLogin">;
  /** The extension's build, `PATEAT_BUILD_REVISION`. */
  build: string;
  /**
   * Told of each request sent, and of each record not sent because the contract refuses
   * it, for the local log; never changes the sending.
   */
  report?: (sent: LoginRecordSent) => void;
}) {
  const { service, transport } = options;
  const tell = (sent: LoginRecordSent) => {
    try {
      options.report?.(sent);
    } catch {
      // The log never changes the sending.
    }
  };
  async function send(found: FoundLoginRecord) {
    const connection = await service.connection().catch(() => undefined);
    if (!connection || connection.rejected) return;
    const { recipeId } = found;
    if ("invalid" in found) {
      tell({ recipeId, ...found.invalid, result: "failed:invalid-record" });
      return;
    }
    const { record } = found;
    let result: OutcomeResult | undefined;
    try {
      result = await transport.reportLogin(
        connection.origin,
        connection.credential,
        recipeId,
        record,
      );
    } catch {
      result = undefined;
    }
    tell({
      recipeId,
      revision: record.revision,
      ...(record.branch ? { branch: record.branch } : {}),
      result: !result
        ? "failed:threw"
        : result.kind === "failed"
          ? `failed:${result.error}`
          : result.kind,
    });
  }
  return {
    /** Takes every login report and sends a record of each ended login. Never throws. */
    observe(report: LoginReport): void {
      try {
        const found = loginRecordOf(report, options.build);
        if (found) void send(found).catch(() => undefined);
      } catch {
        // A report must never change the login.
      }
    },
  };
}
