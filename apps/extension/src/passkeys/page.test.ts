import { afterEach, describe, vi } from "vitest";
import { installPasskeyPage } from "./page";
import { PAGE_CHANNEL, type PageResult } from "./wire";
import { registerPageGetCases } from "../../test/passkeys/page-get-cases";
import { registerPageGetCoexistenceCases } from "../../test/passkeys/page-get-coexistence-cases";
import { registerPageCreateCases } from "../../test/passkeys/page-create-cases";
import { registerPageCreateCoexistenceCases } from "../../test/passkeys/page-create-coexistence-cases";

const origin = "https://login.example.com";
type Message = { channel: string; type: string; id: string };

/** Minimal top-level window: same-origin postMessage plus a scripted isolated relay. */
function fakePage(
  relay: (message: Message) => Array<Record<string, unknown>> = () => [],
  /** `locked`: a provider defined `create` before Pateat, without letting it be redefined. */
  { create = true }: { create?: boolean | "locked" } = {},
) {
  const listeners: Array<(event: unknown) => void> = [];
  const posted: Message[] = [];
  const nativeGet = vi.fn(async function (this: unknown, _options?: unknown) {
    return "native" as unknown;
  });
  const nativeCreate = vi.fn(async function (this: unknown, _options?: unknown) {
    return "created" as unknown;
  });
  const container: {
    get: (options?: unknown) => Promise<unknown>;
    create: (options?: unknown) => Promise<unknown>;
  } = create ? { get: nativeGet, create: nativeCreate } : ({ get: nativeGet } as never);
  if (create === "locked")
    Object.defineProperty(container, "create", { value: nativeCreate, configurable: false });
  // The wrapper reads only each class's prototype.
  const PublicKeyCredential = { prototype: { kind: "credential" } };
  const AuthenticatorAssertionResponse = { prototype: { kind: "response" } };
  const scope: Record<string, unknown> & { postMessage(data: unknown): void } = {
    navigator: { credentials: container },
    PublicKeyCredential,
    AuthenticatorAssertionResponse,
    AbortSignal,
    DOMException,
    location: { origin },
    addEventListener: (_type: string, listener: (event: unknown) => void) =>
      listeners.push(listener),
    postMessage(data: unknown) {
      const copy = structuredClone(data) as Message;
      queueMicrotask(() => {
        for (const listener of listeners) listener({ source: scope, origin, data: copy });
        if (copy.channel !== PAGE_CHANNEL) return;
        if (copy.type === "get" || copy.type === "create" || copy.type === "cancel") {
          posted.push(copy);
          for (const reply of relay(copy)) scope.postMessage({ channel: PAGE_CHANNEL, ...reply });
        }
      });
    },
  };
  scope["top"] = scope;
  installPasskeyPage(scope as unknown as Parameters<typeof installPasskeyPage>[0]);
  return {
    container,
    nativeGet,
    nativeCreate,
    posted,
    prototypes: { credential: PublicKeyCredential.prototype },
    post: (data: unknown) => scope.postMessage(data),
    /** Listens to the page's messages after the wrapper's own listener. */
    listen: (listener: (event: { data: Message }) => void) =>
      listeners.push(listener as (event: unknown) => void),
  };
}

const publicKey = { challenge: new Uint8Array(16), allowCredentials: [] };
const answer = (result: PageResult) => (message: Message) =>
  message.type === "get"
    ? [
        { type: "ack", id: message.id },
        { type: "result", id: message.id, result },
      ]
    : [];

afterEach(() => {
  vi.useRealTimers();
});

describe("MAIN-world passkey wrapper", () => {
  registerPageGetCases({ fakePage, publicKey, answer });
});

/** Shaped like the official Bitwarden page script: it saves a bound `get`, assigns its own, falls
 * back to the saved one only when its provider asks, and restores the saved one on teardown. */
function laterProvider(
  container: { get: (options?: unknown) => Promise<unknown> },
  outcome: "fallback" | "reject",
) {
  const saved = container.get.bind(container);
  const provider = vi.fn(async (options?: unknown) => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (outcome === "reject") throw new Error("Something went wrong.");
    return saved(options);
  });
  container.get = provider;
  return { provider, destroy: () => (container.get = saved) };
}

describe("coexistence with a later passkey provider", () => {
  registerPageGetCoexistenceCases({ fakePage, publicKey, answer, laterProvider });
});

/** A registration excluding one passkey, whose ID AQID is the bytes 1, 2, 3. */
const registration = () => ({
  rp: { id: "example.com", name: "Example" },
  user: { id: new Uint8Array(8), name: "owner@example.com", displayName: "Owner" },
  challenge: new Uint8Array(16),
  pubKeyCredParams: [{ type: "public-key", alg: -7 }],
  excludeCredentials: [
    { type: "public-key", id: Uint8Array.of(1, 2, 3), transports: ["internal"] },
  ],
});
const answerCreate = (result: PageResult) => (message: Message) =>
  message.type === "create"
    ? [
        { type: "ack", id: message.id },
        { type: "result", id: message.id, result },
      ]
    : [];
const types = (posted: Message[]) => posted.map((message) => message.type);

describe("MAIN-world passkey create wrapper (ADR 0007)", () => {
  registerPageCreateCases({ fakePage, publicKey, answer, registration, answerCreate, types });
});

describe("create coexistence with a later passkey provider", () => {
  registerPageCreateCoexistenceCases({ fakePage, answer, registration, answerCreate, types });
});

export type PageFixtures = {
  fakePage: typeof fakePage;
  publicKey: typeof publicKey;
  answer: typeof answer;
  laterProvider: typeof laterProvider;
  registration: typeof registration;
  answerCreate: typeof answerCreate;
  types: typeof types;
};

export type PageMessage = Message;
