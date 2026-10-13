import { DEVICE_IDLE_LIMIT_MS } from "@pateat/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Clock, HardDrive, Laptop } from "lucide-react";
import { describeError, type ManageClient } from "./api";
import { Button } from "./button";
import {
  Badge,
  ErrorNotice,
  Line,
  Lines,
  PAGE_TITLE_CLASSES,
  ROW_CLASSES,
  RowIcon,
  RowList,
  RowMain,
  SuccessNotice,
} from "./ui";

export const DEVICES_QUERY_KEY = ["devices"] as const;

export function formatTime(milliseconds: number) {
  return `${new Date(milliseconds).toISOString().replace("T", " ").slice(0, 16)} UTC`;
}

const IDLE_LIMIT_DAYS = DEVICE_IDLE_LIMIT_MS / (24 * 60 * 60 * 1000);

export function DevicesPage({ client }: { client: ManageClient }) {
  const queryClient = useQueryClient();
  const devices = useQuery({ queryKey: DEVICES_QUERY_KEY, queryFn: () => client.devices() });
  const revoke = useMutation({
    mutationFn: (device: { id: string; label: string }) => client.revokeDevice(device.id),
    onSettled: () => queryClient.invalidateQueries({ queryKey: DEVICES_QUERY_KEY }),
  });

  return (
    <section aria-labelledby="devices-heading" className="space-y-4">
      <h1 id="devices-heading" className={PAGE_TITLE_CLASSES}>
        Devices
      </h1>
      <SuccessNotice
        id="devices-revoked"
        message={revoke.isSuccess && `${revoke.variables.label} revoked`}
      />
      {revoke.isError && (
        <ErrorNotice id="devices-error">{describeError(revoke.error)}</ErrorNotice>
      )}
      {devices.isPending ? (
        <output id="devices-status" className="block">
          Loading devices…
        </output>
      ) : devices.isError ? (
        <ErrorNotice id="devices-status">{describeError(devices.error)}</ErrorNotice>
      ) : devices.data.devices.length === 0 ? (
        <p id="devices-status">No devices are paired with this account.</p>
      ) : (
        <RowList id="devices">
          {devices.data.devices.map((device) => {
            const label = device.label || "Unnamed device";
            const paired = formatTime(device.createdAt);
            // As of loading the list; the service refuses an expired device.
            const expired = devices.dataUpdatedAt - device.lastUsedAt > DEVICE_IDLE_LIMIT_MS;
            const revoked =
              device.revokedAt === null ? "" : `, revoked ${formatTime(device.revokedAt)}`;
            return (
              <li key={device.id} className={ROW_CLASSES}>
                <RowIcon>
                  <Laptop size={16} aria-hidden />
                </RowIcon>
                <RowMain
                  title={label}
                  sub={`Paired ${paired}, last used ${formatTime(device.lastUsedAt)}${revoked}`}
                />
                {device.revokedAt !== null ? (
                  <Badge tone="muted">Revoked</Badge>
                ) : expired ? (
                  <Badge tone="warning">
                    <Clock size={12} aria-hidden />
                    Expired
                  </Badge>
                ) : (
                  <Button
                    variant="danger"
                    // Unnamed devices are told apart by when they were paired.
                    aria-label={`Revoke ${label}, paired ${paired}`}
                    disabled={revoke.isPending}
                    onClick={() => revoke.mutate({ id: device.id, label })}
                  >
                    Revoke
                  </Button>
                )}
              </li>
            );
          })}
        </RowList>
      )}
      <Lines>
        <Line icon={<Clock size={16} aria-hidden />}>
          A device unused for {IDLE_LIMIT_DAYS} days expires and must be paired again
        </Line>
        <Line icon={<HardDrive size={16} aria-hidden />}>
          Revoking does not erase data already on that device
        </Line>
      </Lines>
    </section>
  );
}
