// Starts and stops the synthetic Vaultwarden and Mailpit containers of compose.yaml.
// Each call gets its own compose project, so parallel specs or runs never share a vault.
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const composeFile = fileURLToPath(new URL("compose.yaml", import.meta.url));

export interface VaultwardenServer {
  /** The compose project; `docker compose ls --filter name=pateat-vaultwarden` lists leftovers. */
  readonly project: string;
  /** Plain HTTP server root on loopback, such as `http://127.0.0.1:32771`. */
  readonly baseUrl: string;
  /** The random host port of `baseUrl`, for a `http://localhost:<port>` root. */
  readonly port: number;
  /** Mailpit's HTTP API root on loopback. */
  readonly mailpitUrl: string;
  /** Both containers' output so far, to attach to a failed test. */
  logs(): Promise<string>;
  /** Removes the containers, their network and volumes. Safe to call more than once. */
  stop(): Promise<void>;
}

async function compose(project: string, ...args: string[]) {
  const { stdout } = await run("docker", ["compose", "-p", project, "-f", composeFile, ...args], {
    // An image pull on a cold runner prints a lot of progress.
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout;
}

async function publishedPort(project: string, service: string, port: number) {
  const output = (await compose(project, "port", service, String(port))).trim();
  const match = /^127\.0\.0\.1:(\d{1,5})$/.exec(output);
  if (!match) throw new Error(`Unexpected published address for ${service}: ${output}`);
  return Number(match[1]);
}

/** Polls `url` until it answers 200; the image's own healthcheck runs only once a minute. */
async function waitForOk(url: string, deadline: number) {
  for (;;) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
      // eslint-disable-next-line no-await-in-loop
      await response.body?.cancel();
      if (response.ok) return;
    } catch {
      // Not listening yet.
    }
    if (Date.now() > deadline) throw new Error(`${url} did not become ready`);
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/**
 * Starts a fresh server with an empty database. Usable from Playwright's global setup (return
 * `server.stop` as its teardown) or from a single spec's `beforeAll`.
 */
export async function startVaultwarden(
  options: { timeoutMs?: number } = {},
): Promise<VaultwardenServer> {
  const project = `pateat-vaultwarden-${randomUUID().slice(0, 8)}`;
  let stopped: Promise<void> | undefined;
  const stop = () => {
    stopped ??= compose(project, "down", "-v", "--remove-orphans").then(() => undefined);
    return stopped;
  };
  try {
    // A cold image pull is the slow part; once pulled, Vaultwarden is ready in a few seconds.
    const deadline = Date.now() + (options.timeoutMs ?? 180_000);
    await compose(project, "up", "-d", "--quiet-pull");
    const vaultwardenPort = await publishedPort(project, "vaultwarden", 80);
    const mailpitPort = await publishedPort(project, "mailpit", 8025);
    // The ports are bound on IPv4 loopback only, so `localhost` could first try `::1`.
    const baseUrl = `http://127.0.0.1:${vaultwardenPort}`;
    const mailpitUrl = `http://127.0.0.1:${mailpitPort}`;
    await Promise.all([
      waitForOk(`${baseUrl}/alive`, deadline),
      waitForOk(`${mailpitUrl}/readyz`, deadline),
    ]);
    const logs = () => compose(project, "logs", "--no-color", "--timestamps");
    return Object.freeze({ project, baseUrl, port: vaultwardenPort, mailpitUrl, logs, stop });
  } catch (error) {
    await stop().catch(() => {});
    throw error;
  }
}
