import { describe } from "vitest";
import { registerOrdinarySemantics } from "../test/uri/ordinary-semantics-cases";
import { registerEquivalentDomains } from "../test/uri/equivalent-domain-cases";
import { registerRetainedContext } from "../test/uri/retained-context-cases";
import { registerStrictAdmission } from "../test/uri/strict-admission-cases";
import { registerRegex } from "../test/uri/regex-answer-cases";
import { registerDestinationGrant } from "../test/uri/destination-grant-cases";
import { registerAuthenticatedSdk } from "../test/uri/authenticated-sdk-cases";

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

export type UriTestFixtures = {
  target: typeof target;
  saved: typeof saved;
  emptyResult: typeof emptyResult;
  userDomains: typeof userDomains;
};

describe("pinned ordinary Bitwarden URI semantics", () => {
  registerOrdinarySemantics({ emptyResult, saved, target });
});

describe("same-account supplied equivalent domains", () => {
  registerEquivalentDomains({ emptyResult, saved, target, userDomains });
});

describe("retained account URI context", () => {
  registerRetainedContext({ emptyResult, saved, target, userDomains });
});

describe("strict destination and unsupported rule admission", () => {
  registerStrictAdmission({ emptyResult, saved, target, userDomains });
});

describe("Regex URIs answered by the caller (ADR 0056)", () => {
  registerRegex({ target });
});

describe("URI candidate matching is separate from the existing destination grant", () => {
  registerDestinationGrant();
});

describe("real SDK authenticated URI to local matching", () => {
  registerAuthenticatedSdk();
});
