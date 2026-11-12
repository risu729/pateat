import * as v from "valibot";

/**
 * A branch of a chooser recipe (ADR 0028): the page after a listed or shown account
 * (`account`), or after the `other` button (`other`).
 */
export const chooserBranchSchema = v.picklist(["account", "other", "passkey"]);
export type ChooserBranch = v.InferOutput<typeof chooserBranchSchema>;
/**
 * Which route of a stored recipe a record or request is about (ADR 0060): a layout's key,
 * and for a chooser (ADR 0028) the branch after a colon, such as `1760000000000:account`.
 * The service keeps it in the `branch` columns of its records.
 */
export const recipeBranchSchema = v.pipe(
  v.string(),
  v.regex(/^\d{1,16}(?::(?:account|other|passkey))?$/u),
);
/**
 * What a login clicks on a chooser's list (ADR 0028): the entry of the chosen account, the
 * `continue` button beside the one shown account, or the `other` button.
 */
export const listClickSchema = v.picklist(["entry", "continue", "other"]);
export type ListClick = v.InferOutput<typeof listClickSchema>;
/**
 * How a chooser login (ADR 0028) entered its branch: by its click on the list,
 * `other-shown` when its path already showed the `other` branch's form instead of the
 * list, as after the person pressed the button for another account, so it clicked nothing,
 * or `passkey` when it pressed the passkey button beside the list instead (ADR 0079).
 */
export const chooserClickSchema = v.picklist([
  ...listClickSchema.options,
  "other-shown",
  "passkey",
]);
export type ChooserClick = v.InferOutput<typeof chooserClickSchema>;
