import * as v from "valibot";
import { createBitwardenAccountMapper, type PreparedBitwardenAccount } from "@pateat/bitwarden";
import { parsePasswordTokenOutcome } from "../../../../packages/bitwarden/src/auth-models";
import {
  accountNow,
  accountProfile,
  rawV1Account,
  rawV2Account,
  rawOrganizationAccount,
} from "../../../../packages/bitwarden/src/__fixtures__/account";
import { v1Email, v1Password } from "../../../../packages/bitwarden/src/__fixtures__/crypto";
import { authPassword, pbkdf2Auth } from "../../../../packages/bitwarden/src/__fixtures__/auth";
import type { CryptoHost } from "./host";

const schema = v.variant("action", [
  v.strictObject({
    type: v.literal("crypto.probe"),
    action: v.picklist([
      "vectors",
      "isolation",
      "lock",
      "cancel",
      "deadline",
      "cancel-result",
      "status",
      "release",
    ]),
  }),
  v.strictObject({
    type: v.literal("crypto.probe"),
    action: v.literal("arm"),
    checkpoint: v.picklist(["before-dispatch", "after-result"]),
  }),
  v.strictObject({
    type: v.literal("crypto.probe"),
    action: v.literal("release-and-arm"),
    checkpoint: v.literal("after-dispatch"),
  }),
]);
type Checkpoint = "before-dispatch" | "after-dispatch" | "after-result";
/** Only probe code supplies these bounded barriers; they carry no secret data. */
export function createCryptoProbeControls() {
  let stage: Checkpoint | undefined;
  let reached = false;
  let release: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let budget = 30_000;
  return {
    checkpoint(checkpoint: Checkpoint) {
      if (stage !== checkpoint) return Promise.resolve();
      reached = true;
      return new Promise<void>((resolve) => {
        release = resolve;
        timer = setTimeout(() => {
          stage = undefined;
          reached = false;
          release = undefined;
          resolve();
        }, 30_000);
      });
    },
    arm(checkpoint: Checkpoint) {
      if (stage) return false;
      stage = checkpoint;
      reached = false;
      return true;
    },
    release() {
      clearTimeout(timer);
      stage = undefined;
      reached = false;
      const previous = release;
      release = undefined;
      previous?.();
    },
    /** Arms the next barrier before the released probe step can run past it. */
    releaseAndArm(checkpoint: Checkpoint) {
      this.release();
      stage = checkpoint;
    },
    status() {
      return { checkpoint: stage ?? null, reached };
    },
    requestTimeoutMs: () => budget,
    setBudget(value: number) {
      budget = value;
    },
  };
}
export function createCryptoProbe(
  host: CryptoHost,
  controls: ReturnType<typeof createCryptoProbeControls>,
) {
  const authInput = (connectionId = "synthetic-host-auth") => ({
    connectionId,
    email: pbkdf2Auth.salt,
    password: authPassword,
    prelogin: { mode: "legacy" as const, response: { kdf: 0, kdfIterations: 100_000 } },
  });
  function prepare(
    raw: ReturnType<typeof rawV1Account> | ReturnType<typeof rawV2Account>,
    connectionId: string,
  ): PreparedBitwardenAccount {
    const authenticated = parsePasswordTokenOutcome(raw.token, 200);
    const mapper = createBitwardenAccountMapper(
      { ...accountProfile, connectionId },
      { kind: "bootstrap", email: v1Email },
      { nowSeconds: () => accountNow },
    );
    if (!mapper.ok || authenticated?.kind !== "authenticated") throw new Error();
    const mapped = mapper.data.map({ connectionId, authenticated, sync: raw.sync });
    if (!mapped.ok) throw new Error();
    return mapped.data;
  }
  async function open(
    raw: ReturnType<typeof rawV1Account> | ReturnType<typeof rawV2Account>,
    connectionId: string,
  ) {
    const prepared = prepare(raw, connectionId);
    return host.open({
      connectionId,
      prepared,
      snapshotId: crypto.randomUUID(),
      unlock: { kind: "password", password: v1Password },
    });
  }
  /* eslint-disable no-await-in-loop -- Native KDF sessions are deliberately opened, checked and terminated serially to bound memory. */
  async function vectors() {
    const auth = await host.deriveAuthentication(authInput());
    const results = {
      authHash: auth.ok && auth.data.masterPasswordHash === pbkdf2Auth.expected,
      v1Login: false,
      v2Blob: false,
      organization: false,
      fields: false,
      denied: false,
    };
    for (const [name, raw] of [
      ["v1Login", rawV1Account()],
      ["v2Blob", rawV2Account()],
      ["organization", rawOrganizationAccount()],
    ] as const) {
      const opened = await open(raw, `synthetic-host-${name}`);
      if (!opened.ok) continue;
      try {
        const session = opened.data.session;
        const itemId = String(raw.sync.ciphers[0]!.id);
        const decrypted = await host.decryptCipher(session, itemId);
        if (!decrypted.ok || !decrypted.data || typeof decrypted.data !== "object") continue;
        const view = decrypted.data as {
          name?: string;
          notes?: string;
          login?: { password?: string };
        };
        results[name] =
          name === "v2Blob"
            ? view.name === "Test Cipher" &&
              view.notes === "Some notes" &&
              opened.data.metadata.securityVersion === 2
            : view.login?.password ===
              (name === "organization" ? "synthetic-org-password" : "test_password");
        if (name === "v1Login") {
          const fields = await host.listFields(session, itemId);
          const ref =
            fields.ok && fields.data.find((entry) => entry.ref.fieldId === "login.password")?.ref;
          if (ref) {
            const resolved = await host.resolveField(session, ref, {
              allowedFieldIds: ["login.password"],
            });
            const denied = await host.resolveField(session, ref, { allowedFieldIds: [] });
            results.fields =
              resolved.ok &&
              resolved.data.kind === "text" &&
              resolved.data.value === "test_password";
            results.denied = !denied.ok && denied.error.code === "field-denied";
          }
        }
      } finally {
        await host.lock(opened.data.session);
      }
    }
    return results;
  }
  /* eslint-enable no-await-in-loop */
  return async (message: unknown) => {
    const parsed = v.safeParse(schema, message);
    if (!parsed.success) return { ok: false, error: { code: "invalid-request" } };
    try {
      const action = parsed.output.action;
      if (action === "status")
        return { ok: true, data: { ...host.status(), ...controls.status() } };
      if (action === "arm")
        return { ok: true, data: { armed: controls.arm(parsed.output.checkpoint) } };
      if (action === "release") {
        controls.release();
        return { ok: true, data: { released: true } };
      }
      if (action === "release-and-arm") {
        controls.releaseAndArm(parsed.output.checkpoint);
        return { ok: true, data: { released: true } };
      }
      if (action === "vectors") return { ok: true, data: await vectors() };
      if (action === "cancel-result") {
        const opened = await open(rawV1Account(), "synthetic-host-result");
        if (!opened.ok) return { ok: true, data: { withheld: false, locked: false } };
        try {
          const itemId = String(rawV1Account().sync.ciphers[0]!.id);
          const fields = await host.listFields(opened.data.session, itemId);
          const ref =
            fields.ok && fields.data.find((entry) => entry.ref.fieldId === "login.password")?.ref;
          if (!ref || !controls.arm("after-result"))
            return { ok: true, data: { withheld: false, locked: false } };
          const abort = new AbortController();
          const pending = host.resolveField(
            opened.data.session,
            ref,
            { allowedFieldIds: ["login.password"] },
            abort.signal,
          );
          const until = Date.now() + 5_000;
          while (!controls.status().reached && host.status().pending && Date.now() < until) {
            // Wait for the actual field result before testing abort and hard cleanup.
            // eslint-disable-next-line no-await-in-loop
            await new Promise((resolve) => setTimeout(resolve, 5));
          }
          const reached = controls.status().reached;
          abort.abort();
          controls.release();
          const result = await pending;
          const locked = await host.listFields(opened.data.session, itemId);
          return {
            ok: true,
            data: {
              withheld: reached && !result.ok && result.error.code === "cancelled",
              locked: !locked.ok && locked.error.code === "crypto-locked",
            },
          };
        } finally {
          controls.release();
          // Browser proof observes abort's own Worker termination before any cleanup command.
        }
      }
      if (action === "isolation" || action === "lock") {
        const a = await open(rawV1Account(), "synthetic-host-a");
        const b =
          action === "isolation" ? await open(rawV1Account(), "synthetic-host-b") : undefined;
        if (!a.ok || (b && !b.ok)) return { ok: true, data: { rejected: false } };
        try {
          const session = a.data.session;
          if (action === "lock") await host.lock(session);
          const forged = b?.ok
            ? { ...session, connectionId: b.data.session.connectionId }
            : session;
          const result = await host.decryptCipher(
            forged,
            String(rawV1Account().sync.ciphers[0]!.id),
          );
          return {
            ok: true,
            data: { rejected: !result.ok && result.error.code === "crypto-locked" },
          };
        } finally {
          if (action === "isolation") {
            await host.closeConnection("synthetic-host-a");
            await host.closeConnection("synthetic-host-b");
          }
        }
      }
      // Warm only local bootstrap, then run a fixed expensive public synthetic input.
      await host.deriveAuthentication(authInput());
      const abort = new AbortController();
      if (action === "deadline") controls.setBudget(150);
      const input = {
        ...authInput(),
        prelogin: {
          mode: "legacy" as const,
          response: { kdf: 1, kdfIterations: 20, kdfMemory: 256, kdfParallelism: 2 },
        },
      };
      const pending = host.deriveAuthentication(input, abort.signal);
      if (action === "cancel") {
        const until = Date.now() + 5_000;
        while (!host.status().dispatched && host.status().pending && Date.now() < until) {
          // Wait for the supervisor's actual Worker dispatch, not an assumed timer window.
          // eslint-disable-next-line no-await-in-loop
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        // A Worker terminated before it starts never becomes a browser target.
        // Browser proof may hold here until it has observed the running Worker.
        await controls.checkpoint("after-dispatch");
        abort.abort();
      }
      const result = await pending;
      controls.setBudget(30_000);
      return {
        ok: true,
        data: {
          withheld:
            !result.ok && result.error.code === (action === "cancel" ? "cancelled" : "timeout"),
        },
      };
    } catch {
      controls.setBudget(30_000);
      return { ok: false, error: { code: "crypto-failed" } };
    }
  };
}
