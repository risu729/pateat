import type { serviceEn } from "./service-en";

export const serviceJa = {
  "the service": "サービス",
  "at an unknown time": "日時不明",
  "Sync service": "同期サービス",
  "Pateat could not read or save its service connection on this device.":
    "このデバイスでサービスへの接続情報を読み取るか保存できませんでした。",
  "Pateat cannot read its saved service connection. Forget it here, then revoke the old device on the service's management page if it was paired.":
    "保存したサービスへの接続情報を読み取れません。ここで接続情報を削除し、ペアリング済みの場合はサービスの管理ページで以前のデバイスを無効にしてください。",
  "Chrome does not let Pateat reach this service. Allow site access when Chrome asks, or in Pateat's site access settings in Chrome.":
    "Chrome により Pateat からサービスへのアクセスが制限されています。Chrome の確認画面か、Chrome での Pateat のサイトへのアクセス設定で許可してください。",
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
  "The service could not check your sign-in. Try again later.":
    "サービスでログインを確認できませんでした。しばらくしてから、もう一度お試しください。",
  "The connection changed elsewhere. This page now shows its current state.":
    "別の場所で接続が変更されました。このページに最新の状態を表示しています。",
  "That request was not valid.": "リクエストが無効です。",
  "Pateat did not answer. Reload this page to try again.":
    "Pateat から応答がありません。このページを再読み込みして、もう一度お試しください。",
  "This device is paired.": "このデバイスをペアリングしました。",
  "Sign in to {{origin}} in the new tab, then come back here. If the service refuses your account, ask its operator.":
    "新しいタブで {{origin}} にログインし、完了後にここへ戻ってください。アカウントが拒否される場合は、サービスの管理者にお問い合わせください。",
  "Saved connection forgotten.": "保存した接続情報を削除しました。",
  "Forget saved connection": "保存した接続情報を削除",
  "Enter an HTTPS address such as https://pateat.example.com.":
    "https://pateat.example.com のような HTTPS アドレスを入力してください。",
  "Use a device name of up to 64 characters without control characters, line breaks or text-direction marks.":
    "デバイス名は制御文字、改行、文字の向きを変える記号を含まない 64 文字以内で入力してください。",
  "Enter a device name.": "デバイス名を入力してください。",
  "Service address": "サービスのアドレス",
  "Device name": "デバイス名",
  "Syncs recipes, site exclusions, default accounts and account bindings. Never sends vault values, passwords or keys.":
    "レシピ、除外サイト、既定のアカウントとフィールドの対応付けを同期します。保管庫の値、パスワード、鍵は送信しません。",
  "Pair this device": "このデバイスをペアリング",
  "Try again": "再試行",
  "Open sign-in page": "ログインページを開く",
  Paired: "ペアリング済み",
  "Named {{label}} on the service": "サービスでのデバイス名：{{label}}",
  "The service no longer accepts this device. Logins keep using the recipes synced before; disconnect and pair again to sync.":
    "このデバイスはサービスで無効になっています。ログインには以前同期したレシピを引き続き使用します。同期を再開するには、接続を解除してペアリングし直してください。",
  "Your recipes or settings no longer fit on this device, so newer changes are not applied. Logins keep using what was synced before.":
    "レシピまたは設定がこのデバイスの保存容量を超えたため、新しい変更は適用されていません。ログインには以前同期した内容を引き続き使用します。",
  "Recipes and settings not synced yet": "レシピと設定はまだ同期されていません",
  "Recipes and settings synced {{time}}": "レシピと設定の同期日時：{{time}}",
  "Disconnected on this device, but the service could not confirm it. Revoke this device from {{url}} in a browser that can open it.":
    "このデバイスの接続を解除しましたが、サービスでの解除を確認できませんでした。{{url}} を開けるブラウザーで、このデバイスを無効にしてください。",
  "Disconnected. The service no longer accepts this device.":
    "接続を解除しました。このデバイスはサービスで無効になりました。",
  "Disconnect this device": "このデバイスの接続を解除",
  "This account already has settings. Choose which profile this device uses, then pair.":
    "このアカウントにはすでに設定があります。このデバイスで使うプロファイルを選んでから、ペアリングしてください。",
  "That profile was deleted. Choose another one, then pair.":
    "そのプロファイルは削除されています。別のプロファイルを選んでから、ペアリングしてください。",
  "Another profile already has that name. Choose that profile or another name.":
    "同じ名前のプロファイルがすでにあります。そのプロファイルを選ぶか、別の名前にしてください。",
  "Choose a profile for this device.": "このデバイスで使うプロファイルを選んでください。",
  "Use a profile name of up to 64 characters without control characters.":
    "プロファイル名は制御文字を含まない 64 文字以内で入力してください。",
  "Enter a name for the new profile.": "新しいプロファイルの名前を入力してください。",
  "Settings profile": "設定プロファイル",
  "A profile holds site exclusions, sites that ask for the master password and saved accounts. Devices that share one share them; account bindings are shared by every profile.":
    "プロファイルには除外サイト、マスターパスワードを求めるサイト、保存したアカウントが入っています。同じプロファイルを使うデバイスどうしで共有されます。フィールドの対応付けはすべてのプロファイルで共通です。",
  "New profile with this device's site settings":
    "このデバイスのサイト設定で新しいプロファイルを作成",
  "New profile name": "新しいプロファイルの名前",
  "Replace this device's site settings with {{profile}}'s?":
    "このデバイスのサイト設定を {{profile}} の設定に置き換えますか？",
  "This device's site exclusions, sites that ask for the master password and saved accounts are removed and {{profile}}'s are used instead. Account bindings are kept.":
    "このデバイスの除外サイト、マスターパスワードを求めるサイト、保存したアカウントは削除され、代わりに {{profile}} の設定を使います。フィールドの対応付けは残ります。",
  "This device's site exclusions ({{exclusions}}) and saved accounts ({{defaults}}) are removed and {{profile}}'s are used instead. Account bindings are kept.":
    "このデバイスの除外サイト（{{exclusions}} 件）と保存したアカウント（{{defaults}} 件）は削除され、代わりに {{profile}} の設定を使います。フィールドの対応付けは残ります。",
  "To keep them, create a new profile from this device instead.":
    "残したい場合は、代わりにこのデバイスの設定で新しいプロファイルを作成してください。",
  "Pair and replace": "置き換えてペアリング",
  "Create a new profile instead": "代わりに新しいプロファイルを作成",
  Back: "戻る",
  "Sign in to the service first: open the sign-in page, then load the profiles again. Editing profiles needs the same sign-in as the service's management page.":
    "先にサービスにログインしてください。ログインページを開いてから、もう一度プロファイルを読み込んでください。プロファイルの編集には、サービスの管理ページと同じログインが必要です。",
  "The service did not accept your sign-in. Editing profiles needs a browser that can open the service's management page.":
    "サービスがログインを受け付けませんでした。プロファイルの編集には、サービスの管理ページを開けるブラウザーが必要です。",
  "Settings changed elsewhere. Reload this profile before saving again.":
    "別の場所で設定が変更されました。このプロファイルを再読み込みしてから、もう一度保存してください。",
  "That profile was deleted. Load the profiles again.":
    "そのプロファイルは削除されています。もう一度プロファイルを読み込んでください。",
  "The service could not be reached. Try again later.":
    "サービスに接続できませんでした。しばらくしてから、もう一度お試しください。",
  "The service gave an unexpected answer. Try again later.":
    "サービスから想定外の応答がありました。しばらくしてから、もう一度お試しください。",
  "Profile access failed.": "プロファイルを読み書きできませんでした。",
  "Edit a settings profile": "設定プロファイルの編集",
  "Change another profile's site exclusions, sites that ask for the master password and saved accounts from here. Account names come from this browser's vaults. Saving does not change which profile this device uses, and account bindings stay shared by every profile.":
    "ほかのプロファイルの除外サイト、マスターパスワードを求めるサイト、保存したアカウントを、ここで変更できます。アカウント名はこのブラウザーの保管庫から表示します。保存しても、このデバイスが使うプロファイルは変わりません。フィールドの対応付けはすべてのプロファイルで共通のままです。",
  "Load profiles": "プロファイルを読み込む",
  "Profile to edit": "編集するプロファイル",
  "Choose a profile": "プロファイルを選択",
  "Profile saved. Devices use it after their next settings sync.":
    "プロファイルを保存しました。各デバイスには次回の設定の同期で反映されます。",
  "Save profile": "プロファイルを保存",
  "Reload profile": "プロファイルを再読み込み",
  "The recipes could not be kept on this device, so it is still paired. Disconnect and delete them, or try again.":
    "レシピをこのデバイスに残せなかったため、接続したままです。削除して接続を解除するか、もう一度試してください。",
  "Keep the synced recipes on this device?": "同期したレシピをこのデバイスに残しますか?",
  "Kept recipes stay this device's own, so logins go on without the service, and a service paired later receives them once. Settings stay on this device either way.":
    "残したレシピはこのデバイスのものになり、サービスなしでもログインに使われます。後でペアリングしたサービスには 1 回だけ送られます。設定はどちらでもこのデバイスに残ります。",
  "Disconnect and keep recipes": "レシピを残して接続を解除",
  "Disconnect and delete recipes": "レシピを削除して接続を解除",
  "The recipes kept on this device cannot be read. Delete them to start again.":
    "このデバイスに残したレシピを読み込めません。削除してやり直してください。",
  keptRecipes_one:
    "このデバイスに {{count}} 件のレシピがあります。サービスなしでもログインに使われ、後でペアリングしたサービスには 1 回だけ送られます。",
  keptRecipes_other:
    "このデバイスに {{count}} 件のレシピがあります。サービスなしでもログインに使われ、後でペアリングしたサービスには 1 回だけ送られます。",
  keptRecipes:
    "このデバイスに {{count}} 件のレシピがあります。サービスなしでもログインに使われ、後でペアリングしたサービスには 1 回だけ送られます。",
  "Delete recipes on this device": "このデバイスのレシピを削除",
  "The recipes kept on this device were deleted.": "このデバイスに残したレシピを削除しました。",
} satisfies Record<keyof typeof serviceEn, string>;
