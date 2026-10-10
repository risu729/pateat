import { matchBitwardenLoginUris } from "../../../../packages/bitwarden/src/uri";

/** The first input was decrypted and checksum-validated by the local SDK boundary. */
export function localUriVectors(uris: unknown) {
  const exact = matchBitwardenLoginUris(uris, "https://synthetic.example.test/login", {
    defaultMatch: 3,
  });
  const ownTenant = matchBitwardenLoginUris(
    [{ uri: "https://synthetic-a.github.io/login", match: 0 }],
    "https://synthetic-a.github.io/account",
  );
  const otherTenant = matchBitwardenLoginUris(
    [{ uri: "https://synthetic-a.github.io/login", match: 0 }],
    "https://synthetic-b.github.io/login",
  );
  return (
    exact.ok &&
    exact.data.matched &&
    exact.data.targetOrigin === "https://synthetic.example.test" &&
    ownTenant.ok &&
    ownTenant.data.matched &&
    otherTenant.ok &&
    !otherTenant.data.matched
  );
}
