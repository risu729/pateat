import type { LoginObservation } from "@pateat/contracts";

export interface ObservationTestContext {
  page: (html: string, title?: string) => void;
  shadow: (selector: string, html: string, mode?: ShadowRootMode) => ShadowRoot;
  observe: () => LoginObservation;
  summary: (observation: LoginObservation) => Omit<LoginObservation["candidates"][number], "id">[];
}

export interface SignedInObservationTestContext extends ObservationTestContext {
  signedIn: () => LoginObservation;
}
