import * as v from "valibot";
import { ssoMethodsSchema, ssoCandidatesSchema } from "./sso-wire";
import type { HostOperation } from "./wire";

/** Strict response and request binding; a compromised relay cannot widen candidate scope. */
export function validSsoResult(
  operation: Extract<HostOperation, { kind: "sso-methods" | "sso-candidates" }>,
  data: unknown,
): boolean {
  if (operation.kind === "sso-methods") {
    const checked = v.safeParse(ssoMethodsSchema, data);
    if (
      !checked.success ||
      checked.output.snapshotId !== operation.session.snapshotId ||
      checked.output.itemId !== operation.itemId.toLowerCase()
    )
      return false;
    const result = checked.output.result;
    if (result.status === "refused") return true;
    return (
      new Set(result.methods.map((method) => method.method.number)).size ===
        result.methods.length &&
      new Set(result.methods.map((method) => method.fieldId)).size === result.methods.length &&
      result.methods.every(
        (method) =>
          operation.allowedFieldIds.includes(method.fieldId) &&
          method.automatic === (method.method.number === 1) &&
          (method.form === "url"
            ? method.origin !== undefined &&
              method.label === undefined &&
              method.automatic &&
              result.methods.length === 1
            : method.label !== undefined && method.origin === undefined),
      )
    );
  }
  const checked = v.safeParse(ssoCandidatesSchema, data);
  return (
    checked.success &&
    checked.output.snapshotId === operation.session.snapshotId &&
    new Set(checked.output.candidates.map((item) => item.itemId)).size ===
      checked.output.candidates.length &&
    checked.output.candidates.every(
      (item) =>
        operation.candidates.some((candidate) => candidate.itemId.toLowerCase() === item.itemId) &&
        new Set(item.origins).size === item.origins.length,
    )
  );
}
