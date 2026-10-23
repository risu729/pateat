import type { bitwardenEn } from "./bitwarden-en";

export const bitwardenJa = {
  "Bitwarden's sign-in and vault data did not agree{{check}}. Setup is incomplete; report this check name.":
    "Bitwarden のログイン情報と保管庫のデータが一致しませんでした{{check}}。設定は未完了です。この確認項目名を報告してください。",
  " (check: {{check}})": "（確認項目：{{check}}）",
  "Pateat does not have access to the Bitwarden server. Connect or sync again, and allow access when Chrome asks.":
    "Pateat には Bitwarden サーバーへのアクセス許可がありません。もう一度接続または同期し、Chrome で確認されたらアクセスを許可してください。",
  "Sign in again to sync. The saved local vault can still unlock independently.":
    "同期するには再ログインしてください。保存済みのローカル保管庫は、同期とは別に引き続きロックを解除できます。",
  "Automatic unlock is off for this connection, and Sync needs it. To turn it back on, sign in again with Enable automatic unlock on this device checked.":
    "この接続では自動ロック解除がオフのため、同期できません。オンに戻すには、「このデバイスで自動ロック解除を有効にする」を選択して再ログインしてください。",
  "The vault is locked. Refresh to check recovery options.":
    "保管庫がロックされています。復旧方法を確認するには、更新してください。",
  "The operation reached a resource limit. Refresh to check the current vault status before trying again.":
    "処理がリソースの上限に達しました。再試行する前に、更新して保管庫の現在の状態を確認してください。",
  "The vault is larger than Pateat's local copy can hold. Refresh to check the current vault status.":
    "保管庫が大きすぎて、Pateat のローカルコピーに保存できません。更新して保管庫の現在の状態を確認してください。",
  "Pateat could not confirm that the local vault copy was updated. Refresh and reload saved settings before using this vault.":
    "保管庫のローカルコピーが更新されたか確認できませんでした。この保管庫を使う前に、更新し、保存済みの設定を再読み込みしてください。",
  "This verification session expired. Start sign-in again.":
    "この確認セッションは期限切れです。ログインをやり直してください。",
  "This account uses an unsupported vault format. Setup is incomplete.":
    "このアカウントの保管庫形式には対応していません。設定は未完了です。",
  "Bitwarden's answer could not be accepted. Setup is incomplete.":
    "Bitwarden からの応答を受け付けられませんでした。設定は未完了です。",
  "Bitwarden did not accept this sign-in. Check the email and master password, then try again.":
    "Bitwarden がこのログインを受け付けませんでした。メールアドレスとマスターパスワードを確認して、もう一度お試しください。",
  "The Bitwarden sign-in expired. Sign in again to sync.":
    "Bitwarden のログインは期限切れです。同期するには再ログインしてください。",
  "The saved settings changed. Reload saved settings and review the current fields, then try again.":
    "保存済みの設定が変更されました。保存済みの設定を再読み込みし、現在のフィールドを確認してから、もう一度お試しください。",
  "The connection could not do this ({{code}}). Refresh, then try again.":
    "接続でこの操作を行えませんでした（{{code}}）。更新してから、もう一度お試しください。",
  "Local vault ready": "ローカル保管庫を利用できます",
  "Some items need their field settings reviewed before use.":
    "使用前にフィールド設定の確認が必要なアイテムがあります。",
  "Setup incomplete or vault locked": "設定が未完了か、保管庫がロックされています",
  "Vault unavailable": "保管庫を利用できません",
  "Sync sign-in saved on this device": "同期用のログイン情報はこのデバイスに保存されています",
  "Sync sign-in saved, renewed on the next sync":
    "同期用のログイン情報は保存済みです。次回の同期時に更新します",
  "Sign in again to sync": "同期するには再ログインしてください",
  "Not signed in for sync": "同期用のログインは行われていません",
  "Sync sign-in unavailable": "同期用のログイン情報を利用できません",
  "Vault synced {{time}}": "保管庫の同期日時：{{time}}",
  "at an unknown time": "日時不明",
  "Automatic unlock on": "自動ロック解除は有効です",
  "Automatic unlock off": "自動ロック解除は無効です",
  "Automatic unlock unknown": "自動ロック解除の状態は不明です",
  "Review changed fields in {{item}}": "{{item}} の変更されたフィールドを確認",
  "All current custom fields start excluded. Save this review before the item can be used; other saved exclusions stay in place.":
    "現在のカスタムフィールドはすべて除外された状態です。このアイテムを使う前に、確認結果を保存してください。ほかの保存済みの除外設定は保持されます。",
  "{{item}}: Review exclude {{field}} (field {{index}})":
    "{{item}}：{{field}}（フィールド {{index}}）の除外を確認",
  "Exclude {{field}} (field {{index}})": "{{field}}（フィールド {{index}}）を除外",
  "This item has no current custom fields. Saving this review explicitly removes its old custom-field exclusions.":
    "このアイテムには現在カスタムフィールドがありません。確認結果を保存すると、以前のカスタムフィールドの除外設定を明示的に削除します。",
  "{{item}}: Save reviewed field exclusions": "{{item}}：確認済みのフィールド除外設定を保存",
  "Save reviewed field exclusions": "確認済みのフィールド除外設定を保存",
  "Loading Bitwarden connections…": "Bitwarden の接続を読み込んでいます…",
  "Connections loaded. Add a vault or sign in again below.":
    "接続を読み込みました。以下から保管庫の追加または再ログインを行ってください。",
  "Pateat could not read the connection status. Refresh to try again.":
    "接続の状態を読み取れませんでした。もう一度試すには更新してください。",
  "Enter a two-step verification code.": "2 段階認証の確認コードを入力してください。",
  "The sign-in ended before the code was entered.": "コードを入力する前にログインが終了しました。",
  "The sign-in timed out waiting for the code.":
    "コードの入力を待つ間にログインが時間切れになりました。",
  "The sign-in ended early, by {{time}}, before its 5 minutes. This usually means Chrome stopped Pateat's background. Enter the master password to start again.":
    "5 分を待たずに、{{time}} までにログインが終了しました。多くの場合、Chrome が Pateat のバックグラウンドを停止したことが原因です。やり直すにはマスターパスワードを入力してください。",
  "The sign-in timed out at {{time}}: no code was entered within 5 minutes. Enter the master password to start again.":
    "5 分以内にコードが入力されなかったため、{{time}} にログインが時間切れになりました。やり直すにはマスターパスワードを入力してください。",
  "The sign-in reached its 5-minute end before it finished. Enter the master password to start again.":
    "ログインが完了する前に 5 分の期限に達しました。やり直すにはマスターパスワードを入力してください。",
  "The code was not accepted.": "コードが受け付けられませんでした。",
  "The code was not accepted: it is wrong or no longer valid. Enter the current code from the authenticator app.":
    "コードが受け付けられませんでした。コードが間違っているか、有効期限が切れています。認証アプリに表示されている現在のコードを入力してください。",
  "The code was not accepted: it is wrong or no longer valid. Enter the code from the latest email, or Resend code.":
    "コードが受け付けられませんでした。コードが間違っているか、有効期限が切れています。最新のメールのコードを入力するか、「コードを再送信」を押してください。",
  "The code was not accepted: it is wrong or no longer valid. Enter the code from the latest email.":
    "コードが受け付けられませんでした。コードが間違っているか、有効期限が切れています。最新のメールのコードを入力してください。",
  "Enter the code by {{time}}. After that the sign-in ends and needs the master password again.":
    "{{time}} までにコードを入力してください。それを過ぎるとログインが終了し、マスターパスワードの再入力が必要になります。",
  "Enter the new-device verification code from your email.":
    "メールで受信した新しいデバイスの確認コードを入力してください。",
  "Vault accepted. {{count}} item needs its field settings reviewed before use.":
    "保管庫を受け付けました。{{count}} 件のアイテムは使用前にフィールド設定の確認が必要です。",
  "Vault verified and copied to this device. Check the automatic unlock line below.":
    "保管庫を検証し、このデバイスにコピーしました。以下の自動ロック解除の行を確認してください。",
  "Setup is incomplete: Bitwarden asks for a step Pateat does not support ({{reason}}).":
    "設定は未完了です：Pateat が対応していない手順を Bitwarden が求めています（{{reason}}）。",
  "Setup cancelled.": "設定をキャンセルしました。",
  "Sync sign-in removed from this device. This does not sign out other sessions; the local vault still unlocks as before.":
    "同期用のログイン情報をこのデバイスから削除しました。ほかのセッションからはログアウトしません。ローカル保管庫のロック解除は引き続き利用できます。",
  "Connection deleted from this device, with its local vault copy, unlock key and sync sign-in. This does not sign out other sessions. Saved settings that referred to it now show it as unavailable.":
    "接続、ローカル保管庫のコピー、ロック解除キー、同期用のログイン情報をこのデバイスから削除しました。ほかのセッションからはログアウトしません。この接続を参照する保存済みの設定は、利用不可と表示されます。",
  "Automatic unlock is off. To turn it back on, sign in again with Enable automatic unlock on this device checked.":
    "自動ロック解除はオフです。オンに戻すには、「このデバイスで自動ロック解除を有効にする」を選択して再ログインしてください。",
  "Pateat could not confirm the result. Refresh, then reload saved settings.":
    "結果を確認できませんでした。更新してから、保存済みの設定を再読み込みしてください。",
  "Enter a name, a valid email and the master password. A self-hosted server address is an HTTPS address such as https://vault.example.com, or HTTP on localhost or 127.0.0.1, with no path, credentials, query or fragment.":
    "名前、有効なメールアドレス、マスターパスワードを入力してください。セルフホストのサーバーアドレスは https://vault.example.com のような HTTPS アドレス（localhost と 127.0.0.1 では HTTP も可）で、パス、認証情報、クエリ、フラグメントは含めません。",
  "Asking Chrome for access to the Bitwarden server, then connecting…":
    "Chrome に Bitwarden サーバーへのアクセス許可を求めてから、接続しています…",
  "Chrome did not grant access to the Bitwarden server, so nothing was sent.":
    "Chrome で Bitwarden サーバーへのアクセスが許可されなかったため、何も送信していません。",
  "Setup stopped. Refresh to see the current state.":
    "設定を停止しました。現在の状態を確認するには更新してください。",
  "Syncing {{name}}…": "{{name}} を同期しています…",
  "Chrome did not grant access to the Bitwarden server, so nothing was synced.":
    "Chrome で Bitwarden サーバーへのアクセスが許可されなかったため、同期していません。",
  "Enter the master password to sign in again. Automatic unlock stays as it is unless you check Enable automatic unlock on this device.":
    "再ログインするにはマスターパスワードを入力してください。「このデバイスで自動ロック解除を有効にする」を選択しない限り、自動ロック解除の設定は変わりません。",
  "Cancel setup": "設定をキャンセル",
  Bitwarden: "Bitwarden",
  "Stopped. Refresh to see the current state.":
    "停止しました。現在の状態を確認するには更新してください。",
  Cancel: "キャンセル",
  "Refresh connections": "接続を更新",
  "Connection status refreshed.": "接続の状態を更新しました。",
  Refresh: "更新",
  "{{email}} on {{server}}": "{{server}} の {{email}}",
  "{{name}}: {{action}}": "{{name}}：{{action}}",
  "Sign in again": "再ログイン",
  Sync: "同期",
  "More for {{name}}": "{{name}} のその他の操作",
  "{{name}}: Sync": "{{name}}：同期",
  "{{name}}: Sign in again": "{{name}}：再ログイン",
  "{{name}}: Turn off automatic unlock": "{{name}}：自動ロック解除をオフにする",
  "Turn off automatic unlock": "自動ロック解除をオフにする",
  "{{name}}: Forget sync sign-in": "{{name}}：同期用のログイン情報を削除",
  "Forget sync sign-in": "同期用のログイン情報を削除",
  "{{name}}: Delete connection": "{{name}}：接続を削除",
  "Delete connection": "接続を削除",
  "Connection kept.": "接続を維持しました。",
  "Delete {{name}}?": "{{name}} を削除しますか？",
  "This removes the connection, its local vault copy, unlock key and sync sign-in from this device. It does not sign out other sessions, and saved settings that refer to it will show it as unavailable.":
    "この接続、ローカル保管庫のコピー、ロック解除キー、同期用のログイン情報をこのデバイスから削除します。ほかのセッションからはログアウトしません。この接続を参照する保存済みの設定は、利用不可と表示されます。",
  "Keep connection": "接続を維持",
  "Review changed custom fields in {{name}}": "{{name}} の変更されたカスタムフィールドを確認",
  "Affected items stay unavailable until their field settings are reviewed; refreshing does not approve them.":
    "影響を受けるアイテムは、フィールド設定を確認するまで利用できません。更新しても承認は行われません。",
  "Reload saved settings to review the current fields. Your unsaved settings changes are kept until you reload.":
    "現在のフィールドを確認するには、保存済みの設定を再読み込みしてください。未保存の設定の変更は、再読み込みするまで保持されます。",
  "Reload saved settings to review the current fields.":
    "現在のフィールドを確認するには、保存済みの設定を再読み込みしてください。",
  "Manual verification": "手動での確認",
  "Verification method": "確認方法",
  "Authenticator code": "認証アプリのコード",
  "Email code": "メールのコード",
  "Verification code": "確認コード",
  "New-device verification code": "新しいデバイスの確認コード",
  "Verify code": "コードを確認",
  "Sign in to {{name}} again": "{{name}} に再ログイン",
  "Add a connection": "接続を追加",
  Server: "サーバー",
  "Bitwarden Cloud US": "Bitwarden クラウド（米国）",
  "Bitwarden Cloud EU": "Bitwarden クラウド（EU）",
  "Self-hosted": "セルフホスト",
  "Server address": "サーバーのアドレス",
  Name: "名前",
  Personal: "個人用",
  Email: "メールアドレス",
  "Master password": "マスターパスワード",
  "Enable automatic unlock on this device": "このデバイスで自動ロック解除を有効にする",
  "The master password and verification codes are not saved. An unlock key, an encrypted vault copy and a sync sign-in stay on this device.":
    "マスターパスワードと確認コードは保存しません。ロック解除キー、暗号化された保管庫のコピー、同期用のログイン情報はこのデバイスに保存されます。",
  "Chrome asks for access to {{hosts}}.": "Chrome が {{hosts}} へのアクセス許可を求めます。",
  "Enter an HTTPS server address, or HTTP on localhost or 127.0.0.1.":
    "HTTPS のサーバーのアドレスを入力してください（localhost と 127.0.0.1 では HTTP も可）。",
  "Sign in and sync": "ログインして同期",
  "Connect Bitwarden": "Bitwarden に接続",
  "More than 5 connections. The official Bitwarden extension allows up to 5 accounts, and each unlocked vault uses more memory.":
    "接続が 5 件を超えています。Bitwarden 公式の拡張機能は 5 アカウントまでで、ロックを解除した保管庫ごとにメモリを多く使います。",
  "Add another connection": "別の接続を追加",
  "{{count}} item": "{{count}} 件のアイテム",
  "{{count}} field": "{{count}} 個のフィールド",
  "{{vault}}: Use this vault": "{{vault}}：この保管庫を使う",
  "Use this vault": "この保管庫を使う",
  "Items for Pateat": "Pateat が使うアイテム",
  "{{vault}}: Items for Pateat": "{{vault}}：Pateat が使うアイテム",
  "All except exclusions": "除外設定以外のすべて",
  "Selected groups and items only": "選択したグループとアイテムのみ",
  "Included groups and items": "使うグループとアイテム",
  " selected": " 選択済み",
  "{{vault}}: Included groups and items": "{{vault}}：使うグループとアイテム",
  "{{groups}}, {{items}} selected": "選択中：{{groups}}、{{items}}",
  "{{selected}} of {{count}} group": "{{count}} 個のグループ中 {{selected}} 個",
  "{{selected}} of {{count}} item": "{{count}} 件のアイテム中 {{selected}} 件",
  "{{vault}}: Include group {{group}}": "{{vault}}：グループ {{group}} を使う",
  "Include group {{group}}": "グループ {{group}} を使う",
  "{{vault}}: Include item {{item}}": "{{vault}}：アイテム {{item}} を使う",
  "Include item {{item}}": "アイテム {{item}} を使う",
  "Excluded items and fields": "除外するアイテムとフィールド",
  " excluded": " 除外済み",
  "{{entries}} excluded": "除外：{{entries}}",
  " and ": "、",
  "Nothing excluded": "除外なし",
  "Item excluded": "アイテム全体を除外",
  "{{count}} field excluded": "{{count}} 個のフィールドを除外",
  "{{vault}}: Exclude item {{item}}": "{{vault}}：アイテム {{item}} を除外",
  "Exclude item {{item}}": "アイテム {{item}} を除外",
  "{{vault}}: Exclude {{field}} from {{item}}": "{{vault}}：{{item}} の {{field}} を除外",
  "Exclude {{field}} from {{item}}": "{{item}} の {{field}} を除外",
  "Unavailable connection": "利用できない接続",
  "{{id}}. Its saved settings are kept.": "{{id}}。保存済みの設定は保持されています。",
  "{{count}} item_one": "{{count}} 件のアイテム",
  "{{count}} item_other": "{{count}} 件のアイテム",
  "{{count}} field_one": "{{count}} 個のフィールド",
  "{{count}} field_other": "{{count}} 個のフィールド",
  "{{selected}} of {{count}} group_one": "{{count}} 個のグループ中 {{selected}} 個",
  "{{selected}} of {{count}} group_other": "{{count}} 個のグループ中 {{selected}} 個",
  "{{selected}} of {{count}} item_one": "{{count}} 件のアイテム中 {{selected}} 件",
  "{{selected}} of {{count}} item_other": "{{count}} 件のアイテム中 {{selected}} 件",
  "{{count}} field excluded_one": "{{count}} 個のフィールドを除外",
  "{{count}} field excluded_other": "{{count}} 個のフィールドを除外",
  "Vault accepted. {{count}} item needs its field settings reviewed before use._one":
    "保管庫を受け付けました。{{count}} 件のアイテムは使用前にフィールド設定の確認が必要です。",
  "Vault accepted. {{count}} item needs its field settings reviewed before use._other":
    "保管庫を受け付けました。{{count}} 件のアイテムは使用前にフィールド設定の確認が必要です。",
  "Asking the server to email a verification code…":
    "サーバーに確認コードのメール送信を依頼しています…",
  "The server sent a verification code to the account's two-step email.":
    "サーバーが、このアカウントの 2 段階認証用のメールアドレスに確認コードを送信しました。",
  "The server is limiting code emails. Wait a few minutes before resending.":
    "サーバーがコードのメール送信を制限しています。数分待ってから再送信してください。",
  "This server cannot send email codes. Use another method or a code you already received.":
    "このサーバーはコードをメールで送信できません。別の方法か、受信済みのコードを使ってください。",
  "The server did not send a code. Resend or use another method.":
    "サーバーはコードを送信しませんでした。再送信するか、別の方法を使ってください。",
  "The code email could not be requested. Resend to try again.":
    "コードのメール送信を依頼できませんでした。もう一度お試しいただくには、再送信してください。",
  "Loading stopped.": "読み込みを停止しました。",
  "Enter the master password to finish setting up this connection. Automatic unlock is turned on, as when adding it.":
    "この接続の設定を完了するには、マスターパスワードを入力してください。追加するときと同じく、自動ロック解除はオンになります。",
  "Resend code": "コードを再送信",
} satisfies Record<keyof typeof bitwardenEn, string>;
