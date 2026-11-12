import type {
  LoginAttributeTarget,
  LoginStep,
  LoginTarget,
  ObservedCandidate,
} from "@pateat/contracts";
import type { addHandler, appendPageSteps } from "../../src/assemble";
import type { AssembleFixtures } from "../../src/assemble.test";

type Recipe = ReturnType<AssembleFixtures["built"]>;
type Candidate = ReturnType<AssembleFixtures["candidate"]>;
type Observation = Parameters<typeof addHandler>[1];
type CandidatePage = Omit<Observation, "candidates"> & { candidates: Candidate[] };
type TextTarget = Extract<LoginTarget, { by: "text" }>;

export type GeneratedContext = Pick<AssembleFixtures, "origin" | "target" | "page" | "built">;

export type ReplacedAdvanceContext = Pick<
  AssembleFixtures,
  "origin" | "target" | "page" | "built"
> & {
  first: Recipe;
  password: LoginStep;
  submit: LoginStep;
  replace: (steps: LoginStep[], base?: Recipe) => ReturnType<typeof appendPageSteps>;
};

export type CompletionContext = Pick<AssembleFixtures, "origin" | "target" | "candidate"> & {
  recipe: Recipe;
  home: CandidatePage;
};

export type CompletionSwitchContext = Pick<
  AssembleFixtures,
  "origin" | "target" | "page" | "candidate" | "built"
> & {
  other: TextTarget;
  switched: Recipe;
};

export type PasskeyHandlerContext = Pick<AssembleFixtures, "origin" | "target" | "candidate"> & {
  recipe: Recipe;
  securityKey: TextTarget;
  webauthn: (...candidates: Candidate[]) => CandidatePage;
  passkey: (locator?: LoginTarget) => { kind: "passkey"; target: LoginTarget };
};

export type AuthenticatorHandlerContext = Pick<
  AssembleFixtures,
  "origin" | "target" | "candidate"
> & {
  recipe: Recipe;
  app: TextTarget;
  chooser: (...candidates: ObservedCandidate[]) => Observation;
  authenticator: (locator?: LoginTarget) => { kind: "authenticator"; target: LoginTarget };
};

export type PasswordRoutesContext = Pick<
  AssembleFixtures,
  "origin" | "target" | "page" | "built"
> & {
  set: (slots: string[], button?: string) => LoginStep[];
  varied: () => Recipe;
  shown: (...ids: string[]) => CandidatePage;
};

export type PasskeyRouteContext = Pick<
  AssembleFixtures,
  "origin" | "target" | "page" | "candidate" | "built"
> & {
  button: TextTarget;
  signIn: LoginStep[];
  withPasskey: () => Recipe;
};

export type TotpProbesContext = Pick<AssembleFixtures, "target" | "candidate"> & {
  verify: TextTarget;
  key: TextTarget;
  recipe: Recipe;
  code: (id: string, extra?: Partial<Omit<ObservedCandidate, "target">>) => Candidate;
  at: (path: string, ...candidates: Candidate[]) => CandidatePage;
  totp: (
    field?: LoginAttributeTarget,
    button?: LoginTarget,
  ) => {
    kind: "totp";
    field: LoginAttributeTarget;
    target: LoginTarget;
  };
};
