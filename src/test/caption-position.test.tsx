// SPDX-License-Identifier: GPL-3.0-or-later
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import type { SubtitleSegment } from '../shared/contracts/media';
import { useCaptionPosition } from '../features/study/playback/useCaptionPosition';

afterEach(cleanup);
const cue = (startMs: number, endMs: number): SubtitleSegment => ({ id: String(startMs), mediaId: 'm', startMs, endMs, text: 'A sentence' });

it('isolates high-frequency clocks while updating every subtitle, overlap, and gap boundary', () => {
  const segments = [cue(1000, 3000), cue(2000, 4000), cue(5000, 6000)];
  let renders = 0;
  const { result } = renderHook(() => { renders++; return useCaptionPosition(segments, 1000); });
  for (let time = 1010; time < 2000; time += 10) act(() => result.current[1](time));
  expect(renders).toBe(1);
  for (const time of [2000, 3000, 4000, 5000, 6000]) {
    act(() => result.current[1](time));
    expect(result.current[0]).toBe(time);
  }
  expect(renders).toBe(6);
  act(() => result.current[1](1500));
  expect(result.current[0]).toBe(1500);
});

it('keeps the current clock when incoming subtitles replace the boundary index', () => {
  const { result, rerender } = renderHook(({ segments }) => useCaptionPosition(segments, 0), { initialProps: { segments: [cue(0, 5000)] } });
  act(() => result.current[1](2000));
  rerender({ segments: [cue(0, 1000), cue(1500, 2500)] });
  expect(result.current[0]).toBe(2000);
  act(() => result.current[1](2500));
  expect(result.current[0]).toBe(2500);
});
