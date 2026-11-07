/**
 * How long one request to the service took, for the local log (ADR 0019): from just before
 * it was sent until its body was read (`roundTripMs`), and from the answer's
 * `Server-Timing` header, the service's own time (`total`), its token exchange (`token`)
 * and model call (`model`). `networkMs` is the round trip less the service's time: the
 * network both ways, the Worker's start and the body's transfer. An answer without the
 * header, such as an edge error page, or no answer at all has the round trip only.
 */
export type ServiceTiming = {
  roundTripMs: number;
  serverMs?: number;
  networkMs?: number;
  tokenMs?: number;
  modelMs?: number;
};

/** The longest `dur` taken from a `Server-Timing` header: a day; anything longer is wrong. */
const MAX_SERVER_TIMING_MS = 86_400_000;

/**
 * A `Server-Timing` header's metric `dur`ations by name; malformed entries, and durations
 * that are not finite or longer than a day, are skipped.
 */
export function serverTimings(header: string | null | undefined): Map<string, number> {
  const metrics = new Map<string, number>();
  if (!header) return metrics;
  // Entries and their parameters are separated outside quoted `desc` values.
  for (const entry of header.match(/(?:[^,"]|"(?:[^"\\]|\\.)*")+/gu) ?? []) {
    const [name, ...parameters] = (entry.match(/(?:[^;"]|"(?:[^"\\]|\\.)*")+/gu) ?? []).map(
      (part) => part.trim(),
    );
    if (!name || metrics.has(name)) continue;
    for (const parameter of parameters) {
      const match = /^dur\s*=\s*"?([0-9]+(?:\.[0-9]+)?)"?$/iu.exec(parameter);
      if (match) {
        const duration = Number(match[1]);
        if (Number.isFinite(duration) && duration <= MAX_SERVER_TIMING_MS)
          metrics.set(name, Math.round(duration));
        break;
      }
    }
  }
  return metrics;
}

/** One request's timing from its round trip and its answer's `Server-Timing` header. */
export function serviceTiming(roundTripMs: number, header?: string | null): ServiceTiming {
  const roundTrip = Math.max(0, Math.round(roundTripMs));
  const metrics = serverTimings(header);
  const server = metrics.get("total");
  const token = metrics.get("token");
  const model = metrics.get("model");
  return {
    roundTripMs: roundTrip,
    ...(server === undefined
      ? {}
      : { serverMs: server, networkMs: Math.max(0, roundTrip - server) }),
    ...(token === undefined ? {} : { tokenMs: token }),
    ...(model === undefined ? {} : { modelMs: model }),
  };
}

/**
 * Several requests' timing added up, as for one sync: the service's and the network's
 * time only when every request had the service's time.
 */
export function addTimings(
  total: ServiceTiming | undefined,
  next: ServiceTiming | undefined,
): ServiceTiming | undefined {
  if (!total || !next) return total ?? next;
  return {
    roundTripMs: total.roundTripMs + next.roundTripMs,
    ...(total.serverMs === undefined || next.serverMs === undefined
      ? {}
      : {
          serverMs: total.serverMs + next.serverMs,
          networkMs: (total.networkMs ?? 0) + (next.networkMs ?? 0),
        }),
  };
}
