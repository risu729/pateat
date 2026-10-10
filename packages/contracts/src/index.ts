import * as v from "valibot";

export * from "./enrollment";
export * from "./settings";
export * from "./settings-store";
export * from "./login";
export * from "./login-attempt";
export * from "./sync";

// Only the implemented, read-only boundary is shared. Future adapters add
// their own capabilities without granting them to existing connections.
export const statusRequestSchema = v.strictObject({
  version: v.literal(1),
  type: v.literal("runtime.status.get"),
});

export const runtimeStatusSchema = v.strictObject({
  version: v.literal(1),
  stage: v.literal("foundation"),
  vault: v.literal("not-connected"),
  service: v.literal("not-configured"),
  login: v.literal("not-implemented"),
});

export type RuntimeStatus = v.InferOutput<typeof runtimeStatusSchema>;

export function isStatusRequest(value: unknown): boolean {
  return v.safeParse(statusRequestSchema, value).success;
}

export function parseRuntimeStatus(value: unknown): RuntimeStatus {
  return v.parse(runtimeStatusSchema, value);
}

export function getFoundationStatus(): RuntimeStatus {
  return {
    version: 1,
    stage: "foundation",
    vault: "not-connected",
    service: "not-configured",
    login: "not-implemented",
  };
}
