import { describe, expect, it } from "vitest";
import type { SignedInObservationTestContext } from "./context";

export function registerSignedInNearButtons({
  page,
  observe,
  signedIn,
}: Pick<SignedInObservationTestContext, "page" | "observe" | "signedIn">) {
  describe("texts near the buttons of a page without a code field (ADR 0027)", () => {
    // Oracle Cloud's FIDO step (2026-10-13), reduced: a help widget beside the step, a
    // tenant and account in the outer section, and in the main landmark a heading below
    // h3, the sentence that says what "Verify" starts, the button three parents below it
    // and a link.
    const sentence =
      "To verify your credentials using FIDO Authenticator Security Key or Windows Hello, click Verify.";
    const help =
      "An identity domain is a container for managing users and roles, federating and provisioning of users.";
    const step = (main: string) =>
      `<oj-idaas-module-adapter ${main}><oj-module><div class="oj-flex">
        <h4>FIDO Authenticator Verification</h4>
        <span>${sentence}</span>
        <div><oj-button><button id="verify" type="button"><span>Verify</span></button></oj-button></div>
        <a href="#">Show alternative login methods</a>
      </div></oj-module></oj-idaas-module-adapter>`;
    const widget = `<div><div>Default</div>
      <div class="oj-idaas-signin-domain-info">
        <a role="button" tabindex="0" id="oj-idaas-signin-section-domain-help-link"><span>What is an identity domain?</span></a>
        <span>${help}</span></div></div>`;
    // `wrap` more parents between the section and the step put the widget out of reach
    // of the step's button.
    const oracle = (main: string, wrap = 0) =>
      page(
        `<div id="app"><section><h1>Example Tenant</h1><h2>taro@example.com</h2>
          ${widget}${"<div>".repeat(wrap)}${step(main)}${"</div>".repeat(wrap)}</section></div>`,
        "Sign In | Example Cloud",
      );
    const outside = [help, "Default", "What is an identity domain?"];

    it("sends the texts near the buttons inside the main landmark, not a widget beside it", () => {
      for (const main of ['role="main"', 'role="MAIN"', 'role="region main"']) {
        oracle(main, 2);
        const observation = signedIn();
        expect(observation.nearButtons, main).toEqual([
          "FIDO Authenticator Verification",
          sentence,
        ]);
        expect(observation, main).not.toHaveProperty("nearCode");
      }
      // A `main` element counts as the landmark too.
      page(
        `<div id="app"><section>${widget}<div><div>${step("")
          .replace("<oj-idaas-module-adapter >", "<main>")
          .replace("</oj-idaas-module-adapter>", "</main>")}</div></div></section></div>`,
      );
      expect(signedIn().nearButtons).toEqual(["FIDO Authenticator Verification", sentence]);
    });

    it("never sends a widget's text beside the main landmark, even within six parents", () => {
      // The widget beside the landmark is within six parents of the step's button, but the
      // climb from the button stops at the landmark.
      oracle('role="main"');
      const observation = signedIn();
      for (const text of [...outside, "Verify", "Show alternative login methods"])
        expect(observation.nearButtons, text).not.toContain(text);
      expect(observation.nearButtons).toEqual(["FIDO Authenticator Verification", sentence]);
    });

    it("reads around every button by depth without a main landmark", () => {
      // The help button comes first in the page, so its nearer texts are taken first, one
      // parent at a time around both buttons, and the step's sentence is left out.
      oracle("");
      expect(signedIn().nearButtons).toEqual(["Default", help, "FIDO Authenticator Verification"]);
      // With the widget out of the step button's reach, its texts still come first.
      oracle("", 2);
      expect(signedIn().nearButtons).toEqual(["Default", help, "FIDO Authenticator Verification"]);
    });

    it("reads the first shown main landmark, not a hidden one before it", () => {
      for (const hidden of [
        "<main hidden>",
        '<main style="display: none">',
        '<div role="main" hidden>',
      ]) {
        const close = hidden.startsWith("<main") ? "</main>" : "</div>";
        page(
          `${hidden}<p>Your dashboard overview</p><button id="refresh" type="button">Refresh</button>${close}
          <main><p>Touch your security key to continue.</p>
            <button id="verify" type="button">Verify</button></main>`,
        );
        expect(signedIn().nearButtons, hidden).toEqual(["Touch your security key to continue."]);
      }
    });

    // EPOS Net's image puzzle after the sign-in (2026-11-11 12:53 UTC): the sentence that
    // asks for it holds a `<br>`, and the description carried no text near its button.
    it("reads a sentence whose child elements are only inline text whole", () => {
      const puzzle = (text: string) =>
        page(
          `<div><h1>エポスNet マイページログイン</h1><form action="/login" method="post"><div>
            <p class="text">${text}</p><div class="puzzle"></div>
            <p class="btn"><input type="submit" value="ログイン"></p></div></form></div>`,
        );
      puzzle(
        "セキュリティ強化のため、画像認証を実施中です。<br>ピースを動かして画像を完成させてください。",
      );
      expect(signedIn().nearButtons).toEqual([
        "セキュリティ強化のため、画像認証を実施中です。 ピースを動かして画像を完成させてください。",
      ]);
      // Emphasis, a `span` and an icon inside it read the same, and once.
      puzzle(
        'ピースを<strong>動かして</strong><span class="note">画像を完成</span>させてください。<img alt="" src="data:,">',
      );
      expect(signedIn().nearButtons).toEqual(["ピースを動かして画像を完成させてください。"]);
      // A sentence that holds a link is no text block: its inline parts are read alone.
      puzzle('<span>ピースを動かしてください。</span><a href="/help">ヘルプ</a>');
      expect(signedIn().nearButtons).toEqual(["ピースを動かしてください。"]);
      // Nor is a region with more elements than a sentence holds.
      puzzle(`<span>ピースを動かしてください。</span>${"<span>ああ</span>".repeat(20)}`);
      expect(signedIn().nearButtons).toEqual(["ピースを動かしてください。", "ああ"]);
    });

    it("never reads a text block that looks like a key whole", () => {
      page(`<main><p>Your key <b>ABCD-EFGH-IJKL</b><br>Keep it safe.</p>
        <button id="verify" type="button">Verify</button></main>`);
      expect(signedIn()).not.toHaveProperty("nearButtons");
    });

    it("reads only the open modal dialog that holds a button", () => {
      const behind = `<main aria-hidden="true"><div><p>Your dashboard overview</p>
        <button id="refresh" type="button">Refresh</button></div></main>`;
      const inside = `<div><p>Touch your security key to continue.</p>
        <button id="verify" type="button">Verify</button></div>`;
      page(`${behind}<div role="dialog" aria-modal="true">${inside}</div>`);
      let observation = signedIn();
      // The page behind the modal is read, as the existing modal tests show, but its texts
      // are not sent near the buttons.
      expect(observation.candidates).toContainEqual(
        expect.objectContaining({ role: "button", label: "Refresh" }),
      );
      expect(observation.nearButtons).toEqual(["Touch your security key to continue."]);
      // A native modal opened with `showModal()` bounds them the same way.
      page(`${behind.replace(' aria-hidden="true"', "")}<dialog id="key">${inside}</dialog>`);
      document.querySelector<HTMLDialogElement>("#key")!.showModal();
      observation = signedIn();
      expect(observation.nearButtons).toEqual(["Touch your security key to continue."]);
      // A dialog that is not modal does not bound them: the main landmark does.
      page(
        `<main><div><p>Your dashboard overview</p>
          <button id="refresh" type="button">Refresh</button></div></main>
        <div role="dialog">${inside}</div>`,
      );
      expect(signedIn().nearButtons).toEqual(["Your dashboard overview"]);
    });

    it("never reads around the header's buttons or sends the header's texts", () => {
      for (const [open, close] of [
        ["<header>", "</header>"],
        ["<nav>", "</nav>"],
        ['<div role="banner">', "</div>"],
        ['<div role="navigation">', "</div>"],
      ] as const) {
        page(
          `<div id="app">${open}<div><span>Signed in to Example Tenant</span>
              <button id="menu" type="button">Menu</button></div>${close}
            <section><div><div><p>Touch your security key to continue.</p>
              <div><button id="verify" type="button">Verify</button></div></div></div></section>
          </div>`,
        );
        const observation = signedIn();
        expect(observation.nearButtons, open).toEqual(["Touch your security key to continue."]);
        // The header text carries it instead.
        if (open === "<header>" || open.includes("banner"))
          expect(observation.headerText, open).toContain("Signed in to Example Tenant");
      }
      // A page whose only button is in the header sends none.
      page(
        `<div id="app"><header><div><span>Signed in to Example Tenant</span>
            <button id="menu" type="button">Menu</button></div></header>
          <section><p>Touch your security key to continue.</p>
            <a id="other" href="/other">Use another method</a></section></div>`,
      );
      expect(signedIn()).not.toHaveProperty("nearButtons");
    });

    it("sends texts near a code field instead when the page has one", () => {
      page(
        `<main><div><p>Touch your security key to continue.</p>
          <div><span>Enter the code from your authenticator app.</span>
            <input id="otp" autocomplete="one-time-code" aria-label="Code"></div>
          <div><span>Or use your security key</span>
            <button id="key" type="button">Use security key</button></div>
          <button id="verify" type="submit">Verify</button></div></main>`,
      );
      const observation = signedIn();
      expect(observation.nearCode).toEqual([
        "Touch your security key to continue.",
        "Enter the code from your authenticator app.",
        "Or use your security key",
      ]);
      expect(observation).not.toHaveProperty("nearButtons");
      // A split code's first input counts as a code field as well.
      const digits = Array.from(
        { length: 6 },
        (_, index) =>
          `<input id="d${index}" type="text" inputmode="numeric" maxlength="1"
            aria-label="Digit ${index + 1}">`,
      ).join("");
      page(
        `<main><div><p>Enter the code from your authenticator app.</p><div>${digits}</div>
          <button id="verify" type="submit">Verify</button></div></main>`,
      );
      expect(signedIn().nearCode).toEqual(["Enter the code from your authenticator app."]);
      expect(signedIn()).not.toHaveProperty("nearButtons");
    });

    it("sends none without a button, or without one inside the main landmark", () => {
      // Links only.
      page(
        `<main><div><p>Touch your security key to continue.</p>
          <a id="other" href="/other">Use another method</a></div></main>`,
      );
      expect(signedIn()).not.toHaveProperty("nearButtons");
      // The only button sits outside the landmark, next to a text.
      page(
        `<div><div><p>Need help with your account?</p>
          <button id="help" type="button">Help</button></div>
        <main><div><p>Touch your security key to continue.</p>
          <a id="other" href="/other">Use another method</a></div></main></div>`,
      );
      expect(signedIn()).not.toHaveProperty("nearButtons");
    });

    // A step with one button, and `text` beside its sentence.
    const near = (text: string) =>
      page(
        `<main><div><p>Touch your security key to continue.</p>${text}
          <div><button id="verify" type="button">Verify</button></div></div></main>`,
        "Security check",
      );

    it("leaves out live regions, controls, labels, links, headings and repeated texts", () => {
      near("");
      expect(signedIn().nearButtons).toEqual(["Touch your security key to continue."]);
      for (const text of [
        '<p role="alert">Security key not detected</p>',
        '<p role="status">Waiting for your security key</p>',
        '<p aria-live="polite">Waiting for your security key</p>',
        '<a href="/help">Trouble with your security key?</a>',
        '<span role="link" tabindex="0">Trouble with your security key?</span>',
        '<span role="button" tabindex="0">Try again later</span>',
        '<label for="remember">Remember this device</label><input id="remember" type="checkbox">',
        "<h1>Use your security key</h1>",
        "<h2>Use your security key</h2>",
        "<h3>Use your security key</h3>",
        '<div role="heading" aria-level="4">Use your security key</div>',
        "<code>Use your security key</code>",
        // A text that repeats the title, a heading or a button's label.
        "<span>Security check</span>",
        "<h1>Use your security key</h1><span>Use your security key</span>",
        "<span>Verify</span>",
        // Fewer than two letters beside the placeholders.
        "<span>9:59</span>",
        "<span>A</span>",
        "<span>5 s</span>",
        "<span>taro@example.com 5</span>",
      ]) {
        near(text);
        expect(signedIn().nearButtons, text).toEqual(["Touch your security key to continue."]);
      }
      // A key or recovery code leaves out every text read in the parent that shows it.
      for (const text of [
        "<span>Your key ABCD-EFGH-1234-5678</span>",
        "<span>ABCD-EFGH-1234-5678</span>",
        "<p><span>JBSW</span><span>Y3DP</span><span>EHPK</span><span>3PXP</span></p>",
      ]) {
        near(text);
        expect(signedIn(), text).not.toHaveProperty("nearButtons");
      }
      // A parent that holds another shown field to type in stops the climb.
      page(
        `<div><p>Far away text</p>
          <div><input id="q" type="search" aria-label="Search">
            <div><p>Touch your security key to continue.</p>
              <div><button id="verify" type="button">Verify</button></div></div></div></div>`,
      );
      expect(signedIn().nearButtons).toEqual(["Touch your security key to continue."]);
    });

    it("hides and cuts the texts as the rest of the page", () => {
      near("<span>We sent a request to taro@example.com, valid for 5 minutes</span>");
      expect(signedIn().nearButtons).toEqual([
        "Touch your security key to continue.",
        "We sent a request to [email], valid for [number] minutes",
      ]);
      near("<span>Call +1 0123-4567-8901 if you lost your key</span>");
      expect(signedIn().nearButtons).toEqual([
        "Touch your security key to continue.",
        "Call +[number] [number]-[number]-[number] if you lost your key",
      ]);
      // A long text is cut at 120 characters.
      const long = `To verify your credentials ${"using your security key ".repeat(8)}click Verify.`;
      near(`<span>${long}</span>`);
      const [, cut] = signedIn().nearButtons!;
      expect(cut!.length).toBeLessThanOrEqual(120);
      expect(long.startsWith(cut!)).toBe(true);
      expect(cut!.length).toBeGreaterThan(110);
    });

    // Oracle Cloud's FIDO step as the page showed it (2026-10-13): three nested main
    // landmarks, the first an `oj-module`, and the step, with its sentence and the Verify
    // button, in an `aria-live` region.
    const liveStep = (extra = "") =>
      `<div id="app"><section><h1>Example Tenant</h1><h2>taro@example.com</h2>${widget}
        <oj-module role="main" style="display: block"><oj-idaas-module-adapter role="main">
          <oj-module><oj-idaas-module-adapter id="idcs-mfa-mfa-auth-factors-section-content" role="main">
            <oj-module><div aria-live="polite" class="oj-flex oj-sm-12">
              <h4>FIDO Authenticator Verification</h4>
              <span id="idcs-mfa-mfa-auth-fido-text">${sentence}</span>${extra}
              <div class="oj-flex-item"><oj-button id="idcs-mfa-mfa-auth-fido-submit-button">
                <button type="button"><span>Verify</span></button></oj-button></div>
              <a href="#">Show alternative login methods</a>
            </div></oj-module>
          </oj-idaas-module-adapter></oj-module>
        </oj-idaas-module-adapter></oj-module></section></div>`;

    it("reads a polite live region that holds one of the buttons, as Oracle Cloud's step", () => {
      page(liveStep(), "Sign In | Example Cloud");
      const observation = signedIn();
      // The h4 is read as any text: only headings up to h3, which the observation carries,
      // are left out.
      expect(observation.nearButtons).toEqual(["FIDO Authenticator Verification", sentence]);
      expect(observation).not.toHaveProperty("nearCode");
      // A region marked `aria-live="off"` is no live region and is read as before.
      page(
        `<main><div aria-live="off"><p>Touch your security key to continue.</p>
          <div><button id="verify" type="button">Verify</button></div></div></main>`,
      );
      expect(signedIn().nearButtons).toEqual(["Touch your security key to continue."]);
      // Every polite region around the button inside the main landmark is read, not only
      // the nearest, and so is the landmark itself when it is one.
      page(
        `<main aria-live="POLITE"><div aria-live="polite"><p>Touch your security key to continue.</p>
          <div aria-live="polite"><p>Waiting for your security key</p>
            <div><button id="verify" type="button">Verify</button></div></div></div></main>`,
      );
      expect(signedIn().nearButtons).toEqual([
        "Touch your security key to continue.",
        "Waiting for your security key",
      ]);
      // Inside an open modal dialog that bounds the texts, as well.
      page(
        `<main aria-hidden="true"><p>Your dashboard overview</p></main>
        <div role="dialog" aria-modal="true"><div aria-live="polite">
          <p>Touch your security key to continue.</p>
          <div><button id="verify" type="button">Verify</button></div></div></div>`,
      );
      expect(signedIn().nearButtons).toEqual(["Touch your security key to continue."]);
    });

    it("leaves out an alert, status, log, marquee, timer or assertive region that holds a button", () => {
      for (const live of [
        'role="status"',
        'role="alert"',
        'role="log"',
        'role="marquee"',
        'role="timer"',
        'aria-live="assertive"',
        // A role of its own makes a polite region no step.
        'role="status" aria-live="polite"',
        'role="log" aria-live="polite"',
      ]) {
        page(
          `<main><div ${live}><p>Touch your security key to continue.</p>
            <div><button id="verify" type="button">Verify</button></div></div></main>`,
        );
        expect(signedIn(), live).not.toHaveProperty("nearButtons");
      }
      // An alert with a dismiss button beside the step: its text, which may name the
      // account's key, is not sent, the step's is.
      page(
        `<main><div><p>Touch your security key to continue.</p>
            <div><button id="verify" type="button">Verify</button></div></div>
          <div role="alert"><p>Your last attempt with key Bravo failed</p>
            <button id="dismiss" type="button" aria-label="Dismiss">x</button></div></main>`,
      );
      let observation = signedIn();
      expect(observation.nearButtons).toEqual(["Touch your security key to continue."]);
      expect(JSON.stringify(observation)).not.toContain("Bravo");
      // A chat log whose messages each have a button sends none of them.
      page(
        `<main><div role="log"><div><p>Hanako: see you at the station</p>
          <button id="react" type="button">React</button></div></div></main>`,
      );
      observation = signedIn();
      expect(observation).not.toHaveProperty("nearButtons");
      expect(JSON.stringify(observation)).not.toContain("Hanako");
      // A polite step inside a status region is left out with it.
      page(
        `<main><div role="status"><p>Touch your security key to continue.</p>
          <div aria-live="polite"><p>Waiting for your security key</p>
            <div><button id="verify" type="button">Verify</button></div></div></div></main>`,
      );
      expect(signedIn()).not.toHaveProperty("nearButtons");
    });

    it("never reads a live region around the main landmark or without a bound", () => {
      // A page wrapped whole in a polite region: the region is above the main landmark.
      page(
        `<div id="app" aria-live="polite"><header><span>Example Cloud</span>
            <button id="menu" type="button">Menu</button></header>
          <main><div><p>Welcome back, your plan renews on Monday.</p>
            <p>Review your recent sign-ins below.</p>
            <div><button id="continue" type="button">Continue</button></div></div></main></div>`,
      );
      let observation = signedIn();
      expect(observation).not.toHaveProperty("nearButtons");
      expect(JSON.stringify(observation)).not.toContain("recent sign-ins");
      // Without a main landmark or an open modal, no polite region is read.
      page(
        `<div><div><p>Need help? Contact support.</p>
          <div aria-live="polite"><p>Touch your security key to continue.</p>
            <div><button id="verify" type="button">Verify</button></div></div></div></div>`,
      );
      observation = signedIn();
      expect(observation.nearButtons).toEqual(["Need help? Contact support."]);
      expect(JSON.stringify(observation)).not.toContain("Touch your security key");
    });

    it("never reads a live region around a button that is itself left out, as a heading", () => {
      for (const [open, close] of [
        ['<h2 aria-live="polite">', "</h2>"],
        ['<label aria-live="polite">', "</label>"],
        ['<div role="heading" aria-level="4" aria-live="polite">', "</div>"],
      ] as const) {
        page(
          `<main><div><p>Touch your security key to continue.</p>
            ${open}<span>Use your security key</span>
              <span><button id="verify" type="button">Verify</button></span>${close}</div></main>`,
        );
        expect(signedIn().nearButtons, open).toEqual(["Touch your security key to continue."]);
      }
    });

    it("leaves out a live region inside the step's live region that holds no button", () => {
      for (const extra of [
        '<p role="alert">Security key not detected</p>',
        '<p aria-live="assertive">Security key not detected</p>',
        '<div role="status"><span>Waiting for your security key</span></div>',
        '<div role="log"><div><span>Security key not detected</span></div></div>',
      ]) {
        page(liveStep(extra));
        expect(signedIn().nearButtons, extra).toEqual([
          "FIDO Authenticator Verification",
          sentence,
        ]);
      }
      // Nor does the step's region make the other elements it leaves out readable.
      for (const extra of [
        '<label for="remember">Remember this device</label><input id="remember" type="checkbox">',
        "<h3>Use your security key</h3>",
        "<code>Use your security key</code>",
        '<span role="link" tabindex="0">Trouble with your security key?</span>',
      ]) {
        page(liveStep(extra));
        expect(signedIn().nearButtons, extra).toEqual([
          "FIDO Authenticator Verification",
          sentence,
        ]);
      }
    });

    it("leaves out a live region beside the buttons that holds none of them", () => {
      for (const live of ['role="alert"', 'role="status"', 'aria-live="polite"']) {
        // Beside the step's own live region.
        page(
          `<main><div><div aria-live="polite"><p>Touch your security key to continue.</p>
              <div><button id="verify" type="button">Verify</button></div></div>
            <div ${live}><p>Security key not detected</p></div></div></main>`,
        );
        expect(signedIn().nearButtons, live).toEqual(["Touch your security key to continue."]);
        // And beside a step that is no live region.
        page(
          `<main><div><div><p>Touch your security key to continue.</p>
              <div><button id="verify" type="button">Verify</button></div></div>
            <div ${live}><p>Security key not detected</p></div></div></main>`,
        );
        expect(signedIn().nearButtons, live).toEqual(["Touch your security key to continue."]);
      }
    });

    it("never makes a live region readable for a button that does not count", () => {
      // A polite region inside the main landmark that holds only a navigation or header
      // button, which never counts, keeps its text out even though the step's button
      // reaches it.
      for (const [open, close] of [
        ["<nav>", "</nav>"],
        ["<header>", "</header>"],
        ['<div role="navigation">', "</div>"],
      ] as const) {
        page(
          `<main><div><p>Touch your security key to continue.</p>
              <div><button id="verify" type="button">Verify</button></div></div>
            <div aria-live="polite"><span>Signed in as Example Tenant</span>
              ${open}<button id="menu" type="button">Menu</button>${close}</div></main>`,
        );
        expect(signedIn().nearButtons, open).toEqual(["Touch your security key to continue."]);
      }
      // Nor does a hidden button, which is no candidate.
      page(
        `<main><div><p>Touch your security key to continue.</p>
            <div><button id="verify" type="button">Verify</button></div></div>
          <div aria-live="polite"><span>Retrying with your security key</span>
            <button id="retry" type="button" hidden>Retry</button></div></main>`,
      );
      expect(signedIn().nearButtons).toEqual(["Touch your security key to continue."]);
    });

    it("still sends no text near a code field inside a live region", () => {
      for (const live of ['aria-live="polite"', 'role="status"']) {
        page(
          `<main><div ${live}><p>Enter the code from your authenticator app.</p>
            <div><input id="otp" autocomplete="one-time-code" aria-label="Code"></div>
            <button id="verify" type="submit">Verify</button></div></main>`,
        );
        const observation = signedIn();
        expect(observation, live).not.toHaveProperty("nearCode");
        expect(observation, live).not.toHaveProperty("nearButtons");
      }
    });

    it("never sends texts near the buttons of a login page", () => {
      page(
        `<main><form><div><p>Touch your security key to continue.</p>
          <input id="user" type="email" aria-label="Email">
          <input id="pw" type="password" aria-label="Password">
          <div><button id="go" type="submit">Sign in</button></div>
          <div><span>Or use a passkey from your phone</span>
            <button id="passkey" type="button">Use a passkey</button></div></div></form></main>`,
      );
      expect(observe()).not.toHaveProperty("nearButtons");
      // Nor does a first step without a form that asks only for the account.
      page(
        `<main><div><p>Sign in with a passkey or your email address.</p>
          <input id="user" type="email" aria-label="Email">
          <div><button id="next" type="button">Next</button></div></div></main>`,
      );
      expect(observe()).not.toHaveProperty("nearButtons");
    });
  });
}
