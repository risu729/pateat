import {
  type LoginAttemptMetadata,
  type LoginDocument,
  type LoginChooserRecipe,
  type LoginRecipe,
} from "@pateat/contracts";
import {
  type Shown,
  type ListOffer,
  type Announced,
  type Unoffered,
  type Readiness,
  type LiveDocument,
  type ConfirmVisit,
  type LayoutChoice,
  type LaterStart,
} from "./types";
import type { AskReason } from "../choice-wire";

export type AdmitContext = {
  document: LoginDocument;
  key: string;
  incognito: boolean | undefined;
  siteOrigin: string;
  live: LiveDocument;
  paused: boolean;
  refuse: (
    reason: string,
    detail?: string,
    unrelated?: boolean,
    candidates?: number,
  ) => Promise<Readiness>;
  notStarted: (detail: string, visit?: ConfirmVisit) => void;
  recorded: LoginAttemptMetadata | undefined;
  askKey: string;
  ask: AskReason | undefined;
  switched: boolean;
  previous: LoginAttemptMetadata | undefined;
  recipe: LoginRecipe | undefined;
  layoutChoices: LayoutChoice[];
  layoutCount: number;
  chooser: LoginChooserRecipe | undefined;
  shownOther: boolean;
  later: LaterStart | undefined;
  revised: boolean;
  start: { path: string } | undefined;
  signIn: { path: string; identifier?: true | undefined; passkey?: true | undefined } | undefined;
  shown: Shown | undefined;
  list: ListOffer | undefined;
  entryHello: Announced | undefined;
  unoffered: Unoffered | undefined;
};

export type AdmitStartContext = AdmitContext & { recipe: LoginRecipe };
