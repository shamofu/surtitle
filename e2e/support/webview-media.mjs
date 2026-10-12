// SPDX-License-Identifier: GPL-3.0-or-later

/** Scope media emulation to the tested WebView; never alter Windows accessibility settings. */
export async function setWebViewReducedMotion(browser, preference) {
  if (!browser.sessionId) throw new Error('WebView media emulation requires an active WebDriver session');
  if (preference !== null && !['no-preference', 'reduce'].includes(preference)) throw new Error('Invalid reduced-motion media preference');
  const { hostname = '127.0.0.1', port = 4444, protocol = 'http', path = '/' } = browser.options;
  // tauri-driver forwards this EdgeDriver vendor endpoint unchanged. WDIO's
  // Chromium helpers are not guaranteed on a browser named "webview2".
  const endpoint = new URL(`${path.replace(/\/$/, '')}/session/${encodeURIComponent(browser.sessionId)}/ms/cdp/execute`, `${protocol}://${hostname}:${port}`);
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cmd: 'Emulation.setEmulatedMedia', params: {
      features: preference === null ? [] : [{ name: 'prefers-reduced-motion', value: preference }],
    } }),
    signal: AbortSignal.timeout(15_000),
  });
  const result = await response.json();
  if (!response.ok || result.value?.error) throw new Error(`WebView media emulation failed (${response.status}): ${result.value?.message || result.value?.error || response.statusText}`);
  return result.value;
}
