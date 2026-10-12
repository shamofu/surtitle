// SPDX-License-Identifier: GPL-3.0-or-later
// Seconds for Motion; CSS and WAAPI derive milliseconds from the same values.
export const motionDurations = {
  press: .08, release: .14, fast: .12, swap: .12, caption: .14,
  content: .18, reveal: .18, selection: .26, enter: .24, exit: .18,
  panelOpen: .24, panelClose: .18, studyResize: .2, studySlide: .14, review: .22, success: .16,
  spin: 1.1, progress: 1.6,
} as const;
export const motionEase = [.33, 1, .68, 1] as const;
export const motionRevealEase = [.65, 0, .35, 1] as const;
export const motionExitEase = [.32, 0, .67, 0] as const;
export const motionCssEase = `cubic-bezier(${motionEase.join(', ')})`;
export const motionCssRevealEase = `cubic-bezier(${motionRevealEase.join(', ')})`;
export const motionCssExitEase = `cubic-bezier(${motionExitEase.join(', ')})`;
export const motionPresets = {
  swap: { duration: motionDurations.swap, x: 0, y: 0 },
  page: { duration: motionDurations.content, x: 0, y: 6 },
  panel: { duration: motionDurations.enter, x: 8, y: 0 },
  modal: { duration: motionDurations.content, x: 0, y: 4 },
  caption: { duration: motionDurations.caption, x: 0, y: 0 },
  toast: { duration: motionDurations.enter, x: 0, y: -8 },
} as const;
export type MotionPreset = keyof typeof motionPresets;
export const motionVariables = {
  ...Object.fromEntries(Object.entries(motionDurations).map(([name, seconds]) => [`--motion-${name}`, `${seconds * 1000}ms`])),
  '--motion-ease': motionCssEase,
  '--motion-reveal-ease': motionCssRevealEase,
  '--motion-exit-ease': motionCssExitEase,
};
