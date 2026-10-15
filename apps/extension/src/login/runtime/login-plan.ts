import * as v from "valibot";
import {
  attemptRouteChoice,
  chooseLoginRoute,
  handlerSlots,
  loginFieldSource,
  passkeyAnswersRequest,
  passwordStopOrMiss,
  passwordVariants,
  recipeHasRoute,
  resolveLoginPlan,
  routeSlots,
  TOTP_HANDLER_SLOT,
  type LoginBindingTemplate,
  type LoginAccountBinding,
  type LoginChoiceAccount,
  type LoginItemFacts,
  type LoginRecipe,
  type LoginRouteChoice,
  type LoginMarkerTarget,
  type SavedLoginBinding,
  type SettingsResponse,
  type VaultCatalog,
  type VaultConnectionMetadata,
} from "@pateat/contracts";
import {
  awaitResultSchema,
  observationSchema,
  LOGIN_STEP_WAIT_MS,
  type LoginReadiness,
  type TargetRequirement,
} from "../wire";
import { grantProbeOrigin, probeBinding } from "../dummy";
import {
  type Choice,
  type Execution,
  type LiveDocument,
  probeMode,
  type UnsavedChoice,
} from "./model";
import { codeFieldOf, passwordMiss } from "./recipes";
import type { RuntimeContext } from "./context";
import type { RuntimeState } from "./state";

/**
 * A login's plan for a document from the live settings, the check that it is still allowed
 * before each step, and observing the document's targets.
 */
