import type { bindingReviewEn } from "./binding-review-en";
export const bindingReviewJa = {
  "Review vault fields": "保管庫のフィールドを確認",
  "A saved field of {{item}} no longer matches. Choose the field to use on {{hostname}}.":
    "{{item}} に保存されたフィールドが見つからないか、区別できなくなりました。{{hostname}} で使うフィールドを選んでください。",
  "Input {{number}}: {{name}}": "入力欄 {{number}}：{{name}}",
  "Choose a field": "フィールドを選択",
  "No allowed named field can fill this input. Check the item and its field exclusions in settings.":
    "この入力欄に使える、名前の付いたフィールドがありません。設定でアイテムとフィールドの除外を確認してください。",
  "Use these fields and retry": "このフィールドで再試行",
  "Only field names are shown. Nothing is saved if sign-in is rejected or cannot be confirmed.":
    "表示するのはフィールド名だけです。ログインが拒否された場合や、成功を確認できなかった場合は保存しません。",
  "Some vault items need their field exclusions reviewed before they can be used.":
    "使う前にフィールドの除外設定を確認する必要があるアイテムがあります。",
  "{{item}} — {{connection}}": "{{item}} — {{connection}}",
  "Review fields in settings": "設定でフィールドを確認",
  "Pateat is retrying this login. The repaired fields are saved only after sign-in succeeds.":
    "ログインを再試行しています。修正したフィールドはログインの成功後にだけ保存します。",
  "Choose a current allowed field for every input, then try again.":
    "すべての入力欄について、現在使用を許可されているフィールドを選び、再試行してください。",
  "The page, vault or settings changed. Reload the page to review its fields again.":
    "ページ、保管庫、または設定が変わりました。ページを再読み込みしてフィールドを確認してください。",
  "Pateat could not restart this login. No repaired fields were saved. Try again from the page.":
    "ログインを再開できませんでした。修正したフィールドは保存していません。ページから再試行してください。",
  "The field review could not be read. Try again.":
    "フィールドの確認内容を読み取れませんでした。再試行してください。",
} satisfies Record<keyof typeof bindingReviewEn, string>;
