/** Canonical rules and synthetic origins shared by policy and public-wrapper tests. */
export const rule = (hostname: string, includeSubdomains = false) => ({
  hostname,
  includeSubdomains,
});
export const sitePauseCases = [
  { origin: "https://login.example.co.uk", site: "example.co.uk", other: "other.co.uk" },
  { origin: "http://login.example.co.uk:8080", site: "example.co.uk", other: "other.co.uk" },
  { origin: "https://auth.alice.github.io", site: "alice.github.io", other: "bob.github.io" },
  { origin: "https://LOGIN.Example.COM.", site: "example.com", other: "other.example.com" },
  { origin: "http://192.0.2.1:8080", site: "192.0.2.1", other: "192.0.2.2" },
  { origin: "https://[2001:0db8::1]:8443", site: "[2001:db8::1]", other: "[2001:db8::2]" },
  { origin: "http://localhost:8080", site: "localhost", other: "other.localhost" },
  { origin: "http://router.", site: "router", other: "other.router" },
  { origin: "https://login.intranet", site: "login.intranet", other: "other.intranet" },
  { origin: "https://co.uk", site: "co.uk", other: "other.uk" },
] as const;
