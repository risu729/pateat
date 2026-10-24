import * as v from "valibot";
import { browser, type Browser, type PublicPath } from "wxt/browser";
import { diagnosticsRequestSchema, type DiagnosticsRequest } from "../diagnostics/wire";
import { CHOOSER_PAGE } from "../passkeys/chooser";
import { onMessage, type BackgroundProtocol } from "./protocol";
import { senderPageUrl } from "./sender";

type Sender = Browser.runtime.MessageSender;

/**
 * What the background answers in each area. Each runs only for the senders checked here;
 * the login and passkey handlers also check content-script tabs, frames and documents
 * themselves. Every handler still parses its request.
 */
export interface BackgroundAreas {
  /** `settings.get` and `settings.save`. */
  settings(request: unknown): Promise<unknown>;
  /** `settings.site-accounts`. */
  siteAccounts(request: unknown): Promise<unknown>;
  /** `settings.export` and `settings.import`, from the settings page only (ADR 0040). */
  transfer(request: unknown): Promise<unknown>;
  service(request: unknown): Promise<unknown>;
  diagnostics(request: DiagnosticsRequest): Promise<unknown>;
  /** `undefined` when the sender is not the chooser window. */
  chooser(request: unknown, sender: Sender): Promise<unknown> | undefined;
  login(request: unknown, sender: Sender): Promise<unknown>;
  passkeyCreate(request: unknown, sender: Sender): Promise<unknown>;
  /** `passkey.get` and `passkey.cancel`. */
  passkeys(request: unknown, sender: Sender): Promise<unknown>;
  /** Probe build only. */
  setupProbe?: ((request: unknown) => Promise<unknown>) | undefined;
  vaultProbe?: ((request: unknown) => Promise<unknown>) | undefined;
  cryptoProbe?: ((request: unknown) => Promise<unknown>) | undefined;
  passkeyProbe?: ((request: unknown) => unknown) | undefined;
  /**
   * A handler threw or rejected. The library would send the error back to the sender, and
   * it may name vault data; the sender gets `undefined` instead, which its parser rejects.
   */
  failed(error: unknown): void;
}

/** The request's own `type`, which picks the operation within an area. */
export function requestType(request: unknown): string | undefined {
  return typeof request === "object" &&
    request !== null &&
    "type" in request &&
    typeof request.type === "string"
    ? request.type
    : undefined;
}

/** Answers the background's messages; see `BackgroundProtocol`. */
export function listenForBackgroundMessages(areas: BackgroundAreas): void {
  const answer = (
    area: keyof BackgroundProtocol,
    handle: (request: unknown, sender: Sender) => unknown,
  ) =>
    onMessage(area, ({ data, sender }: { data: unknown; sender: Sender }) =>
      (async () => handle(data, sender))().catch((error: unknown) => {
        areas.failed(error);
        return undefined;
      }),
    );
  const fromPage = (sender: Sender, ...paths: PublicPath[]) =>
    sender.id === browser.runtime.id &&
    paths.some((path) => senderPageUrl(sender) === browser.runtime.getURL(path));
  // The chooser window reaches the chooser alone, whatever its query.
  const fromChooser = (sender: Sender) =>
    sender.id === browser.runtime.id &&
    sender.url?.split(/[?#]/u)[0] === browser.runtime.getURL(CHOOSER_PAGE);

  // The settings page and the toolbar popup edit settings through the same store (ADR 0021).
  answer("settings", (request, sender) => {
    if (!fromPage(sender, "/options.html", "/popup.html")) return undefined;
    const type = requestType(request);
    if (type === "settings.get" || type === "settings.save") return areas.settings(request);
    if (type === "settings.site-accounts") return areas.siteAccounts(request);
    if (
      (type === "settings.export" || type === "settings.import") &&
      fromPage(sender, "/options.html")
    )
      return areas.transfer(request);
    return undefined;
  });
  answer("service", (request, sender) =>
    fromPage(sender, "/options.html") && requestType(request)?.startsWith("service.")
      ? areas.service(request)
      : undefined,
  );
  answer("diagnostics", (request, sender) =>
    fromPage(sender, "/diagnostics.html") && v.is(diagnosticsRequestSchema, request)
      ? areas.diagnostics(request)
      : undefined,
  );
  answer("passkey-chooser", (request, sender) =>
    sender.id === browser.runtime.id ? areas.chooser(request, sender) : undefined,
  );
  answer("login", (request, sender) =>
    requestType(request)?.startsWith("login.") && !fromChooser(sender)
      ? areas.login(request, sender)
      : undefined,
  );
  answer("passkey", (request, sender) => {
    const type = requestType(request);
    if (!type?.startsWith("passkey.") || fromChooser(sender)) return undefined;
    if (
      import.meta.env.MODE === "probe" &&
      areas.passkeyProbe &&
      fromPage(sender, "/options.html") &&
      type.startsWith("passkey.probe.")
    )
      return areas.passkeyProbe(request);
    if (type === "passkey.create") return areas.passkeyCreate(request, sender);
    return areas.passkeys(request, sender);
  });

  // The probe strings stay out of the production bundle.
  if (import.meta.env.MODE !== "probe") return;
  const probePage = new URL("crypto-probe.html", browser.runtime.getURL("/options.html")).href;
  const fromProbePage = (sender: Sender) =>
    sender.id === browser.runtime.id && senderPageUrl(sender) === probePage;
  const { setupProbe, vaultProbe, cryptoProbe } = areas;
  if (setupProbe)
    answer("setup.probe", (request, sender) =>
      fromProbePage(sender) && requestType(request) === "setup.probe"
        ? setupProbe(request)
        : undefined,
    );
  if (vaultProbe)
    answer("vault.probe", (request, sender) =>
      fromProbePage(sender) && requestType(request) === "vault.probe"
        ? vaultProbe(request)
        : undefined,
    );
  if (cryptoProbe)
    answer("crypto.probe", (request, sender) =>
      fromProbePage(sender) && requestType(request) === "crypto.probe"
        ? cryptoProbe(request)
        : undefined,
    );
  answer("pateat.test.document", (_request, sender) =>
    sender.id === browser.runtime.id &&
    sender.tab?.id !== undefined &&
    sender.url?.startsWith("http://127.0.0.1:")
      ? {
          tabId: sender.tab.id,
          frameId: sender.frameId,
          documentId: sender.documentId,
          active: sender.tab.active,
        }
      : undefined,
  );
}
