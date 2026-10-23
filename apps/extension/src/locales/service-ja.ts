import type { serviceEn } from "./service-en";

export const serviceJa = {
  "the service": "サービス",
  "at an unknown time": "日時不明",
  "Sync service": "同期サービス",
  "Pateat could not read or save its service connection on this device.":
    "この端末でサービスへの接続情報を読み取るか保存できませんでした。",
  "Pateat cannot read its saved service connection. Forget it here, then revoke the old device on the service's management page if it was paired.":
    "保存したサービスへの接続情報を読み取れません。ここで接続情報を削除し、ペアリング済みの場合はサービスの管理ページで以前の端末を無効にしてください。",
  "Chrome is not letting Pateat reach this service. Allow site access when Chrome asks, or in the extension's site access settings.":
    "Chrome によりサービスへのアクセスが制限されています。Chrome の確認画面か拡張機能のサイトへのアクセス設定で許可してください。",
  "The service could not be reached. Check the address, then try again.":
    "サービスに接続できませんでした。アドレスを確認し、もう一度お試しください。",
  "The service asked Pateat to slow down. Wait a minute, then try again.":
    "サービスのリクエスト制限に達しました。1 分ほど待ってから、もう一度お試しください。",
  "The service gave an unexpected answer. Check the address, then try again.":
    "サービスから予期しない応答がありました。アドレスを確認し、もう一度お試しください。",
  "Sign in to {{origin}} first: open the sign-in page, then come back here. If the service refuses your account, ask its operator.":
    "先に {{origin}} にログインしてください。ログインページを開き、完了後にここへ戻ってください。アカウントが拒否される場合は、サービスの管理者にお問い合わせください。",
  "The service did not accept your sign-in.": "サービスへのログインが拒否されました。",
  "This service does not accept this build of Pateat. Its operator must add this extension's ID to PAIRING_EXTENSION_IDS.":
    "この Pateat のビルドはサービスで許可されていません。サービスの管理者が PAIRING_EXTENSION_IDS にこの拡張機能の ID を追加する必要があります。",
  "Pairing is not configured on this service.": "このサービスではペアリングが設定されていません。",
  "The connection changed elsewhere. This page now shows its current state.":
    "別の場所で接続が変更されました。このページに最新の状態を表示しています。",
  "That request was not valid.": "リクエストが無効です。",
  "The extension did not answer. Reload this page to retry.":
    "拡張機能から応答がありません。このページを再読み込みしてお試しください。",
  "This device is paired.": "この端末をペアリングしました。",
  "Sign in to {{origin}} in the new tab, then come back here. If the service refuses your account, ask its operator.":
    "新しいタブで {{origin}} にログインし、完了後にここへ戻ってください。アカウントが拒否される場合は、サービスの管理者にお問い合わせください。",
  "Saved connection forgotten.": "保存した接続情報を削除しました。",
  "Forget saved connection": "保存した接続情報を削除",
  "Enter an HTTPS address such as https://pateat.example.com.":
    "https://pateat.example.com のような HTTPS アドレスを入力してください。",
  "Use a device name of up to 64 characters without control characters.":
    "端末名は制御文字を含まない 64 文字以内で入力してください。",
  "Enter a device name.": "端末名を入力してください。",
  "Service address": "サービスのアドレス",
  "Device name": "端末名",
  "Syncs recipes, site exclusions, saved accounts and account bindings. Never sends vault values, passwords or keys.":
    "レシピ、除外サイト、保存したアカウントとフィールドの対応付けを同期します。保管庫の値、パスワード、鍵は送信しません。",
  "Pair this device": "この端末をペアリング",
  "Try again": "再試行",
  "Open sign-in page": "ログインページを開く",
  Paired: "ペアリング済み",
  "Named {{label}} on the service": "サービスでの端末名: {{label}}",
  "The service no longer accepts this device. Login keeps using the recipes synced before; disconnect and pair again to sync.":
    "この端末はサービスで無効になっています。ログインには以前同期したレシピを引き続き使用します。同期を再開するには、接続を解除してペアリングし直してください。",
  "Your recipes or settings no longer fit, so newer changes are not applied. Login keeps using what was synced before.":
    "レシピまたは設定が保存容量を超えたため、新しい変更は適用されていません。ログインには以前同期した内容を引き続き使用します。",
  "Recipes and settings have not finished syncing yet": "レシピと設定の同期はまだ完了していません",
  "Recipes and settings synced {{time}}": "レシピと設定の同期日時: {{time}}",
  "Disconnected on this device, but the service could not confirm it. Revoke this device from {{url}} in a browser that can open it.":
    "この端末の接続を解除しましたが、サービスでの解除を確認できませんでした。{{url}} を開けるブラウザーで、この端末を無効にしてください。",
  "Disconnected. The service no longer accepts this device.":
    "接続を解除しました。この端末はサービスで無効になりました。",
  "Disconnect this device": "この端末の接続を解除",
} satisfies Record<keyof typeof serviceEn, string>;
