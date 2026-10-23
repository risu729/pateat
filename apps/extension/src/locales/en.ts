import { bitwardenEn } from "./bitwarden-en";
import { diagnosticsEn } from "./diagnostics-en";
import { serviceEn } from "./service-en";
import { settingsEn } from "./settings-en";
export const en = {
  ...bitwardenEn,
  ...settingsEn,
  ...diagnosticsEn,
  ...serviceEn,
  Language: "Language",
  "Browser setting": "Browser setting",
  Pateat: "Pateat",
  "Pateat passkey sign-in": "Pateat passkey sign-in",
  "Passkey request ended": "Passkey request ended",
  "The site stopped waiting, or Pateat restarted. Close this window and try again.":
    "The site stopped waiting, or Pateat restarted. Close this window and try again.",
  Close: "Close",
  "Log in to {{host}}": "Log in to {{host}}",
  "You were logged out of this site in this tab.": "You were logged out of this site in this tab.",
  "Pateat answered a passkey request from this site in this tab before.":
    "Pateat answered a passkey request from this site in this tab before.",
  "Replace the default account for {{host}} with this one":
    "Replace the default account for {{host}} with this one",
  "Use this account for {{host}} from now on": "Use this account for {{host}} from now on",
  "Matching passkeys": "Matching passkeys",
  "{{item}} in {{account}}": "{{item}} in {{account}}",
  "Unnamed item": "Unnamed item",
  Default: "Default",
  "Use the browser or another extension": "Use the browser or another extension",
  "Pateat on this site": "Pateat on this site",
  "{{item}}, ID {{id}}": "{{item}}, ID {{id}}",
  "Saving…": "Saving…",
  "The settings changed elsewhere, so this change was not saved. The popup now shows them.":
    "The settings changed elsewhere, so this change was not saved. The popup now shows them.",
  "The change could not be saved. Reopen this popup and try again.":
    "The change could not be saved. Reopen this popup and try again.",
  "The change may not have been saved. Reopen this popup to see the saved settings.":
    "The change may not have been saved. Reopen this popup to see the saved settings.",
  "Starting the login…": "Starting the login…",
  "Logging in with {{name}}. It becomes the default once the login succeeds.":
    "Logging in with {{name}}. It becomes the default once the login succeeds.",
  "Logging in with {{name}}.": "Logging in with {{name}}.",
  "The page changed, so nothing was started. Reload it to choose again.":
    "The page changed, so nothing was started. Reload it to choose again.",
  "Another tab's login to this site is running or did not succeed, so Pateat did not log in here. Close that tab, or wait up to 10 minutes, then choose again.":
    "Another tab's login to this site is running or did not succeed, so Pateat did not log in here. Close that tab, or wait up to 10 minutes, then choose again.",
  "Pateat could not log in with {{name}} on this page. Reload the page to choose again.":
    "Pateat could not log in with {{name}} on this page. Reload the page to choose again.",
  "This page no longer waits for an account choice.":
    "This page no longer waits for an account choice.",
  "The login could not be started. Reopen this popup and try again.":
    "The login could not be started. Reopen this popup and try again.",
  "Loading…": "Loading…",
  "Pateat works on websites (HTTP and HTTPS). Open a website, then click the Pateat icon again.":
    "Pateat works on websites (HTTP and HTTPS). Open a website, then click the Pateat icon again.",
  "Pateat cannot read this tab's address. It works on websites it has site access to; a page that is still loading shows this too.":
    "Pateat cannot read this tab's address. It works on websites it has site access to; a page that is still loading shows this too.",
  "Pateat's settings could not be loaded.": "Pateat's settings could not be loaded.",
  "{{hostname}} is no longer excluded.": "{{hostname}} is no longer excluded.",
  "{{hostname}} is now excluded.": "{{hostname}} is now excluded.",
  "Vault account": "Vault account",
  "{{account}}, not available here": "{{account}}, not available here",
  "Finding the vault items that match this site…": "Finding the vault items that match this site…",
  "Finding the vault items that match this site took too long. Wait a moment, then reopen this popup.":
    "Finding the vault items that match this site took too long. Wait a moment, then reopen this popup.",
  "The matching accounts could not be listed. Reopen this popup to try again.":
    "The matching accounts could not be listed. Reopen this popup to try again.",
  "No vault item matches this site. Add the site's URI or passkey to the item in your vault, then sync.":
    "No vault item matches this site. Add the site's URI or passkey to the item in your vault, then sync.",
  "This account is unavailable. Choose another one or use the settings page.":
    "This account is unavailable. Choose another one or use the settings page.",
  "This vault account is connected more than once. Choose the default in the settings page.":
    "This vault account is connected more than once. Choose the default in the settings page.",
  "{{name}} is now the default for this site.": "{{name}} is now the default for this site.",
  "The default account for this site was removed.":
    "The default account for this site was removed.",
  "Remove default": "Remove default",
  "Checking whether this page waits for an account choice…":
    "Checking whether this page waits for an account choice…",
  "Listing the accounts that match this page…": "Listing the accounts that match this page…",
  "Choose an account": "Choose an account",
  matchingAccounts_one: "{{count}} account matches this page.",
  matchingAccounts_other: "{{count}} accounts match this page.",
  "You were logged out of this site in another tab, or the site did not accept a login there.":
    "You were logged out of this site in another tab, or the site did not accept a login there.",
  "The site did not accept a login in another tab.":
    "The site did not accept a login in another tab.",
  "The site did not accept the last login in this tab.":
    "The site did not accept the last login in this tab.",
  "The last login on this site stopped in this tab.":
    "The last login on this site stopped in this tab.",
  "Another tab's login to this site is running or did not succeed. Close that tab, or wait up to 10 minutes.":
    "Another tab's login to this site is running or did not succeed. Close that tab, or wait up to 10 minutes.",
  "Account to log in with": "Account to log in with",
  "Make it the default for {{hostname}}": "Make it the default for {{hostname}}",
  "Log in": "Log in",
  "The saved default, {{title}} ({{sub}}), is not one of these accounts.":
    "The saved default, {{title}} ({{sub}}), is not one of these accounts.",
  "Some vaults or items could not be checked, so the site's matches may be incomplete.":
    "Some vaults or items could not be checked, so the site's matches may be incomplete.",
  "Default account": "Default account",
  "No default account. With exactly one matching item, Pateat uses that item.":
    "No default account. With exactly one matching item, Pateat uses that item.",
  "Some vaults or items could not be checked, so this list may be incomplete.":
    "Some vaults or items could not be checked, so this list may be incomplete.",
  "A default takes effect at the next login.": "A default takes effect at the next login.",
  "Use as default": "Use as default",
  "Excluded by a rule that also covers other sites.":
    "Excluded by a rule that also covers other sites.",
  "and its subdomains": "and its subdomains",
  "Change in settings for {{hostname}}": "Change in settings for {{hostname}}",
  "Change in settings": "Change in settings",
  "Pateat does not log in or answer passkey requests on this site.":
    "Pateat does not log in or answer passkey requests on this site.",
  "This tab": "This tab",
  "Open settings": "Open settings",
  "the site did not accept the password": "the site did not accept the password",
  "the steps kept failing, and the retry limit was reached":
    "the steps kept failing, and the retry limit was reached",
  "the login was already submitted as often as allowed":
    "the login was already submitted as often as allowed",
  "the page after submitting did not show whether it worked":
    "the page after submitting did not show whether it worked",
  "the page did not match the recipe": "the page did not match the recipe",
  "the page did not respond in time": "the page did not respond in time",
  "the tab moved to another site during the login":
    "the tab moved to another site during the login",
  "the page moved on before submitting, or Pateat restarted":
    "the page moved on before submitting, or Pateat restarted",
  "a value did not fit its input, so nothing was filled":
    "a value did not fit its input, so nothing was filled",
  "the page marked a filled input as invalid, so nothing was pressed":
    "the page marked a filled input as invalid, so nothing was pressed",
  "the page's software keyboard did not show a key Pateat pressed, so nothing more was pressed":
    "the page's software keyboard did not show a key Pateat pressed, so nothing more was pressed",
  "the page shows a different account from the one chosen":
    "the page shows a different account from the one chosen",
  "the page showed another account, so the login switched accounts":
    "the page showed another account, so the login switched accounts",
  "the list of accounts does not show this account":
    "the list of accounts does not show this account",
  "the site asks for another step, such as a code":
    "the site asks for another step, such as a code",
  "the site's other step was not finished": "the site's other step was not finished",
  "no later page showed that the login finished": "no later page showed that the login finished",
  "the login was cancelled": "the login was cancelled",
  "the settings or the vault changed during the login":
    "the settings or the vault changed during the login",
  "this site is already logged in": "this site is already logged in",
  "the last login on this site stopped in this tab":
    "the last login on this site stopped in this tab",
  "the sign-in form shows, but the recipe's first step was not found":
    "the sign-in form shows, but the recipe's first step was not found",
  "the AI classified this page as a verification while signed in, or could not tell, so Pateat does not fill it; if that is wrong, revoke its recipe on the service's Sites page (/manage/sites) so the page is sent again":
    "the AI classified this page as a verification while signed in, or could not tell, so Pateat does not fill it; if that is wrong, revoke its recipe on the service's Sites page (/manage/sites) so the page is sent again",
  "no recipe of this site starts on this page": "no recipe of this site starts on this page",
  "Pateat waits for you to choose an account": "Pateat waits for you to choose an account",
  "several accounts match; choose one to log in": "several accounts match; choose one to log in",
  "another tab's login to this site is running or did not succeed":
    "another tab's login to this site is running or did not succeed",
  "another login runs in this tab": "another login runs in this tab",
  "Pateat already holds as many login records as it can":
    "Pateat already holds as many login records as it can",
  "Pateat could not save the login's state": "Pateat could not save the login's state",
  "the recipe has no way to log in with this vault item":
    "the recipe has no way to log in with this vault item",
  "the site's sign-in link was not pressed": "the site's sign-in link was not pressed",
  "the chosen account changed": "the chosen account changed",
  "the vault item's username could not be read, so its account cannot be found on the list":
    "the vault item's username could not be read, so its account cannot be found on the list",
  "another request for this page is already being sent to the AI":
    "another request for this page is already being sent to the AI",
  "the AI was asked about this page within the last 10 minutes, so it is not asked again yet":
    "the AI was asked about this page within the last 10 minutes, so it is not asked again yet",
  "Pateat cannot use the sync service on this device":
    "Pateat cannot use the sync service on this device",
  "no vault item matches this site": "no vault item matches this site",
  "the vault could not be read": "the vault could not be read",
  "the vault connection is turned off": "the vault connection is turned off",
  "this page came right after a sign-in": "this page came right after a sign-in",
  "the page showed no sign-in form": "the page showed no sign-in form",
  "the vault item has neither a password nor a passkey":
    "the vault item has neither a password nor a passkey",
  "the vault item has no password, and the recipe has no way on without one":
    "the vault item has no password, and the recipe has no way on without one",
  "the vault item has no password": "the vault item has no password",
  "the site's sign-in link": "the site's sign-in link",
  "the site's list of accounts": "the site's list of accounts",
  "the rest of the site's sign-in": "the rest of the site's sign-in",
  "the site's sign-in page": "the site's sign-in page",
  "This site has a recipe for this page.": "This site has a recipe for this page.",
  "This site has a recipe, but none starts on this page.":
    "This site has a recipe, but none starts on this page.",
  "This site has no recipe yet.": "This site has no recipe yet.",
  "The AI is making a recipe for {{what}}…": "The AI is making a recipe for {{what}}…",
  "A page was sent to the AI for {{what}}, and no answer was recorded.":
    "A page was sent to the AI for {{what}}, and no answer was recorded.",
  "The AI made a recipe for {{what}}.": "The AI made a recipe for {{what}}.",
  "The AI chose not to make a recipe for {{what}} ({{reason}}).":
    "The AI chose not to make a recipe for {{what}} ({{reason}}).",
  "The AI could not make a recipe for {{what}} ({{reason}}).":
    "The AI could not make a recipe for {{what}} ({{reason}}).",
  "Waiting for an answer from the AI…": "Waiting for an answer from the AI…",
  "Not sent to the AI: {{why}}.": "Not sent to the AI: {{why}}.",
  "Pateat did not log in: {{why}}.": "Pateat did not log in: {{why}}.",
  "No login started: {{why}}.": "No login started: {{why}}.",
  "The login could not be confirmed.": "The login could not be confirmed.",
  "Logged in.": "Logged in.",
  "The site did not accept the last login; choose an account to try again.":
    "The site did not accept the last login; choose an account to try again.",
  "Waiting for you to finish the site's other step, such as a code.":
    "Waiting for you to finish the site's other step, such as a code.",
  "The result is not known yet; the next pages are checked for it.":
    "The result is not known yet; the next pages are checked for it.",
  "Logging in…": "Logging in…",
  "no reason was recorded": "no reason was recorded",
  "The login stopped: {{why}}.": "The login stopped: {{why}}.",
  "The login did not succeed: {{why}}.": "The login did not succeed: {{why}}.",
  "The result of the login is not known: {{why}}.":
    "The result of the login is not known: {{why}}.",
  "This recipe is not made again automatically.": "This recipe is not made again automatically.",
  "Pateat pressed keys on the page's software keyboard before it stopped. Reload the page before you enter the value.":
    "Pateat pressed keys on the page's software keyboard before it stopped. Reload the page before you enter the value.",
  "This page": "This page",
  "Open the detailed log": "Open the detailed log",
  matchingAccounts: "{{count}} accounts match this page.",
  "{{title}}, {{sub}}, default": "{{title}}, {{sub}}, default",
  "{{title}}, {{sub}}": "{{title}}, {{sub}}",
  "{{text}}. Pateat logs in with its passkey only when the passkey needs no username, and the page asks for a passkey or the recipe presses a passkey button":
    "{{text}}. Pateat logs in with its passkey only when the passkey needs no username, and the page asks for a passkey or the recipe presses a passkey button",
  "the vault item has no password, and Pateat goes on to a passkey only on a recipe with one way to sign in":
    "the vault item has no password, and Pateat goes on to a passkey only on a recipe with one way to sign in",
  "the vault item has no password, and the recipe neither asks for one nor goes on to another page":
    "the vault item has no password, and the recipe neither asks for one nor goes on to another page",
  "the vault item has no password, and the recipe needs another value the item lacks before it":
    "the vault item has no password, and the recipe needs another value the item lacks before it",
  "the vault item has no password, and the account fills its password from another field":
    "the vault item has no password, and the account fills its password from another field",
  "the vault item has no password, and this page asks for it":
    "the vault item has no password, and this page asks for it",
  "the vault item has no password, and Pateat goes on without one only in the page itself, not in a frame":
    "the vault item has no password, and Pateat goes on without one only in the page itself, not in a frame",
  "After a logout, Pateat only fills the sign-in form and presses nothing; sign in when you are ready.":
    "After a logout, Pateat only fills the sign-in form and presses nothing; sign in when you are ready.",
  "The page changed, so nothing was started. {{name}} was not made the default. Reload it to choose again.":
    "The page changed, so nothing was started. {{name}} was not made the default. Reload it to choose again.",
  "Another tab's login to this site is running or did not succeed, so Pateat did not log in here. {{name}} was not made the default. Close that tab, or wait up to 10 minutes, then choose again.":
    "Another tab's login to this site is running or did not succeed, so Pateat did not log in here. {{name}} was not made the default. Close that tab, or wait up to 10 minutes, then choose again.",
  "Pateat could not log in with {{name}} on this page. {{name}} was not made the default. Reload the page to choose again.":
    "Pateat could not log in with {{name}} on this page. {{name}} was not made the default. Reload the page to choose again.",
  "This page no longer waits for an account choice. {{name}} was not made the default.":
    "This page no longer waits for an account choice. {{name}} was not made the default.",
  "Pateat: logged in.": "Pateat: logged in.",
  "Pateat: the result of the login is not known ({{reason}}). Click for details.":
    "Pateat: the result of the login is not known ({{reason}}). Click for details.",
  "Pateat: the login did not succeed ({{reason}}). Click for details.":
    "Pateat: the login did not succeed ({{reason}}). Click for details.",
  badgeUsable_one: "Pateat: {{count}} account for this site.",
  badgeUsable_other: "Pateat: {{count}} accounts for this site.",
  badgeMoreExcluded_one: "{{count}} more is excluded in settings.",
  badgeMoreExcluded_other: "{{count}} more are excluded in settings.",
  badgeMoreReview_one: "{{count}} more waits for a custom-field review in settings.",
  badgeMoreReview_other: "{{count}} more wait for a custom-field review in settings.",
  badgeMoreItemsReview_one:
    "{{count}} more is excluded or waits for a custom-field review in settings.",
  badgeMoreItemsReview_other:
    "{{count}} more are excluded or wait for a custom-field review in settings.",
  badgeUnknown_one: "{{count}} item could not be checked.",
  badgeUnknown_other: "{{count}} items could not be checked.",
  badgeExcludedSite_one:
    "Pateat: {{count}} account matches this site, but none can be used: this site is excluded in settings.",
  badgeExcludedSite_other:
    "Pateat: {{count}} accounts match this site, but none can be used: this site is excluded in settings.",
  badgeExcludedItems_one:
    "Pateat: {{count}} account matches this site, but none can be used: they are excluded in settings.",
  badgeExcludedItems_other:
    "Pateat: {{count}} accounts match this site, but none can be used: they are excluded in settings.",
  badgeExcludedReview_one:
    "Pateat: {{count}} account matches this site, but none can be used: they wait for a custom-field review in settings.",
  badgeExcludedReview_other:
    "Pateat: {{count}} accounts match this site, but none can be used: they wait for a custom-field review in settings.",
  badgeExcludedItemsReview_one:
    "Pateat: {{count}} account matches this site, but none can be used: they are excluded or wait for a custom-field review in settings.",
  badgeExcludedItemsReview_other:
    "Pateat: {{count}} accounts match this site, but none can be used: they are excluded or wait for a custom-field review in settings.",
  "Pateat: no account for this site.": "Pateat: no account for this site.",
  "Pateat: the vault is locked, so this site's accounts were not counted.":
    "Pateat: the vault is locked, so this site's accounts were not counted.",
  "Pateat: the vault has not been opened since Pateat restarted, so this site's accounts were not counted.":
    "Pateat: the vault has not been opened since Pateat restarted, so this site's accounts were not counted.",
  "Pateat: the vault could not be read, so this site's accounts were not counted.":
    "Pateat: the vault could not be read, so this site's accounts were not counted.",
  "Pateat: the vault is being updated, so this site's accounts were not counted.":
    "Pateat: the vault is being updated, so this site's accounts were not counted.",
  "Pateat: a login or a page check was using the vault, so this site's accounts were not counted yet.":
    "Pateat: a login or a page check was using the vault, so this site's accounts were not counted yet.",
  "{{first}} {{next}}": "{{first}} {{next}}",
  "Pateat: asking the AI…": "Pateat: asking the AI…",
  "Pateat: you were logged out of this site in this tab. Click to choose an account.":
    "Pateat: you were logged out of this site in this tab. Click to choose an account.",
  "Pateat: the site did not accept the last login in this tab. Click to choose an account.":
    "Pateat: the site did not accept the last login in this tab. Click to choose an account.",
  "Pateat: the last login on this site stopped in this tab. Click to choose an account.":
    "Pateat: the last login on this site stopped in this tab. Click to choose an account.",
  "Pateat: you were logged out of this site in another tab, or the site did not accept a login there. Click to choose an account.":
    "Pateat: you were logged out of this site in another tab, or the site did not accept a login there. Click to choose an account.",
  "Pateat: {{count}} accounts match this page. Click to choose one.":
    "Pateat: {{count}} accounts match this page. Click to choose one.",
  "Pateat: another tab's login to this site is running or did not succeed. Close that tab, or wait up to 10 minutes and reload this page, to log in here.":
    "Pateat: another tab's login to this site is running or did not succeed. Close that tab, or wait up to 10 minutes and reload this page, to log in here.",
  "This page asks for {{detail}}.": "This page asks for {{detail}}.",
  Fill: "Fill",
  Remove: "Remove",
  "Personal details Pateat fills on this site": "Personal details Pateat fills on this site",
  "Filled from {{field}}": "Filled from {{field}}",
  "Filled from {{field}} (not saved yet)": "Filled from {{field}} (not saved yet)",
  "Remove the link for {{detail}}": "Remove the link for {{detail}}",
  "Filling…": "Filling…",
  "Filled. Check it and submit the form; Pateat saves this choice once you are signed in.":
    "Filled. Check it and submit the form; Pateat saves this choice once you are signed in.",
  "Nothing was filled. Reopen this popup and try again.":
    "Nothing was filled. Reopen this popup and try again.",
  "Removing…": "Removing…",
  "Removed. Pateat no longer fills {{detail}} on this site.":
    "Removed. Pateat no longer fills {{detail}} on this site.",
  "This link was already removed.": "This link was already removed.",
  "The link could not be removed. Reopen this popup and try again.":
    "The link could not be removed. Reopen this popup and try again.",
  "The link may not have been removed. Reopen this popup to see the links.":
    "The link may not have been removed. Reopen this popup to see the links.",
  "your birth year and month": "your birth year and month",
  "your birth month and day": "your birth month and day",
  "your birth date": "your birth date",
  "the last 4 digits of your phone number": "the last 4 digits of your phone number",
  "the last 4 digits of your card number": "the last 4 digits of your card number",
  "your card's security code": "your card's security code",
  "The page changed, so nothing was filled.": "The page changed, so nothing was filled.",
  "This page no longer asks for it.": "This page no longer asks for it.",
  "That field does not hold a value Pateat can use here.":
    "That field does not hold a value Pateat can use here.",
  "Pateat cannot read that field now. Unlock the vault and try again.":
    "Pateat cannot read that field now. Unlock the vault and try again.",
  "The page did not accept the value.": "The page did not accept the value.",
  "the answer to your secret question": "the answer to your secret question",
  "your member or customer number": "your member or customer number",
  "This page asks \u201C{{question}}\u201D.": "This page asks \u201C{{question}}\u201D.",
  "Pateat\u2019s AI thinks this field holds the answer. Fill only if it does; Pateat then fills it whenever this question shows.":
    "Pateat\u2019s AI thinks this field holds the answer. Fill only if it does; Pateat then fills it whenever this question shows.",
  "ID {{id}}": "ID {{id}}",
  vaultsLocked_one: "{{count}} vault is locked, so its logins and passkeys wait.",
  vaultsLocked_other: "{{count}} vaults are locked, so their logins and passkeys wait.",
  "Unlock in settings": "Unlock in settings",
} as const;
