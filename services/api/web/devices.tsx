import { DEVICE_IDLE_LIMIT_MS } from "@pateat/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { describeError, type ManageClient } from "./api";
import { Button } from "./button";

export const DEVICES_QUERY_KEY = ["devices"] as const;

function formatTime(milliseconds: number) {
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
      <h2 id="devices-heading" className="text-xl font-semibold">
        Devices
      </h2>
      <p className="text-slate-700">
        Revoking a device stops its later service requests. It does not erase data already stored on
        that device or affect any vault. A device unused for {IDLE_LIMIT_DAYS} days expires the same
        way and must be paired again.
      </p>
      <output id="devices-revoked" className="block text-slate-700">
        {revoke.isSuccess && `${revoke.variables.label} was revoked.`}
      </output>
      {revoke.isError && (
        <p role="alert" id="devices-error" className="text-red-800">
          {describeError(revoke.error)}
        </p>
      )}
      {devices.isPending ? (
        <output id="devices-status" className="block">
          Loading devices…
        </output>
      ) : devices.isError ? (
        <p role="alert" id="devices-status" className="text-red-800">
          {describeError(devices.error)}
        </p>
      ) : devices.data.devices.length === 0 ? (
        <p id="devices-status">No devices are paired with this account.</p>
      ) : (
        <table id="devices" className="w-full border-collapse text-left">
          <thead>
            <tr className="border-b border-slate-300">
              <th scope="col" className="py-2 pr-4">
                Device
              </th>
              <th scope="col" className="py-2 pr-4">
                Paired
              </th>
              <th scope="col" className="py-2 pr-4">
                Last used
              </th>
              <th scope="col" className="py-2">
                Status
              </th>
            </tr>
          </thead>
          <tbody>
            {devices.data.devices.map((device) => {
              const label = device.label || "Unnamed device";
              const paired = formatTime(device.createdAt);
              // As of loading the list; the service refuses an expired device.
              const expired = devices.dataUpdatedAt - device.lastUsedAt > DEVICE_IDLE_LIMIT_MS;
              return (
                <tr key={device.id} className="border-b border-slate-200">
                  <td className="py-2 pr-4">{label}</td>
                  <td className="py-2 pr-4">{paired}</td>
                  <td className="py-2 pr-4">{formatTime(device.lastUsedAt)}</td>
                  <td className="py-2">
                    {device.revokedAt !== null ? (
                      `Revoked ${formatTime(device.revokedAt)}`
                    ) : expired ? (
                      "Expired"
                    ) : (
                      <Button
                        variant="outline"
                        // Unnamed devices are told apart by when they were paired.
                        aria-label={`Revoke ${label}, paired ${paired}`}
                        disabled={revoke.isPending}
                        onClick={() => revoke.mutate({ id: device.id, label })}
                      >
                        Revoke
                      </Button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}
