import type { BitwardenSetupProps } from "./bitwarden-setup-types";
import { useBitwardenSetup } from "./use-bitwarden-setup";
import { renderBitwardenSetup } from "./bitwarden-setup-view";

export function BitwardenSetup(props: BitwardenSetupProps) {
  const model = useBitwardenSetup(props);
  return renderBitwardenSetup(model);
}
