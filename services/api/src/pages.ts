import type { Context } from "hono";
import { html } from "hono/html";
import type { HtmlEscapedString } from "hono/utils/html";
import type { ContentfulStatusCode } from "hono/utils/http-status";

/** Pages carry no script, load nothing and cannot be framed. */
export const PAGE_HEADERS = {
  "Content-Security-Policy":
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
} as const;

type Body = HtmlEscapedString | Promise<HtmlEscapedString>;

/** Every interpolated value is escaped by Hono's `html` helper. */
export function page(c: Context, status: ContentfulStatusCode, title: string, body: Body) {
  return c.html(
    html`<!doctype html>
      <html lang="en">
        <head>
          <meta charset="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <title>${title} · Pateat</title>
          <style>
            body {
              font:
                16px/1.5 system-ui,
                sans-serif;
              max-width: 40rem;
              margin: 2rem auto;
              padding: 0 1rem;
            }
            input,
            button {
              font: inherit;
            }
            table {
              border-collapse: collapse;
            }
            th,
            td {
              padding: 0.25rem 0.75rem 0.25rem 0;
              text-align: left;
            }
          </style>
        </head>
        <body>
          <main>
            <h1>${title}</h1>
            ${body}
          </main>
        </body>
      </html>`,
    status,
    PAGE_HEADERS,
  );
}

export function message(c: Context, status: ContentfulStatusCode, title: string, text: string) {
  return page(c, status, title, html`<p>${text}</p>`);
}
