import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

/** A synthetic page answer: a document, or a redirect to `location`. */
export type HopAnswer = { status: number; location?: string; body?: string };
export type RedirectHops = {
  /** Browser arguments that send the synthetic sites' network requests to this server. */
  args: string[];
  /** Answers the requests that reach the network, as the follow-up of a redirect does. */
  serve(answer: (url: URL) => HopAnswer): void;
  close(): Promise<void>;
};

/**
 * A local HTTPS server for the synthetic sites. Playwright routes only the first request of
 * a redirect chain, so a fulfilled 302 sends its follow-up to the network; this server
 * answers it, and Chrome follows real redirects instead of showing an error page.
 */
export async function startRedirectHops(hosts: readonly string[]): Promise<RedirectHops> {
  const directory = await mkdtemp(join(tmpdir(), "pateat-sso-hops-"));
  try {
    // A throwaway self-signed certificate; the browser is told to accept it.
    await promisify(execFile)("openssl", [
      "req",
      "-x509",
      "-newkey",
      "ec",
      "-pkeyopt",
      "ec_paramgen_curve:prime256v1",
      "-nodes",
      "-days",
      "1",
      "-subj",
      "/CN=synthetic.example.test",
      "-keyout",
      join(directory, "key.pem"),
      "-out",
      join(directory, "cert.pem"),
    ]);
    let answer: ((url: URL) => HopAnswer) | undefined;
    const server = createServer(
      {
        key: await readFile(join(directory, "key.pem")),
        cert: await readFile(join(directory, "cert.pem")),
      },
      (request, response) => {
        const url = new URL(request.url ?? "/", "https://" + request.headers.host);
        const reply = answer?.(url) ?? { status: 404, body: "<h1>Unexpected destination</h1>" };
        response.writeHead(reply.status, {
          "content-type": "text/html; charset=utf-8",
          ...(reply.location ? { location: reply.location } : {}),
        });
        response.end(reply.body ?? "");
      },
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    return {
      args: [
        "--host-resolver-rules=" + hosts.map((host) => `MAP ${host} 127.0.0.1:${port}`).join(", "),
        "--ignore-certificate-errors",
        // A proxy from the environment would resolve the synthetic hosts itself.
        "--no-proxy-server",
      ],
      serve(next) {
        answer = next;
      },
      close: () =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
