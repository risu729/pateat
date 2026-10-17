---
layout: home

hero:
  name: Pateat
  text: Chrome で自動ログイン
  tagline:
    この端末に保存した Bitwarden の保管庫を使って、ウェブサイトへのログインや
    パスキーでのサインインを自動で行います。
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
  - title: 保管庫は端末の中に
    details:
      Bitwarden の保管庫を同期し、公式 SDK を使って拡張機能内で復号します。
      TOTP のシークレットやパスキーの秘密鍵を外部に送ることはありません。
      パスワードは、そのアイテムを使うサイトのログインページにだけ入力します。
  - title: 操作の記録ではなく、手順を作成
    details:
      入力やクリックなどの決まった操作を「レシピ」としてサイトごとに保存します。
      AI は機密情報を取り除いたログインページの説明からレシピを作成します。
      レシピに認証情報は含まれません。
  - title: パスワード、TOTP、パスキーに対応
    details:
      パスワードやカスタムフィールド、ワンタイムコードを入力し、保管庫内のパスキーで
      サインインします。バックグラウンドのタブでも動作します。
---

::: warning まだリリースされていません
Pateat は開発中です。ダウンロードできるリリースはまだありません。
一部の機能は、1 つの Bitwarden アカウントでしか確認されていません。
確認済みの範囲は[実装計画（英語）](https://github.com/risu729/pateat/blob/main/docs/plan.md)をご覧ください。
:::

## Pateat でできること

Pateat は、自分の [Bitwarden](https://bitwarden.com/) の保管庫にあるアカウントで、
選んだサイトへのログインを自動で行う Chrome 拡張機能です。現在対応している保管庫は
Bitwarden のみです。

- 保管庫のアイテムに一致する HTTPS のログインページで、サイトのレシピに従って操作します。
  ユーザー名やパスワードなどを入力し、ワンタイムコードを入力し、必要なボタンを押して、
  複数ページにわたるログインを進めます。
- サイトがパスキーを要求すると、保管庫にあるパスキーで応答できます。
- レシピがまだないサイトでは、ページの説明から機密情報を取り除いて Pateat サービスへ送り、
  サービスが Claude にレシピの作成を依頼します。保管庫の値を送ることはありません。

設定とレシピは、拡張機能とペアリングした Pateat サービスに保存されます。
拡張機能もコピーを保持するので、サービスがオフラインでもログインを続けられます。

## まだ尊重していない 2 つの保護機能

- **パスキーのユーザーの存在確認とユーザー検証。** サイトのパスキー要求に応答する際、
  Pateat 自体は存在確認やユーザー検証を行わずに、ユーザーの存在（UP）とユーザー検証（UV）の
  フラグを立てます。この端末で保管庫がアンロックされていることと、サイト用に選んだ
  アカウントだけを認可の根拠としています
  （[ADR 0007・英語](https://github.com/risu729/pateat/blob/main/docs/adr/0007-existing-passkey-assertions.md#presence-and-verification)）。
- **Bitwarden のマスターパスワードの再入力。** 再入力が必要に設定されたアイテムでも、
  マスターパスワードを求めずに入力やパスキー署名を行います。

どちらも、一般公開までに設定で選べるようにする予定です。

## 次に進む

1. 拡張機能を[インストール](./installation.md)します。
2. [初期設定](./setup.md)で Bitwarden に接続し、Pateat サービスとペアリングします。
3. [権限](./permissions.md)の用途と[プライバシーポリシー](./privacy.md)を確認します。