export function createLoginPlan(shared: RuntimeState) {
  const runtime = shared as RuntimeContext;
  const { generation, settings, send } = shared;
  /**
   * One account must resolve from a usable connection, and its item must not await review.
   * A new login reads the item's facts once and chooses its route in the owner's order
   * (ADR 0027): the `passkey` route when the recipe has it and the item holds a
   * discoverable passkey, whatever its bindings; otherwise the first password variant
   * whose binding resolves, whose fields are all allowed and whose bound password or TOTP
   * fields hold values. A recipe with one variant keeps that variant's own refusal, and
   * one with several refuses `no-route` with the first variant's reason as its detail. A
   * running or resumed login passes its recorded `route`, which is checked alone and never
   * reads the facts again. On a recipe without a passkey button, the `passkey` route is
   * chosen when the page asked for a passkey by itself (`pageRequest`), and its plan names
   * the password variant it falls back to, when one fits (ADR 0034).
   */
  async function planFor(
    snapshot: Extract<SettingsResponse, { ok: true }>,
    live: LiveDocument,
    recipe: LoginRecipe,
    request: {
      asking?: boolean;
      /** While asking after a logout, the single account to use may fill the page. */
      fill?: boolean;
      route?: LoginRouteChoice;
      /** Slots of the handlers a running login entered; `totp` reads the built-in field. */
      handlerSlots?: readonly string[];
      /** The document asked for a passkey by itself, with conditional mediation (ADR 0034). */
      pageRequest?: boolean;
    } = {},
  ) {
    let catalog: VaultCatalog;
    let chosen: Choice | undefined;
    let savedDefault = false;
    if (probeMode && recipe.origin === runtime.origin) {
      // A page already filled after a logout asks, as `choose` answers it (ADR 0021 D); a
      // page to fill after a logout still logs in fully here, without production's fill-only.
      if (request.asking && !request.fill)
        return { ok: false as const, reason: "logged-out" as const, logout: true as const };
      catalog = grantProbeOrigin(snapshot.catalog, runtime.origin, runtime.account);
      const top = await runtime.topScope(snapshot, live, runtime.account, catalog);
      if (top) return { ok: false as const, reason: top.reason };
    } else {
      const found = await runtime.choose(
        snapshot,
        live,
        request.asking === true,
        request.fill === true,
      );
      if ("reason" in found)
        return {
          ok: false as const,
          reason: found.reason,
          ...(found.candidates ? { candidates: found.candidates } : {}),
          ...(found.logout ? { logout: true as const } : {}),
          ...(found.noUriMatch ? { noUriMatch: true as const } : {}),
        };
      chosen = found;
      savedDefault = found.saved;
      const scope = await runtime.liveScope(snapshot, live, found);
      if ("reason" in scope) return { ok: false as const, reason: scope.reason };
      const top = await runtime.topScope(snapshot, live, found, snapshot.catalog);
      if (top) return { ok: false as const, reason: top.reason };
      catalog = scope.catalog;
    }
    // The generated slot map is read at most once per plan.
    let generated: Promise<LoginBindingTemplate | undefined> | undefined;
    const slotMap = () =>
      (generated ??= Promise.resolve(generation?.slotFields(recipe.id)).catch(() => undefined));
    /** The plan for one route, or why it does not resolve. */
    const resolveRoute = async (route: LoginRouteChoice) => {
      const slots = routeSlots(recipe, route);
      let policy = snapshot.snapshot;
      let binding: LoginAccountBinding;
      let choice: UnsavedChoice | undefined;
      if (!chosen) binding = probeBinding(recipe, runtime.account, slots);
      else {
        let named: SavedLoginBinding | LoginChoiceAccount;
        let unsaved: boolean;
        if (route.route === "passkey") {
          // The route fills nothing, so no binding is read, built or saved (ADR 0027).
          const owner = runtime.choiceAccount(catalog, chosen, live.document.origin);
          if (!owner) return { ok: false as const, reason: "vault-unavailable" };
          binding = {
            origin: live.document.origin,
            connectionId: chosen.connectionId,
            itemId: chosen.itemId,
            slots: [],
          };
          named = owner;
          unsaved = !chosen.saved;
        } else {
          const bound = await runtime.bindingFor(
            catalog,
            snapshot.snapshot.settings,
            recipe,
            chosen,
            live.document.origin,
            slots,
            slotMap,
          );
          if (!bound.ok) return { ok: false as const, reason: bound.reason };
          binding = bound.binding;
          named = bound.synced;
          unsaved = !chosen.saved || !bound.saved;
        }
        if (!chosen.saved) {
          // The automatic choice acts as this document's default in memory only, named by
          // the chosen item's provider account as a saved default would be. An account
          // connected more than once therefore stays ambiguous, as it would once saved.
          policy = structuredClone(policy);
          // A found account replaces a saved default for this document.
          policy.settings.siteDefaults = policy.settings.siteDefaults.filter(
            (entry) => entry.origin !== live.document.origin,
          );
          policy.settings.siteDefaults.push({
            origin: live.document.origin,
            provider: named.provider,
            userId: named.userId,
            itemId: named.itemId,
            itemName: named.itemName,
            ...(named.accountName ? { accountName: named.accountName } : {}),
          });
        }
        // A pick made for this login only is never saved.
        if (unsaved && (!chosen.pick || chosen.pick.makeDefault))
          choice = {
            binding: named,
            connectionId: chosen.connectionId,
            // An account found to become the default replaces another saved one.
            ...(chosen.pick?.makeDefault ? { replace: true } : {}),
          };
      }
      // An entered `totp` handler reads the item's built-in TOTP field (ADR 0027), for this
      // login only: the binding saved after it authenticates covers the route's slots.
      let planSlots = slots;
      if (request.handlerSlots?.includes(TOTP_HANDLER_SLOT)) {
        const owner = catalog.connections.find((entry) => entry.id === binding.connectionId);
        const code =
          owner && codeFieldOf(owner, binding.itemId, snapshot.snapshot.settings.bindings, recipe);
        if (!code) return { ok: false as const, reason: "code-field-missing" as const };
        binding = {
          ...binding,
          slots: [...binding.slots, { slot: TOTP_HANDLER_SLOT, fieldId: code }],
        };
        planSlots = [...slots, TOTP_HANDLER_SLOT];
      }
      const plan = resolveLoginPlan(policy, catalog, live.url, recipe, binding, planSlots);
      // A saved default's item that no longer matches the page, as after its URI was edited
      // on another device, is also no matching item.
      if (!plan.ok && plan.reason === "item-origin-mismatch" && savedDefault)
        return { ...plan, noUriMatch: true as const };
      if (!plan.ok) return plan;
      const connection = catalog.connections.find(
        (entry) => entry.id === plan.account.connectionId,
      );
      if (
        !connection ||
        // Review blocks only the affected items; unrelated items in the connection stay usable.
        (connection.state !== undefined &&
          connection.state !== "ready" &&
          connection.state !== "review-required") ||
        connection.quarantinedItemIds?.includes(plan.account.itemId)
      )
        return { ok: false as const, reason: "vault-unavailable" as const };
      return {
        ...plan,
        connection,
        route,
        ...(chosen
          ? {
              chosen: {
                source: chosen.source,
                ...(chosen.candidates === undefined ? {} : { candidates: chosen.candidates }),
              },
            }
          : {}),
        ...(choice ? { choice } : {}),
        ...(chosen?.fillOnly ? { fillOnly: true as const, asked: chosen.asked ?? [] } : {}),
      };
    };
    // A running or resumed login checks its recorded route alone.
    if (request.route) return resolveRoute(request.route);
    let facts: LoginItemFacts | undefined;
    const factsOf = (resolved: Extract<Awaited<ReturnType<typeof resolveRoute>>, { ok: true }>) =>
      runtime.itemFacts(resolved.connection, { ...resolved.account, origin: live.document.origin });
    const pageRequest =
      request.pageRequest === true && !chosen?.fillOnly && passkeyAnswersRequest(recipe);
    if (recipeHasRoute(recipe, "passkey") || pageRequest) {
      const resolved = await resolveRoute({ route: "passkey" });
      if (resolved.ok) {
        facts = await factsOf(resolved);
        // No binding matters on this route, so a password variant that does not fit never
        // refuses such a login.
        if (chooseLoginRoute(recipe, facts, [], pageRequest)?.route === "passkey") {
          if (!pageRequest) return { ...resolved, facts };
          // Answering the page's request falls back to the variant that fits (ADR 0034),
          // never to one that stops before the password the item lacks (ADR 0036).
          const password = await passwordPlan();
          return {
            ...resolved,
            facts,
            ...(password.ok && password.route.route === "password" && !("stopAt" in password)
              ? { fallback: password.route.variant }
              : {}),
          };
        }
      }
      // Otherwise the password route decides, with its own refusals.
    }
    return passwordPlan();
    /** The first password variant that fits, or why none does. */
    async function passwordPlan() {
      const routes: LoginRouteChoice[] = passwordVariants(recipe).map((_, variant) => ({
        route: "password",
        variant,
      }));
      const fits: boolean[] = [];
      const refusals: (string | undefined)[] = [];
      /** For a `no-route` refusal, which fact was missing (never a value). */
      const missing: (string | undefined)[] = [];
      /**
       * An item without a password, but with a passkey, goes on up to the step that fills
       * its password, or to the end of a route that fills none, in the tab's own page (ADR
       * 0036), also on a chooser's route, whose click on the list advances to its branch
       * (owner, 2026-10-13 06:32 UTC). Its binding still names the empty password, so the
       * item signs in with its password once it has one. Undefined for a password the
       * account may not fill. Otherwise the stop, or why there is none, for a value-free
       * `password-empty:<why>` detail in the log. A route whose binding reads a password
       * from another field (`passwordField`) fills one, so it never stops at its end
       * (`password-field`).
       */
      const stopOrMiss = (
        route: LoginRouteChoice,
        miss: ReturnType<typeof passwordMiss>,
        known: LoginItemFacts,
        passwordSlots: readonly string[],
        lacking: readonly string[],
        passwordField = false,
      ) => {
        if (miss !== "password-empty") return undefined;
        if (live.document.frameId !== 0) return { miss: "frame" as const };
        const result = passwordStopOrMiss(recipe, route, known, passwordSlots, lacking);
        return passwordField && ("stop" in result || result.miss === "no-password-step")
          ? { miss: "password-field" as const }
          : result;
      };
      // Variants are tried in recipe order and the first that fits stops the search, so the
      // facts and the generated map are read once.
      /* eslint-disable no-await-in-loop */
      for (const [index, route] of routes.entries()) {
        const resolved = await resolveRoute(route);
        if (!resolved.ok) {
          if (!runtime.variantRefusals.has(resolved.reason)) return resolved;
          refusals[index] = resolved.reason;
          continue;
        }
        facts ??= await factsOf(resolved);
        // The password route needs every bound password or TOTP field, built in or Linked to
        // one, to hold a value the account may fill.
        const item = resolved.connection.items.find(
          (entry) => entry.id === resolved.account.itemId,
        );
        const known = facts;
        const lacking = resolved.binding.slots
          .map(({ slot, fieldId }) => ({
            slot,
            source: item ? loginFieldSource(item, fieldId) : fieldId,
          }))
          .filter(
            ({ source }) =>
              (source === "login.password" && !known.password) ||
              (source === "login.totp-code" && !known.totp),
          );
        const unheld = lacking[0]?.source;
        if (unheld) {
          const miss = passwordMiss(item, resolved.account.fieldIds);
          const passwordSlots = lacking
            .filter(({ source }) => source === "login.password")
            .map(({ slot }) => slot);
          const stop =
            passwordSlots.length === 0
              ? undefined
              : stopOrMiss(
                  route,
                  miss,
                  known,
                  passwordSlots,
                  lacking.map(({ slot }) => slot),
                );
          if (stop && "stop" in stop) return { ...resolved, facts: known, stopAt: stop.stop };
          refusals[index] = "no-route";
          missing[index] =
            unheld !== "login.password" ? "no-totp" : stop ? `${miss}:${stop.miss}` : miss;
          continue;
        }
        fits[index] = true;
        const taken = chooseLoginRoute(recipe, known, fits);
        if (taken?.route === "password" && taken.variant === index)
          return { ...resolved, facts: known };
        // The first variant that fits decides; without the item's password none is taken.
        // The passkey route, when the facts choose it here, did not resolve, so nothing is.
        refusals[index] = "no-route";
        if (taken?.route === "passkey") {
          missing[index] = "passkey-unresolved";
          break;
        }
        // A variant whose binding reads nothing from the empty password, as one whose page
        // after the identifier is not generated yet, stops at the end of its route, unless
        // a slot reads a password from another field: the `password` slot, the password
        // through a Linked field, or a concealed (hidden) custom field.
        const miss = passwordMiss(item, resolved.account.fieldIds);
        const passwordField = resolved.binding.slots.some(
          ({ slot, fieldId }) =>
            slot === "password" ||
            (item ? loginFieldSource(item, fieldId) : fieldId) === "login.password" ||
            item?.fields.find((field) => field.id === fieldId)?.kind === "hidden",
        );
        const stop = stopOrMiss(route, miss, known, [], [], passwordField);
        if (stop && "stop" in stop) return { ...resolved, facts: known, stopAt: stop.stop };
        missing[index] = stop ? `${miss}:${stop.miss}` : miss;
        break;
      }
      /* eslint-enable no-await-in-loop */
      const first = refusals[0] ?? "no-route";
      // A `no-route` names the fact the first variant missed, so the log tells an item
      // without a password from one without its TOTP secret.
      const detail = first === "no-route" ? missing[0] : first;
      return routes.length === 1
        ? { ok: false as const, reason: first, ...(detail && detail !== first ? { detail } : {}) }
        : { ok: false as const, reason: "no-route" as const, ...(detail ? { detail } : {}) };
    }
  }
  type Authorized = {
    connection: VaultConnectionMetadata;
    binding: LoginAccountBinding;
    /** The account's allowed field IDs and the synced bindings it was authorized with. */
    fieldIds: string[];
    bindings: SavedLoginBinding[];
  };
  /** Resolve against a fresh live catalog; returns the authorizing metadata and binding. */
  async function allowed(run: Execution): Promise<Authorized | undefined> {
    if (!runtime.current(run) || !runtime.storageHealthy) return undefined;
    const snapshot = await settings.handle({ version: 1, type: "settings.get" });
    if (!runtime.current(run)) return undefined;
    // A watched login only reads, so newer settings stop it only when they no longer plan
    // its account on this page, as another site's saved account choice does not (ADR 0027).
    const revised =
      snapshot.ok &&
      run.metadata.watch !== undefined &&
      snapshot.snapshot.revision > run.metadata.policyRevision;
    // A read that another check of the same watch overtook says nothing.
    if (
      snapshot.ok &&
      run.metadata.watch !== undefined &&
      snapshot.snapshot.revision < run.metadata.policyRevision
    )
      return undefined;
    if (!snapshot.ok || (snapshot.snapshot.revision !== run.metadata.policyRevision && !revised)) {
      await runtime.change(
        run,
        { type: "POLICY_CHANGED" },
        { cause: snapshot.ok ? "settings-revision" : "settings-unavailable" },
      );
      return undefined;
    }
    // The recorded route alone is checked, so an excluded field of another variant never
    // stops this login, with the fields of the handlers it entered (ADR 0027).
    const plan = await planFor(snapshot, run.live, run.recipe, {
      route: attemptRouteChoice(run.metadata),
      handlerSlots: handlerSlots(run.recipe, run.metadata),
    });
    if (
      !plan.ok ||
      plan.account.connectionId !== run.metadata.account.connectionId ||
      plan.account.itemId !== run.metadata.account.itemId
    ) {
      await runtime.change(
        run,
        { type: "POLICY_CHANGED" },
        { cause: "plan", reason: plan.ok ? "account-changed" : plan.reason },
      );
      return undefined;
    }
    if (revised) {
      await runtime.change(run, {
        type: "POLICY_REVISED",
        policyRevision: snapshot.snapshot.revision,
      });
      if (!runtime.current(run) || run.metadata.policyRevision !== snapshot.snapshot.revision)
        return undefined;
    }
    return {
      connection: plan.connection,
      binding: plan.binding,
      fieldIds: plan.account.fieldIds,
      bindings: snapshot.snapshot.settings.bindings,
    };
  }
  async function observe(
    run: Execution,
    targets: LoginMarkerTarget[],
    require?: TargetRequirement[],
    links?: boolean[],
    signIn = false,
  ) {
    // Exclusion/default/policy checks precede even metadata observation.
    if (!(await allowed(run))) return undefined;
    const response = await send(run.live, {
      type: "login.observe",
      path: run.live.path,
      targets,
      ...(require ? { require } : {}),
      ...(links ? { links } : {}),
      ...(signIn ? { signIn: true } : {}),
    });
    if (!runtime.current(run)) return undefined;
    const parsed = v.safeParse(observationSchema, response);
    return parsed.success ? parsed.output : undefined;
  }
  /**
   * Asks the document to wait for a step's elements. A document that went away or was
   * cancelled leaves the attempt as it is; its replacement document resumes it.
   */
  async function waitFor(
    run: Execution,
    readiness: LoginReadiness,
    timeoutMs = LOGIN_STEP_WAIT_MS,
  ): Promise<"ready" | "timeout" | "gone"> {
    try {
      const response = await send(run.live, {
        type: "login.await",
        readiness,
        timeoutMs,
      });
      const parsed = v.safeParse(awaitResultSchema, response);
      if (!parsed.success) return "gone";
      return parsed.output.ok ? "ready" : parsed.output.reason === "timeout" ? "timeout" : "gone";
    } catch {
      return "gone";
    }
  }
  return { observe, allowed, waitFor, planFor };
}
