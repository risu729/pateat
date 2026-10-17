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
  locales: {
    root: {
      label: "English",
      lang: "en",
      themeConfig: {
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
          { text: "Policies", items: [{ text: "Privacy policy", link: "/privacy" }] },
        ],
      },
    },
    ja: {
      label: "日本語",
      lang: "ja",
      link: "/ja/",
      description: "この端末に保存した Bitwarden の保管庫で、ウェブサイトへのログインとパスキー署名を行います。",
      themeConfig: {
        nav: [
          { text: "使い方", link: "/ja/installation" },
          { text: "プライバシー", link: "/ja/privacy" },
        ],
        sidebar: [
          {
            text: "使い方",
            items: [
              { text: "はじめに", link: "/ja/" },
              { text: "インストール", link: "/ja/installation" },
              { text: "初期設定", link: "/ja/setup" },
              { text: "権限", link: "/ja/permissions" },
            ],
          },
          { text: "ポリシー", items: [{ text: "プライバシーポリシー", link: "/ja/privacy" }] },
        ],
        outline: { label: "目次" },
        docFooter: { prev: "前のページ", next: "次のページ" },
        sidebarMenuLabel: "メニュー",
        returnToTopLabel: "ページの先頭に戻る",
        darkModeSwitchLabel: "外観",
        lightModeSwitchTitle: "ライトモードに切り替え",
        darkModeSwitchTitle: "ダークモードに切り替え",
        langMenuLabel: "言語を変更",
        skipToContentLabel: "本文へスキップ",
        editLink: {
          pattern: `${repository}/edit/main/apps/docs/src/:path`,
          text: "GitHub でこのページを編集",
        },
        footer: {
          message: `Pateat 拡張機能のライセンスは <a href="${repository}/blob/main/LICENSING.md">GPL-3.0-only</a> です。`,
        },
      },
    },
  },
  themeConfig: {
    logo: "/icon.svg",
    search: {
      provider: "local",
      options: {
        locales: {
          ja: {
            translations: {
              button: { buttonText: "検索", buttonAriaLabel: "ドキュメントを検索" },
              modal: {
                displayDetails: "詳細を表示",
                resetButtonTitle: "検索をクリア",
                backButtonTitle: "検索を閉じる",
                noResultsText: "次の検索に一致する結果はありません",
                footer: {
                  selectText: "選択",
                  selectKeyAriaLabel: "Enter キー",
                  navigateText: "移動",
                  navigateUpKeyAriaLabel: "上矢印キー",
                  navigateDownKeyAriaLabel: "下矢印キー",
                  closeText: "閉じる",
                  closeKeyAriaLabel: "Esc キー",
                },
              },
            },
          },
        },
      },
    },
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
