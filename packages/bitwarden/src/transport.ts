import * as v from "valibot";

import {
  passwordTokenRequestSchema,
  refreshTokenRequestSchema,
  parsePasswordTokenOutcome,
  parseRefreshTokenOutcome,
  type PasswordTokenOutcome,
  type RefreshTokenOutcome,
} from "./auth-models";
import { bitwardenEndpoints, normalizeBitwardenProfile } from "./environment";
import { failure, type BitwardenErrorCode, type BitwardenResult } from "./errors";
import {
  encryptedSyncEnvelopeSchema,
  parsePreloginResponse,
  type EncryptedSyncEnvelope,
  type PreloginResponse,
} from "./models";

type Fetch = (url: string, init: RequestInit) => Promise<Response>;
export type BitwardenTransportOptions = {
  /** Trusted host dependency, not a page-supplied transport or middleware. */
  fetch?: Fetch;
  timeoutMs?: number;
  maxResponseBytes?: number;
};

const optionsSchema = v.strictObject({
  fetch: v.optional(v.custom<Fetch>((input) => typeof input === "function")),
  timeoutMs: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(60000)), 15000),
  maxResponseBytes: v.optional(
    v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(64 * 1024 * 1024)),
    16 * 1024 * 1024,
  ),
});
const connectionId = v.pipe(v.string(), v.minLength(1), v.maxLength(200));
const preloginRequestSchema = v.strictObject({
  connectionId,
  email: v.pipe(v.string(), v.minLength(1), v.maxLength(320), v.email()),
  mode: v.picklist(["legacy", "password"]),
});
const syncRequestSchema = v.strictObject({
  connectionId,
  accessToken: v.pipe(
    v.string(),
    v.minLength(1),
    v.maxLength(16384),
    v.regex(/^[A-Za-z0-9._~+/-]+=*$/),
  ),
});

