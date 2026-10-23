import type { LoginRecipes } from "../login/runtime";
import type { LogoutOutcome, LogoutService } from "../login/switch";
import type { ServiceConnection } from "./runtime";
import type { ServiceTransport } from "./transport";

/**
 * The extension side of `POST /v1/recipes/logout` (ADR 0063): an account switch's
 * signed-in pages go only to the paired service with the device credential. A page is
 * asked about once per switch round, at the person's press, so nothing is claimed for the
 * retry window here; the service keeps its own (ADR 0016). A returned recipe is pulled into
 * the recipe cache behind the switch, which goes on with the answer's copy.
 */
export function createLogoutService(options: {
  service: { connection(): Promise<ServiceConnection | undefined> };
  transport: Pick<ServiceTransport, "generateLogout">;
  recipes: Pick<LoginRecipes, "logouts">;
  /** Pulls recipe changes only, as a login in progress needs (ADR 0027). */
  refresh(): Promise<unknown>;
}): LogoutService {
  const { service, transport, recipes, refresh } = options;
  return {
    recipes: async (origin) => (await recipes.logouts?.(origin)) ?? [],
    async generate(request): Promise<LogoutOutcome> {
      const connection = await service.connection().catch(() => undefined);
      if (!connection || connection.rejected)
        return { outcome: "skipped", reason: "not-connected" };
      const answer = await transport.generateLogout(
        connection.origin,
        connection.credential,
        request,
      );
      if (answer.kind === "rejected") return { outcome: "failed", reason: "device-rejected" };
      if (answer.kind === "failed") return { outcome: "failed", reason: answer.error };
      const { result } = answer;
      if (result.status === "recipe") {
        void refresh().catch(() => undefined);
        return { outcome: "recipe", recipe: result.change.recipe };
      }
      if (result.status === "signed-out") return { outcome: "signed-out" };
      if (result.status === "abstained") return { outcome: "abstained", reason: result.reason };
      if (result.status === "failed") return { outcome: "failed", reason: result.error };
      return { outcome: "unavailable", reason: result.reason };
    },
  };
}
