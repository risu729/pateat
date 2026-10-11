import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Miniflare } from "miniflare";

const project = fileURLToPath(new URL("../../services/api/", import.meta.url));
const workerDirectory = join(project, ".cloudflare", "output", "v0", "workers", "default");

export type SyncService = {
  /** The HTTPS origin the extension pairs with; its certificate is self-signed. */
  origin: string;
  deviceId: string;
  credential: string;
  /** Calls the API as the paired device without going through the browser. */
  request(path: string, init?: { method?: string; body?: unknown }): Promise<Response>;
  /** Stops the service; later calls wait for the same shutdown. */
  close(): Promise<void>;
};

/**
 * Serves the built API Worker (`mise run //services/api:build`) on loopback HTTPS with a fresh
 * local D1 database, one owner and one device. Nothing leaves the machine.
 */
export async function startSyncService(): Promise<SyncService> {
  const config = JSON.parse(await readFile(join(workerDirectory, "worker.config.json"), "utf8"));
  // Owner pages need Cloudflare Access; device sync routes do not use it.
  delete config.env?.ACCESS_TEAM_DOMAIN;
  delete config.env?.ACCESS_AUD;
  const mainModule: string = config.manifest.mainModule;
  const runtime = new Miniflare({
    https: true,
    host: "127.0.0.1",
    port: 0,
    workers: [
      {
        config: {
          ...config,
          // The owner web UI's built assets; device sync does not use them.
          assets: {
            ...config.assets,
            directory: join(workerDirectory, "assets"),
            hasUserWorker: true,
          },
          manifest: {
            mainModule,
            modules: {
              [mainModule]: {
                type: "esm",
                contents: await readFile(join(workerDirectory, "bundle", mainModule), "utf8"),
              },
            },
          },
        },
        dev: {
          outboundService: {
            type: "fetcher",
            handler() {
              throw new Error("The API Worker must not make outbound requests");
            },
          },
        },
      },
    ],
  });
  try {
    const url = await runtime.ready;
    const db = await runtime.getD1Database("DB");
    const migrations = join(project, "migrations");
    for (const name of (await readdir(migrations)).filter((file) => file.endsWith(".sql")).sort())
      for (const statement of (await readFile(join(migrations, name), "utf8")).split(
        "--> statement-breakpoint",
      ))
        if (statement.trim()) await db.prepare(statement).run();

    const ownerId = crypto.randomUUID();
    const deviceId = crypto.randomUUID();
    const credential = `pateat_device_${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url")}`;
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(credential));
    const tokenHash = Buffer.from(digest).toString("hex");
    const now = Date.now();
    await db.prepare("INSERT INTO owners (id, created_at) VALUES (?, ?)").bind(ownerId, now).run();
    await db
      .prepare(
        "INSERT INTO devices (id, owner_id, token_hash, label, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .bind(deviceId, ownerId, tokenHash, "Synthetic test device", now)
      .run();

    const origin = url.origin;
    let closed: Promise<void> | undefined;
    return {
      origin,
      deviceId,
      credential,
      request: (path, init = {}) =>
        runtime.dispatchFetch(`${origin}${path}`, {
          method: init.method ?? "GET",
          headers: {
            Authorization: `Bearer ${credential}`,
            ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
          },
          ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
        }) as unknown as Promise<Response>,
      // Safe to call again, e.g. from a `finally` after a test already stopped it.
      close: () => (closed ??= runtime.dispose()),
    };
  } catch (error) {
    await runtime.dispose();
    throw error;
  }
}