/** Fixed connection-scoped provider requests. No retries, credential storage or decryption. */
export function createBitwardenTransport(
  profileInput: unknown,
  options: BitwardenTransportOptions = {},
) {
  const normalized = normalizeBitwardenProfile(profileInput);
  if (!normalized.ok) return normalized;
  const parsedOptions = v.safeParse(optionsSchema, options);
  if (!parsedOptions.success) return failure("invalid-options");
  const profile = normalized.data;
  const endpoints = bitwardenEndpoints(profile);
  const { timeoutMs, maxResponseBytes } = parsedOptions.output;
  // Capture dependencies once; caller mutation cannot retarget this connection.
  const fetchResponse = parsedOptions.output.fetch ?? globalThis.fetch.bind(globalThis);

  async function request<T>(
    url: string,
    init: RequestInit,
    parse: (input: unknown, status: number) => T | undefined,
    signal?: AbortSignal,
    acceptedStatuses: readonly number[] = [200],
  ): Promise<BitwardenResult<T>> {
    if (signal !== undefined && !(signal instanceof AbortSignal)) return failure("invalid-request");
    if (signal?.aborted) return failure("cancelled");
    const controller = new AbortController();
    let stopCode: BitwardenErrorCode | undefined;
    let rejectStopped: (reason: undefined) => void = () => {};
    const stopped = new Promise<never>((_resolve, reject) => {
      rejectStopped = reject;
    });
    function stop(code: "cancelled" | "timeout") {
      if (stopCode) return;
      stopCode = code;
      // Caller reasons may contain secrets; never propagate them to fetch or errors.
      controller.abort();
      rejectStopped(undefined);
    }
    const cancel = () => stop("cancelled");
    signal?.addEventListener("abort", cancel, { once: true });
    const timer = setTimeout(() => stop("timeout"), timeoutMs);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let responseBody: ReadableStream<Uint8Array> | null = null;
    let finished = false;
    try {
      const pending = fetchResponse(url, {
        ...init,
        signal: controller.signal,
        redirect: "error",
        credentials: "omit",
        cache: "no-store",
        referrerPolicy: "no-referrer",
      });
      // Even a non-cooperative injected fetch must not leave a late body open.
      void pending.then(
        (response) => {
          if (controller.signal.aborted) void response.body?.cancel().catch(() => {});
          return undefined;
        },
        () => undefined,
      );
      const response = await Promise.race([pending, stopped]);
      responseBody = response.body;
      if (
        response.redirected ||
        (response.status >= 300 && response.status < 400) ||
        (response.url && response.url !== url)
      )
        return failure("redirect");
      if (!acceptedStatuses.includes(response.status))
        return failure("http-error", response.status);
      const contentType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
      if (!contentType || !/^application\/(?:json|[a-z0-9!#$&^_.+-]+\+json)$/.test(contentType))
        return failure("invalid-response");
      const length = response.headers.get("content-length");
      if (length !== null) {
        if (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)))
          return failure("invalid-response");
        if (Number(length) > maxResponseBytes) return failure("response-too-large");
      }
      if (!responseBody) return failure("invalid-response");
      reader = responseBody.getReader();
      const decoder = new TextDecoder("utf-8", { fatal: true });
      const parts: string[] = [];
      let part = "";
      let bytes = 0;
      let chunks = 0;
      // Sequential reads enforce the byte budget before decoding or JSON allocation.
      for (let chunk = await Promise.race([reader.read(), stopped]); !chunk.done;) {
        if (!(chunk.value instanceof Uint8Array)) return failure("invalid-response");
        bytes += chunk.value.byteLength;
        if (bytes > maxResponseBytes) return failure("response-too-large");
        try {
          part += decoder.decode(chunk.value, { stream: true });
        } catch {
          return failure("invalid-response");
        }
        // Tiny chunks must not allocate one retained string-array entry per byte.
        if (part.length >= 65536) {
          parts.push(part);
          part = "";
        }
        chunks += 1;
        if (chunks % 256 === 0) {
          // Yield a task so an immediately readable stream cannot starve abort/timeout.
          // eslint-disable-next-line no-await-in-loop
          await Promise.race([new Promise<void>((resolve) => setTimeout(resolve, 0)), stopped]);
        }
        // eslint-disable-next-line no-await-in-loop
        chunk = await Promise.race([reader.read(), stopped]);
      }
      finished = true;
      let decoded: unknown;
      try {
        parts.push(part + decoder.decode());
        decoded = JSON.parse(parts.join(""));
      } catch {
        return failure("invalid-response");
      }
      const data = parse(decoded, response.status);
      return data === undefined ? failure("invalid-response") : { ok: true, data };
    } catch {
      return failure(stopCode ?? "network");
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
      if (reader) {
        if (!finished) void reader.cancel().catch(() => {});
        reader.releaseLock();
      } else if (responseBody) void responseBody.cancel().catch(() => {});
      // Stop the browser fetch/body after any rejection, including header/schema failures.
      controller.abort();
    }
  }

  const transport = Object.freeze({
    profile,
    async passwordToken(
      input: unknown,
      signal?: AbortSignal,
    ): Promise<BitwardenResult<PasswordTokenOutcome>> {
      const parsed = v.safeParse(passwordTokenRequestSchema, input);
      if (!parsed.success) return failure("invalid-request");
      const value = parsed.output;
      if (value.connectionId !== profile.connectionId) return failure("connection-mismatch");
      const form = new URLSearchParams({
        grant_type: "password",
        username: value.email,
        password: value.masterPasswordHash,
        scope: "api offline_access",
        client_id: "browser",
        deviceType: "2",
        deviceIdentifier: value.device.identifier,
        deviceName: value.device.name,
      });
      if (value.twoFactor) {
        form.set("twoFactorToken", value.twoFactor.token);
        form.set("twoFactorProvider", String(value.twoFactor.provider));
        form.set("twoFactorRemember", value.twoFactor.remember ? "1" : "0");
      }
      if (value.newDeviceOtp !== undefined) form.set("newDeviceOtp", value.newDeviceOtp);
      // Chrome extension protocol category, never an official product/version identity.
      return request(
        `${endpoints.identityUrl}/connect/token`,
        {
          method: "POST",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/x-www-form-urlencoded; charset=utf-8",
            "Device-Type": "2",
          },
          body: form.toString(),
        },
        parsePasswordTokenOutcome,
        signal,
        [200, 400],
      );
    },
    async refreshToken(
      input: unknown,
      signal?: AbortSignal,
    ): Promise<BitwardenResult<RefreshTokenOutcome>> {
      const parsed = v.safeParse(refreshTokenRequestSchema, input);
      if (!parsed.success) return failure("invalid-request");
      if (parsed.output.connectionId !== profile.connectionId)
        return failure("connection-mismatch");
      return request(
        `${endpoints.identityUrl}/connect/token`,
        {
          method: "POST",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/x-www-form-urlencoded; charset=utf-8",
            "Device-Type": "2",
          },
          body: new URLSearchParams({
            grant_type: "refresh_token",
            client_id: "browser",
            refresh_token: parsed.output.refreshToken,
          }).toString(),
        },
        parseRefreshTokenOutcome,
        signal,
        [200, 400],
      );
    },
    async prelogin(
      input: unknown,
      signal?: AbortSignal,
    ): Promise<BitwardenResult<PreloginResponse>> {
      const parsed = v.safeParse(preloginRequestSchema, input);
      if (!parsed.success) return failure("invalid-request");
      if (parsed.output.connectionId !== profile.connectionId)
        return failure("connection-mismatch");
      const { email, mode } = parsed.output;
      return request(
        `${endpoints.identityUrl}/accounts/prelogin${mode === "password" ? "/password" : ""}`,
        {
          method: "POST",
          headers: { Accept: "application/json", "Content-Type": "application/json" },
          body: JSON.stringify({ email }),
        },
        (body) => parsePreloginResponse(body, mode),
        signal,
      );
    },
    async sync(
      input: unknown,
      signal?: AbortSignal,
    ): Promise<BitwardenResult<EncryptedSyncEnvelope>> {
      const parsed = v.safeParse(syncRequestSchema, input);
      if (!parsed.success) return failure("invalid-request");
      if (parsed.output.connectionId !== profile.connectionId)
        return failure("connection-mismatch");
      // Do not advertise official Client-Version/Device-Type capabilities we cannot yet fulfill.
      return request(
        `${endpoints.apiUrl}/sync`,
        {
          method: "GET",
          headers: {
            Accept: "application/json",
            Authorization: `Bearer ${parsed.output.accessToken}`,
          },
        },
        (body) => {
          const envelope = v.safeParse(encryptedSyncEnvelopeSchema, body);
          return envelope.success ? envelope.output : undefined;
        },
        signal,
      );
    },
  });
  return { ok: true as const, data: transport };
}

export type BitwardenTransport = Extract<
  ReturnType<typeof createBitwardenTransport>,
  { ok: true }
>["data"];
