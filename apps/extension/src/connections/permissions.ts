import {
  bitwardenEndpoints,
  normalizeBitwardenProfile,
  type BitwardenProfile,
} from "@pateat/bitwarden";

/** Preview is pure; only the options button calls permissions.request inside its user gesture. */
export function providerPermissionOrigins(environment: BitwardenProfile["environment"]) {
  const profile = normalizeBitwardenProfile({ connectionId: "permission-preview", environment });
  if (!profile.ok) return profile;
  const endpoints = bitwardenEndpoints(profile.data);
  return {
    ok: true as const,
    data: [
      ...new Set(
        [endpoints.identityUrl, endpoints.apiUrl].map((url) => `${new URL(url).origin}/*`),
      ),
    ],
  };
}
