export const ssoJa = {
  Continue: "続ける",
  Passkey: "パスキー",
  "Remove provider mapping": "ID プロバイダーの対応付けを削除",
  "Remove provider mapping for {{method}}": "{{method}} の ID プロバイダーの対応付けを削除",
  "Save provider mapping": "ID プロバイダーの対応付けを保存",
  "Save provider mapping for {{method}}": "{{method}} の ID プロバイダーの対応付けを保存",
  "Show other provider accounts": "ほかの ID プロバイダーのアカウントを表示",
  "Show other provider accounts for {{method}}":
    "{{method}} で使えるほかの ID プロバイダーのアカウントを表示",
  "SSO field: {{field}}. ": "フィールド「{{field}}」：",
  "Sign-in method": "ログイン方法",
  "Choose how to sign in as {{account}}.": "{{account}} でログインする方法を選んでください。",
  "Method for this sign-in": "今回のログイン方法",
  "Choose a method": "方法を選択",
  "SSO with {{provider}}": "{{provider}} で SSO",
  "SSO with the saved identity provider": "保存した ID プロバイダーで SSO",
  " (automatic)": "（自動）",
  "Saved identity provider": "保存した ID プロバイダー",
  "Saved account and sign-in origin": "保存したアカウントとログイン先",
  "Choose a saved provider account": "ID プロバイダーのアカウントを選択",
  "No eligible provider account and origin matches this method. Check the vault and sync it.":
    "この方法に使える ID プロバイダーのアカウントとログイン先がありません。保管庫を確認して同期してください。",
  "Entry shown on this page": "このページのログインボタン",
  "Choose the provider entry": "ID プロバイダーのボタンを選択",
  "Provider mappings sync with your settings. This method choice applies only to this sign-in.":
    "ID プロバイダーの対応付けは設定として同期されます。選んだ方法は今回のログインにだけ使います。",
  "Two methods name the same provider account. Choose distinct accounts before continuing.":
    "2 つの方法が同じ ID プロバイダーのアカウントを指しています。続けるには、別々のアカウントを選んでください。",
  "Choose and save a provider account and sign-in origin for this method.":
    "この方法で使う ID プロバイダーのアカウントとログイン先を選んで保存してください。",
  "The saved provider account is no longer in an open vault. Choose another one, or unlock or sync the vault.":
    "保存した ID プロバイダーのアカウントが、開いている保管庫に見つかりません。別のアカウントを選ぶか、保管庫のロックを解除するか同期してください。",
  "Your settings hold as many provider mappings as they can. Remove one first.":
    "設定に保存できる ID プロバイダーの対応付けが上限に達しています。先に 1 つ削除してください。",
  "Pateat could not save the provider mapping to your settings. Try again.":
    "ID プロバイダーの対応付けを設定に保存できませんでした。もう一度お試しください。",
  "Too many provider accounts match this method. Remove unused items, or allow fewer items in settings, and sync the vault.":
    "この方法に一致する ID プロバイダーのアカウントが多すぎます。使わないアイテムを削除するか、設定で使うアイテムを絞ってから、保管庫を同期してください。",
  "Choose the provider entry displayed on this page.":
    "このページに表示されている ID プロバイダーのボタンを選んでください。",
  "The provider entry on this page changed. Choose it again.":
    "このページの ID プロバイダーのボタンが変わりました。もう一度選んでください。",
  "The SSO fields have invalid syntax, duplicate methods or mixed formats. Correct the vault item and sync it.":
    "SSO フィールドの書式が正しくないか、同じ方法が重複しているか、2 つの書式が混在しています。保管庫のアイテムを修正して同期してください。",
  "An SSO field must be a Text or Hidden field. Correct the vault item and sync it.":
    "SSO フィールドの種類は「テキスト」か「非表示」にしてください。保管庫のアイテムを修正して同期してください。",
  "The vault item has more than 32 SSO fields. Remove some and sync it.":
    "保管庫のアイテムに SSO フィールドが 32 個より多くあります。いくつか削除して同期してください。",
  "An SSO field that holds an address is only for an item without a password. Write it as [Provider] username instead, or remove the password, and sync it.":
    "アドレスを書いた SSO フィールドは、パスワードのないアイテムでだけ使えます。代わりに [プロバイダー] ユーザー名 の形で書くか、パスワードを削除してから同期してください。",
  "A vault item this method needs has no username. Add one and sync the vault.":
    "この方法に必要な保管庫のアイテムにユーザー名がありません。ユーザー名を追加して保管庫を同期してください。",
  "Pateat could not read every custom field of a vault item this method needs. Sync the vault and try again.":
    "この方法に必要な保管庫のアイテムのカスタムフィールドを、すべては読み取れませんでした。保管庫を同期してから、もう一度お試しください。",
  "A vault item this method needs is unavailable. Sync the vault and try again.":
    "この方法に必要な保管庫のアイテムを使えません。保管庫を同期してから、もう一度お試しください。",
  "The provider account's URI match rules cannot be read. Use a Domain, Host, Starts with or Exact rule for its sign-in address, and sync the vault.":
    "ID プロバイダーのアカウントの URI 一致検出を読み取れません。ログイン先のアドレスには「ベースドメイン」「ホスト」「前方一致」「完全一致」のいずれかを使い、保管庫を同期してください。",
  "Review the vault item's custom fields in settings first.":
    "先に設定ページで保管庫のアイテムのカスタムフィールドを確認してください。",
  "The saved provider account signs in through another provider itself, so it cannot be one. Choose another account.":
    "保存した ID プロバイダーのアカウント自体がほかの ID プロバイダーでログインするため、ID プロバイダーには使えません。別のアカウントを選んでください。",
  "An identity provider must use a different account and origin from this site.":
    "ID プロバイダーには、このサイトとは別のアカウントとログイン先を選んでください。",
  "This sign-in method is unavailable or changed. Check the vault and reopen the choice.":
    "このログイン方法は使えなくなったか、変更されました。保管庫を確認してから、もう一度選んでください。",
} as const;
