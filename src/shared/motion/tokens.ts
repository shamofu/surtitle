// SPDX-License-Identifier: GPL-3.0-or-later
// Motion Reference recipes are adapted to the desktop UI; all timings are seconds.
export const motionDurations = {
  press: .08, release: .18, fast: .12, swap: .16, caption: 0,
  content: .22, reveal: .24, revealClose: .18, selection: .28, enter: .22, exit: .14,
  modal: .18, panelOpen: .28, panelClose: .20, studyResize: .16, studySlide: .12,
  studyCollapse: .10, studySlideOut: .10, tab: .22, review: .26, success: .18,
  toastEnter: .28, toastExit: .20, toastReflow: .22,
  spin: 1.1, progress: 1.6, progressFollow: .16,
} as const;
export const motionReferences = {
  press: 'press-feedback', selection: 'tab-indicator', tab: 'route-slide', panel: 'sidebar-reveal',
  disclosure: 'auto-height-expand', page: 'snap-in', modal: 'snap-in', list: 'filter-reflow',
  review: 'mask-wipe', toast: 'ui-toast', toastReflow: 'toast-stack', success: 'checkbox-stroke',
  caption: 'tx-pop-on-subtitle', progress: 'progress-fill', spinner: 'spinner-arc',
} as const;
export const motionDistances = { page: 8, panel: 8, modal: 4, tab: 16, toast: 12 } as const;
export const motionScales = { press: .97 } as const;
export const motionEase = [.33, 1, .68, 1] as const;
export const motionSnapEase = [.16, 1, .3, 1] as const;
export const motionRevealEase = [.65, 0, .35, 1] as const;
export const motionExitEase = [.32, 0, .67, 0] as const;
export const motionLayoutTransition = { type: 'spring', visualDuration: .28, bounce: .08 } as const;
export const motionToastTransition = { type: 'spring', visualDuration: .28, bounce: .08 } as const;
export const motionCssEase = `cubic-bezier(${motionEase.join(', ')})`;
export const motionCssRevealEase = `cubic-bezier(${motionRevealEase.join(', ')})`;
export const motionCssExitEase = `cubic-bezier(${motionExitEase.join(', ')})`;
export const motionPresets = {
  swap: { duration: motionDurations.swap, x: 0, y: 0 },
  page: { duration: motionDurations.content, x: 0, y: motionDistances.page },
  panel: { duration: motionDurations.enter, x: motionDistances.panel, y: 0 },
  modal: { duration: motionDurations.modal, x: 0, y: motionDistances.modal },
  caption: { duration: motionDurations.caption, x: 0, y: 0 },
  toast: { duration: motionDurations.toastEnter, x: 0, y: motionDistances.toast },
} as const;
export type MotionPreset = keyof typeof motionPresets;
export const motionVariables = {
  ...Object.fromEntries(Object.entries(motionDurations).map(([name, seconds]) => [`--motion-${name}`, `${seconds * 1000}ms`])),
  '--motion-ease': motionCssEase,
  '--motion-reveal-ease': motionCssRevealEase,
  '--motion-exit-ease': motionCssExitEase,
};
