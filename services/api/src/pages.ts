import type { Context } from "hono";
import { html } from "hono/html";
import type { HtmlEscapedString } from "hono/utils/html";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import icon from "../../../apps/extension/icons/icon.svg?raw";

/**
 * The extension's logo, inlined so the icon shows on every page whichever Access
 * application guards it; a separate icon path could sit behind another one.
 */
const ICON = `data:image/svg+xml,${encodeURIComponent(icon.trim())}`;

/** Pages carry no script, load nothing but their inline icon and cannot be framed. */
export const PAGE_HEADERS = {
  "Content-Security-Policy":
    "default-src 'none'; style-src 'unsafe-inline'; img-src data:; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
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
          <link rel="icon" type="image/svg+xml" href="${ICON}" />
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
