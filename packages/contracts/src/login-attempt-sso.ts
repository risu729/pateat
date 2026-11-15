import * as v from "valibot";

/** What the SSO checks read of an attempt record, kept structural so the schema can use them. */
type SsoShape = {
  id: string;
  route: string;
  state: string;
  ssoParent?: true | undefined;
  ssoChild?: { attemptId: string } | undefined;
  variant?: number | undefined;
  handlers: readonly unknown[];
  chooser?: unknown;
  watch?: unknown;
  operationId?: string | undefined;
  operationKind?: unknown;
  operationEffect?: unknown;
  mutationIntent?: boolean | undefined;
  signInFill?: unknown;
  fillOnly?: unknown;
  document: { frameId: number };
  stepCount: number;
  stepIndex: number;
  usedOperationIds: readonly string[];
};

/**
 * The SSO fields of a login attempt record (ADR 0085), for an attempt id schema: the
 * `ssoParent` mark of an SSO parent, which never enters the native transition engine, and
 * the `ssoChild` exclusion of an exact native IdP child, which never restores the parent's
 * authority.
 */
export const ssoAttemptEntries = <Id extends v.GenericSchema<string>>(identifier: Id) => ({
  ssoParent: v.optional(v.literal(true)),
  ssoChild: v.optional(
    v.strictObject({
      parentId: identifier,
      attemptId: identifier,
      released: v.optional(v.literal(true)),
    }),
  ),
});

/** An SSO parent holds no native execution state; only an SSO parent is marked one. */
export const ssoParentShape = (metadata: SsoShape) =>
  metadata.route === "sso"
    ? metadata.ssoParent === true &&
      metadata.ssoChild === undefined &&
      metadata.variant === undefined &&
      metadata.handlers.length === 0 &&
      metadata.chooser === undefined &&
      metadata.watch === undefined &&
      metadata.operationId === undefined &&
      metadata.operationKind === undefined &&
      metadata.operationEffect === undefined &&
      metadata.mutationIntent === undefined &&
      metadata.signInFill === undefined &&
      metadata.fillOnly === undefined &&
      metadata.document.frameId === 0 &&
      metadata.stepCount === 1 &&
      metadata.stepIndex === 0 &&
      metadata.usedOperationIds.length === 0 &&
      ["awaiting-result", "reconciling", "authenticated", "blocked"].includes(metadata.state)
    : metadata.ssoParent === undefined;

/** An SSO child exclusion names its exact native attempt, in the top frame. */
export const ssoChildShape = (metadata: SsoShape) =>
  metadata.ssoChild === undefined ||
  (metadata.route !== "sso" &&
    metadata.ssoChild.attemptId === metadata.id &&
    metadata.document.frameId === 0);

/** A restarted worker ends an unfinished SSO parent as interrupted, unparsed. */
export const ssoParentRecovered = <Metadata extends { state: string }>(metadata: Metadata) =>
  ["authenticated", "blocked"].includes(metadata.state)
    ? metadata
    : { ...metadata, state: "blocked", outcome: "interrupted" };
