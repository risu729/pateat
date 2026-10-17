# 初期設定 {#setup}

設定ページで、まず Bitwarden の保管庫に接続し、次に Pateat サービスとペアリングします。
設定ページは、ツールバーのポップアップにある **Open settings**（スライダーのアイコン）、
または `chrome://extensions` の Pateat のカードの **詳細** → **拡張機能のオプション**
から開けます。このページでは、操作する場所を探せるよう、Pateat
の画面内のラベルを英語で示します。

## Bitwarden に接続する {#connect-bitwarden}

1. **Add a connection** の **Server** で、**Bitwarden Cloud US**、
   **Bitwarden Cloud EU**、**Self-hosted HTTPS** のいずれかを選びます。
   セルフホストの場合は `https://vault.example.com` のようにアドレスを入力します。
2. **Name** に `Personal` などの接続名を付け、Bitwarden の **Email** と
   **Master password** を入力します。
3. **Use this connection** を有効にしたまま、**Connect Bitwarden** を押します。
4. Bitwarden が追加の確認を求めると、**Manual verification** フォームが表示されます。
   認証アプリのコード、すでに受信したメールのコード、または Bitwarden
   が新しい端末の確認用に送ったコードを入力し、**Verify code** を押します。Pateat
   からメールのコードの送信を依頼することはできません。他の 2
   段階ログイン方式には、まだ対応していません。

Pateat はブラウザーから Bitwarden サーバーに直接サインインし、保管庫を同期して、
公式 Bitwarden SDK で端末内で復号します。マスターパスワードや確認コードは保存しません。
この端末に残るのは次のデータです。

- 暗号化された保管庫のコピー。
- Chrome の再起動後もマスターパスワードを求めずに保管庫をロック解除するためのキー
  （自動ロック解除）。
- 後で保管庫を同期するための、同期用のサインイン情報。

ロック解除キーは Chrome の拡張機能用ストレージに保存され、OS
のキーストアで保護されません。 Chrome
プロファイルのファイルを読める人は、そのキーで保管庫のコピーを復号できます。
望まない場合は、接続のメニューで **Disable automatic unlock** を選んでください。
保管庫の使用にも同期にもキーが必要なため、同期用のサインイン情報も消去し、接続の動作を直ちに
停止します。再開するには、**Enable automatic unlock on this device** を選択して
サインインし直してください。

接続は 1 行ずつ表示されます。主な操作は **Sync**、再サインインが必要な場合は
**Sign in again** です。メニューの **Forget sync sign-in** では同期用のサインイン情報を
消去できます。**Delete connection** を選んで **Confirm delete** を押すと、その接続と
保管庫のコピー、ロック解除キー、同期用のサインイン情報をこの端末から削除します。
どちらの操作も、他の Bitwarden セッションからはサインアウトしません。
個人用と仕事用など、複数の接続を追加できます。

### Pateat が使えるアイテムを選ぶ {#choose-what-pateat-may-use}

各接続の行で、Pateat が使える範囲も指定します。

- **Use this vault** で、その保管庫全体を Pateat が使うかどうかを切り替えます。
- **Items for Pateat** は、**All except exclusions**（除外したもの以外のすべて）か、
  **Selected groups and items only**（選んだグループとアイテムのみ）を選べます。
- **Excluded items and fields**
  には、使わせないアイテムや入力させないフィールドを指定します。
  除外は、グループやアイテムの選択より優先されます。

除外したカスタムフィールドが変更され、どのフィールドの除外だったか判別できなくなると、
このページでフィールドを確認するまで、そのアイテムの使用を保留します。

これらの制限は Pateat にだけ適用され、Bitwarden 内のデータは変更しません。

## Pateat サービスとペアリングする {#pair-with-a-pateat-service}

1. **Sync service** の **Service address** に `https://pateat.example.com` のような
   サービスのアドレスを入力します。**Device name**
   には、サービスの端末一覧に表示する名前を入力します。
2. **Pair this device** を押します。
3. サービスにまだサインインしていない場合は、新しいタブにサインインページが開きます。
   そこでサインインして設定ページに戻ると、自動で再試行します。
   **Try again** と **Open sign-in page** でも、それぞれの操作をやり直せます。

成功すると **This device is paired.** と表示されます。
設定とレシピをサービスから同期し、この端末にもコピーを保持します。

サービスは端末ごとに専用の認証情報を発行します。拡張機能はこれを自分のストレージに保存し、
ペアリングしたサービスにだけ送ります。90 日間使わないと期限切れになります。設定ページの
**Disconnect this device**、またはサービスの **Devices** ページから
接続を取り消せます。コンピューターを紛失した場合などに使います。

### Pateat サービスについて {#the-pateat-service}

サービスは Cloudflare Access で保護された小さな Cloudflare Worker です。
設定、サイトごとの既定のアカウント、レシピを保存し、レシピのないログインページについて
Claude に作成を依頼します。保管庫の値やキーは受け取りません。

現在は、各自が自分用のサービスを運用する形です。`pateat.takuk.me`
は開発者自身のサービスで、
他の人には開放していません。サービスは運用者が指定した拡張機能 ID からのペアリングだけを
受け付けます。自分で運用する場合は Pateat の ID、独自のキーでビルドする場合はその ID を
登録します。どちらも[開発ガイド（英語）](https://github.com/risu729/pateat/blob/main/docs/development.md#extension-id)に説明があります。
サービスを使わないモードは、今後の予定です。

## Pateat を使う {#using-pateat}

両方の設定が終わったら、保管庫にアイテムがあるサイトのログインページを開きます。
そのページ用のレシピがあれば、Pateat がログインします。なければ、機密情報を取り除いた
ページの説明をサービスに送り、Claude に作成を依頼します。
これには、サービス側で Claude の認証情報を設定しておく必要があります。

ツールバーのポップアップには、現在のページで何をしたかが表示されます。
複数のアカウントが一致する場合はログインするアカウントを選べます。
**Pateat on this site** を無効にすると、そのサイトで Pateat を停止できます。サービスの
**Sites** ページには、レシピ、既定のアカウント、除外設定のあるサイトが一覧表示されます。
