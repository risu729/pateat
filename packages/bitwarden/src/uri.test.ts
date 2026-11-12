import { describe, expect, it, vi } from "vitest";
import * as sdk from "@bitwarden/sdk-internal/node/bitwarden_wasm_internal.js";
import {
  createDefaultSettings,
  DUMMY_VAULT_CATALOG,
  resolveSiteAccount,
} from "../../contracts/src/settings";
import {
  admitBitwardenUriMatchContext,
  createBitwardenUriMatchContext,
  createBitwardenUriMatcher,
  matchBitwardenLoginUris,
  maxTargetUrlLength,
  type BitwardenUriMatchContext,
} from "./uri";
import { createLocalCryptoSession } from "./local-crypto";
import { uriMatchCases } from "./__fixtures__/uri";
import {
  legacyCipher,
  uriCiphertexts,
  v1Email,
  v1Kdf,
  v1Password,
  v1PrivateKey,
  v1WrappedUserKey,
} from "./__fixtures__/crypto";

import {
  registerOrdinarySemantics,
  registerEquivalentDomains,
} from "../test/uri/ordinary-semantics";
import { registerRetainedContext } from "../test/uri/retained-context";
import { registerStrictAdmission } from "../test/uri/strict-admission";
import { registerRegex } from "../test/uri/regex";
import { registerDestinationGrant, registerAuthenticatedSdk } from "../test/uri/integration";

const target = "https://example.com/login";
const saved = (uri = target, match: number | null = 0) => [{ uri, match }];
const emptyResult = (targetUrl = target) => ({
  ok: true,
  data: {
    matched: false,
    targetOrigin: new URL(targetUrl).origin,
    matches: [],
    unavailableUris: [],
  },
});
const userDomains = (equivalentDomains: string[][]) => ({
  equivalentDomains,
  globalEquivalentDomains: [],
});

const bindings = {
  expect,
  it,
  vi,
  sdk,
  createDefaultSettings,
  DUMMY_VAULT_CATALOG,
  resolveSiteAccount,
  admitBitwardenUriMatchContext,
  createBitwardenUriMatchContext,
  createBitwardenUriMatcher,
  matchBitwardenLoginUris,
  maxTargetUrlLength,
  createLocalCryptoSession,
  uriMatchCases,
  legacyCipher,
  uriCiphertexts,
  v1Email,
  v1Kdf,
  v1Password,
  v1PrivateKey,
  v1WrappedUserKey,
  target,
  saved,
  emptyResult,
  userDomains,
};

export type UriTestBindings = typeof bindings;
export type UriMatchContext = BitwardenUriMatchContext;

describe("pinned ordinary Bitwarden URI semantics", () => {
  registerOrdinarySemantics(bindings);
});

describe("same-account supplied equivalent domains", () => {
  registerEquivalentDomains(bindings);
});

describe("retained account URI context", () => {
  registerRetainedContext(bindings);
});

describe("strict destination and unsupported rule admission", () => {
  registerStrictAdmission(bindings);
});

describe("Regex URIs answered by the caller (ADR 0056)", () => {
  registerRegex(bindings);
});

describe("URI candidate matching is separate from the existing destination grant", () => {
  registerDestinationGrant(bindings);
});

describe("real SDK authenticated URI to local matching", () => {
  registerAuthenticatedSdk(bindings);
});
