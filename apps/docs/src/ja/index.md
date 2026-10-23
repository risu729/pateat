---
layout: home

hero:
  name: Pateat
  text: Chrome の自動ログイン
  tagline: この端末に保存した自分の Bitwarden 保管庫で、ウェブサイトにログインし、パスキーでのサインインに応答します。
  image:
    src: /icon.svg
    alt: Pateat
  actions:
    - theme: brand
      text: インストール
      link: /ja/installation
    - theme: alt
      text: 初期設定
      link: /ja/setup
    - theme: alt
      text: GitHub
      link: https://github.com/risu729/pateat

features:
  - title: 保管庫は端末から出ません
    details: Pateat は Bitwarden の保管庫を同期し、公式の Bitwarden SDK を使って拡張機能の中で復号します。TOTP のシークレットとパスキーの秘密鍵は拡張機能の外に出ず、パスワードは、そのアイテムを使うサイトのログインページにだけ入力されます。
  - title: ログインは記録ではなく手順で
    details: サイトごとに、入力やクリックといった決まった手順のレシピがあります。レシピは、ログインページを個人情報を除いて記述したものから AI が書きます。レシピに秘密の値は含まれません。
  - title: パスワード、TOTP、パスキー
    details: Pateat は、パスワード、カスタムフィールド、ワンタイムコード、カード番号などの個人情報を入力し、保管庫に保存したパスキーでサインインします。バックグラウンドのタブでも動きます。
---

::: warning まだリリースしていません
Pateat は開発中です。ダウンロードできるリリースはまだなく、一部は Bitwarden クラウドのアカウント 1 つでしか試していません。何を確認済みかは[実装計画](https://github.com/risu729/pateat/blob/main/docs/plan.md)（英語）にあります。
:::

## Pateat がすること {#what-pateat-does}

Pateat は、自分の [Bitwarden](https://bitwarden.com/) 保管庫にあるアカウントで、選んだサイトのログインフォームを完了させる Chrome 拡張機能です。今のところ対応しているのは Bitwarden だけです。

- 保管庫のアイテムに一致するログインページでは、そのサイトのレシピに従い、ユーザー名、パスワード、その他のフィールドを入力し、ワンタイムコードを入れ、ボタンを押して、ページを次々に進めます。暗号化されていない HTTP のページでは、`http://` のアドレスで保存したアイテムだけを使います（[権限](./permissions.md#plain-http-pages)）。
- サイトがパスキーを求めたときは、保管庫に保存したパスキーで応答できます。
- まだレシピのないサイトでは、ページを個人情報を除いて記述したもの（保管庫の値は含みません）を Pateat サービスに送り、Claude でレシピを書きます。Claude には、サービスの Claude の認証情報か、端末に保存した Anthropic API キーを使います。

設定とレシピは、拡張機能とペアリングした Pateat サービスに保存されます。拡張機能もその写しを持つので、サービスが止まっていてもログインは動きます。

## まだ完全には守られていない保護 {#protections-pateat-does-not-fully-honour-yet}

- **パスキーのユーザーの存在確認とユーザー検証。** Pateat はサイトのパスキー要求に、ユーザーの存在確認（UP）とユーザー検証（UV）のフラグを立てて応答しますが、自身では存在の確認も検証も行いません。この端末で保管庫のロックを解除していることと、そのサイトに選んだアカウントだけが承認の根拠です（[ADR 0007](https://github.com/risu729/pateat/blob/main/docs/adr/0007-existing-passkey-assertions.md#presence-and-verification)、英語）。公開前に設定項目にする予定です。
- **Bitwarden のマスターパスワードの再要求**は、指定したサイトでのみ（[初期設定](./setup.md#sites-that-ask-for-the-master-password)）、ログインアイテムとそのパスキーに対してだけ守ります。ほかのサイトや、リンクしたカードや個人情報のアイテムの値では、再要求が設定されたアイテムもマスターパスワードを尋ねずに使います。

## 次にすること {#next-steps}

1. 拡張機能を[インストール](./installation.md)します。
2. [初期設定](./setup.md)をします。Bitwarden に接続し、Pateat サービスとペアリングします。
3. [権限](./permissions.md)が何のためにあるかと、[プライバシーポリシー](./privacy.md)を読みます。
