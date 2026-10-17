# インストール

::: warning まだリリースされていません
Pateat のリリースはまだ公開されておらず、配布形式も決まっていません。
以下は、[GitHub Releases](https://github.com/risu729/pateat/releases) で配布する
ZIP ファイルを展開し、Chrome に読み込むことを想定した手順です。
それまでは[ソースからビルド](#ソースからビルドする)してください。
:::

## 必要なもの

- デスクトップ版 Google Chrome 144 以降。自分のコンピューターにインストールした Chrome
  を対象としています。他の Chromium ブラウザーやホスト型ブラウザーでは未確認です。
- Bitwarden Cloud（US または EU）、または HTTPS で接続できるセルフホスト版 Bitwarden の
  アカウント。これまでに確認したのは、Bitwarden Cloud US の 1 アカウントのみです。
- 設定とレシピを保存する、ペアリング先の Pateat サービス。
  インストール前に[サービスについて](./setup.md#pateat-サービスについて)を確認してください。

## リリースをインストールする

1. [GitHub Releases](https://github.com/risu729/pateat/releases) から Chrome 用の
   ZIP ファイルをダウンロードします。
2. ZIP をフォルダーに展開し、そのフォルダーを保管します。Chrome
   は起動のたびにその場所から
   拡張機能を読み込むので、移動したり削除したりしないでください。
3. `chrome://extensions` を開き、右上の **デベロッパーモード** を有効にします。
4. **パッケージ化されていない拡張機能を読み込む** を押し、展開したフォルダーのうち
   `manifest.json` があるフォルダーを選びます。
5. 拡張機能メニュー（パズルのピースのアイコン）で Pateat をツールバーに固定します。
   そのページで何をしたかが見えるようになります。

展開した拡張機能の読み込みでは、Chrome の通常の権限確認は表示されません。
読み込むとすぐに、Pateat はすべての HTTPS サイトへのアクセスを得ます。
用途と制限方法は[権限](./permissions.md)をご覧ください。

拡張機能 ID はマニフェスト内のキーで固定されるため、この形式でのリリース間では同じ ID と
Chrome 内のデータを引き継ぎます。

## 新しいリリースに更新する

1. 読み込んだフォルダーの中身を削除し、新しいリリースの ZIP
   を同じフォルダーに展開します。
2. `chrome://extensions` の Pateat のカードで、再読み込みボタンを押します。

**削除** は押さないでください。拡張機能を削除すると、保管庫への接続やサービスとの
ペアリングを含め、Chrome に保存したデータが消えます。[初期設定](./setup.md)をやり直す
必要があります。

## ソースからビルドする

ビルドには [mise](https://mise.jdx.dev/) と Git が必要です。
[リポジトリ](https://github.com/risu729/pateat)をクローンし、その中で実行します。

```sh
mise install
mise run install
mise run //apps/extension:build
```

出力先は `apps/extension/.output/chrome-mv3/` です。 上記の
**パッケージ化されていない拡張機能を読み込む** で、このフォルダーを選びます。
その他の開発ツールについては、[開発ガイド（英語）](https://github.com/risu729/pateat/blob/main/docs/development.md)をご覧ください。

## ソースコードとライセンス

Pateat 拡張機能は、GNU General Public License バージョン 3
のみを適用する自由ソフトウェアです。 公式 Bitwarden SDK を GPLv3
の選択肢で使用しています。リリースには、そのコミットの Pateat
ソースと、ビルドに使った正確な Bitwarden SDK のソースを含む
[対応するソース（英語）](https://github.com/risu729/pateat/blob/main/docs/sdk-source.md)が付属します。
[ライセンスの説明（英語）](https://github.com/risu729/pateat/blob/main/LICENSING.md)もご覧ください。

## Chrome ウェブストア

ストアのポリシーで認められれば、Chrome ウェブストアでも公開する予定です。
ストア版にはストアが割り当てる拡張機能 ID
が使われるため、展開して読み込んだ版から移る際は、
初期設定とペアリングをやり直す必要があります。
