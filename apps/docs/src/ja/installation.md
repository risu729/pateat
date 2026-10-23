# インストール

::: warning まだリリースしていません
Pateat のリリースはまだ公開しておらず、リリースの形式も決まっていません。以下の手順は、[GitHub Releases](https://github.com/risu729/pateat/releases) の ZIP ファイルを、パッケージ化されていない拡張機能として Chrome に読み込むことを前提にしています。それまでは[ソースからビルド](#build-from-source)してください。
:::

## 必要なもの {#requirements}

- デスクトップの Google Chrome 145 以降。Pateat は自分のコンピューターにインストールした Chrome を対象にしています。ほかの Chromium 系ブラウザーや、クラウド上のブラウザーでは試していません。
- Bitwarden クラウド（米国または EU）、セルフホストの Bitwarden サーバー、または最新版の [Vaultwarden](https://github.com/dani-garcia/vaultwarden) の Bitwarden アカウント。HTTPS で接続できること（`localhost` と `127.0.0.1` だけは HTTP でも可）。Bitwarden 自身のサーバーでは、まだ Bitwarden クラウド（米国）のアカウント 1 つでしか試していません。Vaultwarden は最近の版で自動テストしています。
- ペアリングする Pateat サービス。設定とレシピを保存します。インストールの前に [Pateat サービス](./setup.md#the-pateat-service)を読んでください。

## リリースをインストールする {#install-a-release}

1. [GitHub Releases](https://github.com/risu729/pateat/releases) のリリースから Chrome 用の ZIP ファイルをダウンロードします。
2. 残しておくフォルダーに展開します。Chrome は起動のたびにそのフォルダーから拡張機能を読み込むので、削除や移動はしないでください。
3. `chrome://extensions` を開き、右上の **デベロッパー モード** をオンにします。
4. **パッケージ化されていない拡張機能を読み込む** を押し、展開したフォルダー（`manifest.json` があるフォルダー）を選びます。
5. 拡張機能メニュー（パズルのピースのアイコン）から Pateat をツールバーに固定すると、ページごとに何をしたかを確認できます。

パッケージ化されていない拡張機能では、Chrome はいつもの権限の確認を表示しません。Pateat は読み込まれた時点で、すべての HTTPS と HTTP のサイトにアクセスできます。そのアクセスが何のためにあり、どう制限できるかは[権限](./permissions.md)にあります。

Pateat の拡張機能 ID はマニフェストの鍵で固定されているので、どのリリースでも同じ ID になり、Chrome 内のデータも引き継がれます。

## 新しいリリースに更新する {#update-to-a-new-release}

1. 読み込んだフォルダーの中身を削除し、新しいリリースの ZIP ファイルを同じフォルダーに展開します。
2. `chrome://extensions` で、Pateat のカードの再読み込みボタンを押します。[保管庫のタイムアウト](./setup.md#vault-timeout)が **なし** でなければ、これで保管庫がロックされるので、設定ページでロックを解除してください。

**削除** は押さないでください。拡張機能を削除すると、保管庫の接続やサービスとのペアリングを含め、Chrome に保存したものがすべて消え、[初期設定](./setup.md)をやり直すことになります。また、削除しても Pateat サービス側のデバイスは取り消されません。デバイスの認証情報は、サービスで取り消すか、90 日使われずに期限が切れるまで有効です。

## ソースからビルドする {#build-from-source}

ビルドには [mise](https://mise.jdx.dev/) と Git が必要です。[リポジトリ](https://github.com/risu729/pateat)を clone したフォルダーで次を実行します。

```sh
mise install
mise run install
mise run //apps/extension:build
```

拡張機能は `apps/extension/.output/chrome-mv3/` に出力されます。上と同じように **パッケージ化されていない拡張機能を読み込む** でそのフォルダーを読み込みます。そのほかのツールは[開発ガイド](https://github.com/risu729/pateat/blob/main/docs/development.md)（英語）にあります。

## ソースコードとライセンス {#source-code-and-license}

Pateat 拡張機能は、GNU General Public License バージョン 3 のみ（GPL-3.0-only）のフリーソフトウェアです。公式の Bitwarden SDK を、その GPLv3 の選択肢で含んでいます。リリースには[対応するソースコード](https://github.com/risu729/pateat/blob/main/docs/sdk-source.md)（英語）が付きます。リリースしたコミットの Pateat のソースと、ビルドに使った Bitwarden SDK のソースそのものです。[ライセンスについて](https://github.com/risu729/pateat/blob/main/LICENSING.md)（英語）も参照してください。

## Chrome ウェブストア {#chrome-web-store}

ストアのポリシーが許せば、Pateat を Chrome ウェブストアでも公開するかもしれません。ストアのアイテムにはストアが割り当てる拡張機能 ID が付くので、パッケージ化されていない拡張機能からストア版に移るときは、初期設定とペアリングをやり直すことになります。
