import * as v from "valibot";
import { loginObservationSchema } from "./observation";
import { deviceModelSchema } from "./device-model";
import { syncRecipeIdSchema } from "./sync";
import { ssoLabelsSchema } from "./sso";
/** Only selected account/method labels and value-free page candidates go remotely. */
export const ssoGenerationRequestSchema = v.strictObject({
  version: v.literal(1),
  kind: v.literal("sso"),
  observation: loginObservationSchema,
  labels: ssoLabelsSchema,
  repair: v.optional(
    v.strictObject({
      recipeId: syncRecipeIdSchema,
      revision: v.pipe(v.number(), v.safeInteger(), v.minValue(1)),
    }),
  ),
  deviceModel: v.optional(deviceModelSchema),
});
export type SsoGenerationRequest = v.InferOutput<typeof ssoGenerationRequestSchema>;
