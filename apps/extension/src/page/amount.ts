import { renderedText } from "./text";

/** How much of a form's text is read for an amount. */
const amountReadLimit = 4000;
/**
 * An amount: a yen or dollar sign before a digit, or a digit before `円`, in half or full
 * width (`¥1,000`, `￥１０００`, `$ 25`, `1,000 円`).
 */
const amountPattern = /[¥￥$＄]\s*[0-9０-９]|[0-9０-９]\s*円/u;

/**
 * Whether an amount shows inside `form` (ADR 0035): read from its rendered text only, never
 * from a control's value, and only as this flag, never the amount itself.
 */
export function showsAmount(form: Element): boolean {
  return amountPattern.test(renderedText(form, amountReadLimit) ?? "");
}
