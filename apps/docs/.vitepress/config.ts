import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";
import { defineConfig } from "vitepress";

const repository = "https://github.com/risu729/pateat";

/** Serves the extension's own icon at /icon.svg, so the site keeps no copy of it. */
function extensionIcon(): Plugin {
  const source = () =>
    readFileSync(fileURLToPath(new URL("../../extension/icons/icon.svg", import.meta.url)));
  return {
    name: "pateat-extension-icon",
    configureServer(server) {
      server.middlewares.use("/icon.svg", (_request, response) => {
        response.setHeader("Content-Type", "image/svg+xml");
        response.end(source());
      });
    },
    generateBundle() {
      this.emitFile({ type: "asset", fileName: "icon.svg", source: source() });
    },
  };
}

export default defineConfig({
  title: "Pateat",
  description:
    "Logs in to websites and answers passkey sign-ins from your own Bitwarden vault, kept on this device.",
  lang: "en",
  srcDir: "src",
  cleanUrls: true,
  head: [["link", { rel: "icon", type: "image/svg+xml", href: "/icon.svg" }]],
  vite: { plugins: [extensionIcon()] },
  themeConfig: {
    logo: "/icon.svg",
    nav: [
      { text: "Guide", link: "/installation" },
      { text: "Privacy", link: "/privacy" },
    ],
    sidebar: [
      {
        text: "Guide",
        items: [
          { text: "Introduction", link: "/" },
          { text: "Installation", link: "/installation" },
          { text: "Setup", link: "/setup" },
          { text: "Permissions", link: "/permissions" },
        ],
      },
      {
        text: "Policies",
        items: [{ text: "Privacy policy", link: "/privacy" }],
      },
    ],
    search: { provider: "local" },
    editLink: {
      pattern: `${repository}/edit/main/apps/docs/src/:path`,
      text: "Edit this page on GitHub",
    },
    socialLinks: [{ icon: "github", link: repository }],
    footer: {
      message: `The Pateat extension is licensed under <a href="${repository}/blob/main/LICENSING.md">GPL-3.0-only</a>.`,
    },
  },
});
