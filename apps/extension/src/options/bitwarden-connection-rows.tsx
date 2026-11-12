import { Menu } from "@base-ui/react/menu";
import { Ellipsis, Lock, LockOpen, LogIn, LogOut, RefreshCw, Shield, Trash2 } from "lucide-react";
import { formatLocale } from "../i18n";
import { Button } from "./button";
import { UnlockForm } from "./unlock-form";
import { Row, RowList, RowSub, RowTitle, StatusLines } from "./ui";
import {
  iconButtonClass,
  menuItemClass,
  needsSignIn,
  serverName,
  statusLines,
  UnusableItems,
  PartialItems,
} from "./bitwarden-connection-status";
import { deleteDialog } from "./bitwarden-delete-dialog";
import type { BitwardenSetupModel } from "./use-bitwarden-setup";

export function renderConnectionRows(model: BitwardenSetupModel) {
  const {
    connections,
    busy,
    challenge,
    unlocking,
    setUnlocking,
    t,
    signInAgain,
    syncConnection,
    menuTriggers,
    start,
    receive,
    client,
    unlockConnection,
    renderAccess,
  } = model;
  return (
    <RowList id="bitwarden-connections">
      {connections.map((connection) => {
        const signInFirst = needsSignIn(connection);
        const locked = connection.state === "locked";
        const blocked = busy || !!challenge;
        return (
          <Row
            key={connection.connectionId}
            icon={Shield}
            main={
              <>
                <RowTitle>{connection.label}</RowTitle>
                <RowSub>
                  {t("{{email}} on {{server}}", {
                    email: connection.email,
                    server: serverName(connection.environment, t),
                  })}
                </RowSub>
                <StatusLines lines={statusLines(connection, t, formatLocale())} />
                <UnusableItems connection={connection} />
                <PartialItems connection={connection} />
              </>
            }
            actions={
              <>
                {locked ? (
                  <Button
                    type="button"
                    variant="outline"
                    disabled={blocked}
                    focusableWhenDisabled={busy}
                    aria-expanded={unlocking === connection.connectionId}
                    aria-label={t("{{name}}: {{action}}", {
                      name: connection.label,
                      action: t("Unlock"),
                    })}
                    onClick={() =>
                      setUnlocking((open) =>
                        open === connection.connectionId ? undefined : connection.connectionId,
                      )
                    }
                  >
                    <LockOpen aria-hidden size={16} strokeWidth={2} />
                    {t("Unlock")}
                  </Button>
                ) : (
                  <Button
                    type="button"
                    variant="outline"
                    disabled={blocked}
                    focusableWhenDisabled={busy}
                    aria-label={t("{{name}}: {{action}}", {
                      name: connection.label,
                      action: t(signInFirst ? "Sign in again" : "Sync"),
                    })}
                    onClick={() =>
                      signInFirst ? signInAgain(connection) : syncConnection(connection)
                    }
                  >
                    {signInFirst ? (
                      <LogIn aria-hidden size={16} strokeWidth={2} />
                    ) : (
                      <RefreshCw aria-hidden size={16} strokeWidth={2} />
                    )}
                    {t(signInFirst ? "Sign in again" : "Sync")}
                  </Button>
                )}
                <Menu.Root>
                  <Menu.Trigger
                    ref={(element: HTMLButtonElement | null) => {
                      if (element) menuTriggers.current.set(connection.connectionId, element);
                      else menuTriggers.current.delete(connection.connectionId);
                    }}
                    className={iconButtonClass}
                    aria-label={t("More for {{name}}", { name: connection.label })}
                    disabled={blocked}
                  >
                    <Ellipsis aria-hidden size={16} strokeWidth={2} />
                  </Menu.Trigger>
                  <Menu.Portal>
                    <Menu.Positioner sideOffset={4} align="end">
                      <Menu.Popup className="min-w-56 rounded-lg border border-border bg-surface p-1 text-ink shadow-[var(--shadow-menu)] outline-none">
                        {signInFirst ? (
                          <Menu.Item
                            className={menuItemClass}
                            aria-label={t("{{name}}: Sync", { name: connection.label })}
                            onClick={() => syncConnection(connection)}
                          >
                            <RefreshCw aria-hidden size={16} strokeWidth={2} />
                            {t("Sync")}
                          </Menu.Item>
                        ) : (
                          <Menu.Item
                            className={menuItemClass}
                            aria-label={t("{{name}}: Sign in again", { name: connection.label })}
                            onClick={() => signInAgain(connection)}
                          >
                            <LogIn aria-hidden size={16} strokeWidth={2} />
                            {t("Sign in again")}
                          </Menu.Item>
                        )}
                        <Menu.Item
                          className={menuItemClass}
                          aria-label={t("{{name}}: Lock", { name: connection.label })}
                          disabled={
                            locked ||
                            connection.state === "disabled" ||
                            connection.autoUnlock === "unknown"
                          }
                          onClick={() =>
                            start(async (epoch) => {
                              setUnlocking(undefined);
                              await receive(await client.lock(connection.connectionId), epoch);
                            })
                          }
                        >
                          <Lock aria-hidden size={16} strokeWidth={2} />
                          {t("Lock")}
                        </Menu.Item>
                        <Menu.Item
                          className={menuItemClass}
                          aria-label={t("{{name}}: Log out", { name: connection.label })}
                          disabled={connection.state === "disabled"}
                          onClick={() =>
                            start(async (epoch) => {
                              setUnlocking(undefined);
                              await receive(
                                await client.disableAutoUnlock(connection.connectionId),
                                epoch,
                              );
                            })
                          }
                        >
                          <LogOut aria-hidden size={16} strokeWidth={2} />
                          {t("Log out")}
                        </Menu.Item>
                        <Menu.Item
                          className={menuItemClass}
                          aria-label={t("{{name}}: Forget sync sign-in", {
                            name: connection.label,
                          })}
                          disabled={connection.providerSession === "none"}
                          onClick={() =>
                            start(async (epoch) => {
                              await receive(
                                await client.forgetProviderSession(connection.connectionId),
                                epoch,
                              );
                            })
                          }
                        >
                          <LogOut aria-hidden size={16} strokeWidth={2} />
                          {t("Forget sync sign-in")}
                        </Menu.Item>
                        <Menu.Item
                          className={`${menuItemClass} text-danger`}
                          aria-label={t("{{name}}: Delete connection", {
                            name: connection.label,
                          })}
                          onClick={() => deleteDialog.openWithPayload(connection)}
                        >
                          <Trash2 aria-hidden size={16} strokeWidth={2} />
                          {t("Delete connection")}
                        </Menu.Item>
                      </Menu.Popup>
                    </Menu.Positioner>
                  </Menu.Portal>
                </Menu.Root>
              </>
            }
          >
            {locked && unlocking === connection.connectionId && (
              <div className="basis-full">
                <UnlockForm
                  // The form opens because the person pressed Unlock to type into it.
                  // oxlint-disable-next-line jsx-a11y/no-autofocus
                  autoFocus
                  disabled={blocked}
                  accountLabel={connection.email}
                  onSubmit={(value) => unlockConnection(connection, value)}
                />
              </div>
            )}
            {renderAccess?.(connection.connectionId)}
          </Row>
        );
      })}
    </RowList>
  );
}
