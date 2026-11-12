import { AlertDialog } from "@base-ui/react/alert-dialog";
import type { Connection } from "./bitwarden-setup-types";

// One handle for the stable setup component's row triggers and confirmation dialog.
export const deleteDialog = AlertDialog.createHandle<Connection>();
