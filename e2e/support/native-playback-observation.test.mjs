// SPDX-License-Identifier: GPL-3.0-or-later
import assert from 'node:assert/strict';
import { afterEach, test, vi } from 'vitest';
import { startNativePlaybackObservation, summarizeNativePlayback } from './native-playback-observation.mjs';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

test('counts observed repeat wraps when the final position is behind the initial position', () => {
  const samples = [2700, 3100, 350, 950, 2600, 3150, 250, 700].map(positionMs => ({ positionMs }));
  assert.deepEqual(summarizeNativePlayback(samples, { startMs: 200, endMs: 3200 }), { advancedMs: 4000, wraps: 2 });
  assert.deepEqual(summarizeNativePlayback([{ positionMs: 600 }, { positionMs: 600 }], { startMs: 200, endMs: 3200 }),
    { advancedMs: 0, wraps: 0 });
});

test('samples serial native state during an in-flight request and drains it before stopping', async () => {
  vi.useFakeTimers();
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const playing = { positionMs: 300, paused: false, surfaceVisible: true, error: null };
  const interrupted = { positionMs: 500, paused: true, surfaceVisible: false, error: 'decoder failed' };
  const invoke = vi.fn().mockResolvedValueOnce(playing).mockReturnValueOnce(pending);
  vi.stubGlobal('window', { __TAURI_INTERNALS__: { invoke } });
  startNativePlaybackObservation();
  assert(window.__nativePlaybackObservation, 'The browser sampler must expose its cleanup handle');
  await vi.advanceTimersByTimeAsync(50);
  assert.equal(invoke.mock.calls.length, 2);
  await vi.advanceTimersByTimeAsync(500);
  assert.equal(invoke.mock.calls.length, 2, 'A slow native IPC request must not overlap another sample');
  const snapshot = window.__nativePlaybackObservation.read();
  assert.deepEqual(snapshot.map(({ at, ...state }) => state), [playing]);
  snapshot[0].paused = true;
  snapshot.length = 0;
  let stopped = false;
  const stopping = window.__nativePlaybackObservation.stop().then(result => { stopped = true; return result; });
  await Promise.resolve();
  assert.equal(stopped, false);
  release(interrupted);
  const observed = await stopping;
  assert.deepEqual(observed.samples.map(({ at, ...state }) => state), [playing, interrupted]);
  assert.deepEqual(observed.errors, []);
  assert.equal(vi.getTimerCount(), 0);
  await vi.advanceTimersByTimeAsync(500);
  assert.equal(invoke.mock.calls.length, 2, 'Stopping must prevent later native requests');
});

test('retains an IPC rejection in diagnostics and cancels the pending sample timer', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('window', { __TAURI_INTERNALS__: { invoke: async () => { throw new Error('native unavailable'); } } });
  startNativePlaybackObservation();
  assert(window.__nativePlaybackObservation, 'The browser sampler must expose its cleanup handle');
  await vi.advanceTimersByTimeAsync(0);
  const observed = await window.__nativePlaybackObservation.stop();
  assert.deepEqual(observed.samples, []);
  assert.equal(observed.errors[0].message, 'native unavailable');
  assert.equal(vi.getTimerCount(), 0);
});
