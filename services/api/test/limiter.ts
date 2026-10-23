import { env } from "cloudflare:workers";

/** The limits of PAIR_LIMITER and OWNER_LIMITER in cloudflare.config.ts. */
export const PAIR_LIMIT = 10;
export const OWNER_LIMIT = 120;

/**
 * `env` with `binding` replaced by a limiter that allows `limit` calls per key and never
 * refills. Miniflare's local limiter counts in wall-clock minutes, so a test loop that
 * crossed a minute boundary would start a fresh count; this one's window never ends.
 */
export function withLimiter(binding: "OWNER_LIMITER" | "PAIR_LIMITER", limit: number): Env {
  const counts = new Map<string, number>();
  const limiter: RateLimit = {
    async limit({ key }) {
      const count = (counts.get(key) ?? 0) + 1;
      counts.set(key, count);
      return { success: count <= limit };
    },
  };
  return { ...env, [binding]: limiter };
}
