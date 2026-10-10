import { createLocalFieldSnapshot } from "../../../../packages/bitwarden/src/fields";
import { generateLocalTotp } from "../../../../packages/bitwarden/src/totp";
import {
  bitwardenTotpTime,
  rfcTotpSecrets,
  steamTotpSecret,
} from "../../../../packages/bitwarden/src/__fixtures__/totp";

/** Fixed public vectors only; no page input or secret values leave the host. */
export function localFieldVectors(item: unknown) {
  const snapshot = createLocalFieldSnapshot({
    connectionId: "synthetic-browser",
    userId: "00000000-0000-0000-0000-000000000000",
    snapshotId: "b00c8d35-2d79-4118-b386-cf26d119d16b",
    item,
  });
  let localFields = false;
  if (snapshot.ok) {
    try {
      const password = snapshot.data.list().find((field) => field.ref.fieldId === "login.password");
      if (password) {
        const resolved = snapshot.data.resolve(password.ref, {
          allowedFieldIds: ["login.password"],
        });
        const denied = snapshot.data.resolve(password.ref, { allowedFieldIds: [] });
        localFields =
          resolved.ok &&
          resolved.data.kind === "text" &&
          resolved.data.value === "test_password" &&
          !denied.ok;
      }
    } finally {
      snapshot.data.dispose();
    }
  }
  const standard = generateLocalTotp(
    `otpauth://totp/Synthetic?secret=${rfcTotpSecrets.SHA1}&algorithm=SHA1&digits=8&period=30`,
    { nowMs: () => 59_000 },
  );
  const steam = generateLocalTotp(`steam://${steamTotpSecret}`, { nowMs: () => bitwardenTotpTime });
  return {
    localFields,
    localTotp:
      standard.ok && standard.data.value === "94287082" && standard.data.validUntilMs === 60_000,
    localSteam:
      steam.ok && steam.data.value === "7W6CJ" && steam.data.validUntilMs === 1_672_531_230_000,
  };
}
