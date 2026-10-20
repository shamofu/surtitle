// SPDX-License-Identifier: GPL-3.0-or-later
// Self-contained for WebDriver serialization. Sampling in the WebView continues
// while the driver records native screenshots and checks HWND geometry.
export function startNativePlaybackObservation() {
  const samples = [], errors = [];
  let stopped = false, timer, pending;
  const sample = async () => {
    try {
      const state = await window.__TAURI_INTERNALS__.invoke('get_player_state');
      samples.push({ at: Date.now(), ...state });
    } catch (error) {
      errors.push({ at: Date.now(), message: String(error?.message ?? error) });
    }
    // Schedule after resolution so native IPC requests never overlap.
    if (!stopped) timer = setTimeout(() => { pending = sample(); }, 50);
  };
  pending = sample();
  window.__nativePlaybackObservation = {
    read() { return samples.map(sample => ({ ...sample })); },
    async stop() {
      stopped = true;
      clearTimeout(timer);
      await pending;
      return { samples, errors };
    },
  };
}

export function summarizeNativePlayback(samples, { startMs, endMs }) {
  const duration = endMs - startMs;
  let advancedMs = 0, wraps = 0;
  for (let index = 1; index < samples.length; index++) {
    const delta = samples[index].positionMs - samples[index - 1].positionMs;
    const wrapped = delta < -duration / 2;
    if (wrapped) wraps++;
    advancedMs += delta + (wrapped ? duration : 0);
  }
  return { advancedMs, wraps };
}
