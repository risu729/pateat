/** Wraps a synthetic login fixture page body in the shared document, status line and script. */
export function html(body: string, script = ""): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Synthetic login fixture</title></head><body>${body}<p id="fixture-status" aria-live="polite"></p><p>Close this tab and open /identity in a new tab to start another synthetic login.</p><script>
    function updateFixtureStatus() {
      document.getElementById('fixture-status').textContent =
        'Identity clicks: ' + (sessionStorage.getItem('identityClicks') || '0') +
        '; Submit clicks: ' + (sessionStorage.getItem('submitClicks') || '0') +
        '; Identity matched: ' + (sessionStorage.getItem('identityMatched') || 'false') +
        '; Password matched: ' + (sessionStorage.getItem('passwordMatched') || 'false');
    }
    ${script}
    updateFixtureStatus();
  </script></body></html>`;
}
