// Synthetic pages shaped like two verification pages reported on 2026-11-18, for the
// observation and the popup's **Fill** (ADR 0035, amended 2026-11-17). No markup is copied
// from either site; only the structure the reports describe.

/** The value the account form shows in its email input, as a signed-in page does. */
export const shownEmail = "person@example.com";

/**
 * An account details form that asks for the current password before it saves, beside
 * inputs for a new password and its confirmation, as My Parcel Locker's `/Customers/Account`
 * ([#1709](https://github.com/risu729/pateat/issues/1709)): three `type="password"` inputs,
 * the first one the current password. `marks` adds `current-password` and `new-password`
 * tokens, which the report does not say the site has.
 */
export const accountFormWithPasswordChange = (marks = false) => {
  const token = (value: string) => (marks ? ` autocomplete="${value}"` : "");
  return `<h1>Account Details</h1>
<form id="account" method="post" action="/Customers/Account">
  <label for="Email">Email</label><input id="Email" name="Email" type="email" value="${shownEmail}">
  <label for="CurrentPassword">Current Password</label><input id="CurrentPassword" name="CurrentPassword" type="password" required${token("current-password")}>
  <label for="NewPassword">New Password</label><input id="NewPassword" name="NewPassword" type="password"${token("new-password")}>
  <label for="ConfirmNewPassword">Confirm New Password</label><input id="ConfirmNewPassword" name="ConfirmNewPassword" type="password"${token("new-password")}>
  <label for="FirstName">First Name</label><input id="FirstName" name="FirstName" type="text" value="Synthetic">
  <label for="LastName">Last Name</label><input id="LastName" name="LastName" type="text" value="Person">
  <label for="PhoneNumber">Phone Number</label><input id="PhoneNumber" name="PhoneNumber" type="tel" value="5550100">
  <label for="AdditionalRecipients">Additional Recipients</label><input id="AdditionalRecipients" name="AdditionalRecipients" type="text">
  <button id="update" type="submit">Update My Account</button>
</form>`;
};

/**
 * A membership cancellation page that asks for the password again beside the login ID it
 * shows read-only, as WILLER's `/dy/3/common/pc/mypage/taikai/index`
 * ([#1714](https://github.com/risu729/pateat/issues/1714)): one `input[name=password]`.
 */
export const passwordBesideShownLoginId = `<h1>退会手続き</h1>
<form id="cancel" method="post" action="/mypage/cancel">
  <dl>
    <dt>ログインID</dt><dd><input id="login-id" name="loginId" type="text" value="${shownEmail}" readonly></dd>
    <dt>パスワード</dt><dd><input name="password" type="password"></dd>
  </dl>
  <button id="cancel-membership" type="submit">退会する</button>
</form>`;
