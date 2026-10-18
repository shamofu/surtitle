// SPDX-License-Identifier: GPL-3.0-or-later
// Motion Reference recipes are adapted to the desktop UI; all timings are seconds.
export const motionDurations = {
  press: .10, release: .24, fast: .20, swap: .24, caption: 0,
  content: .38, reveal: .34, revealClose: .26, selection: .38, enter: .34, exit: .24,
  modal: .30, panelOpen: .40, panelClose: .32, studyResize: .30, studySlide: .24,
  studyCollapse: .24, studySlideOut: .24, tab: .36, review: .38, success: .30,
  menuOpen: .30, menuClose: .24,
  toastEnter: .38, toastExit: .28, toastReflow: .32,
  spin: 1.1, progress: 1.6, progressFollow: .16,
} as const;
export const motionReferences = {
  press: 'press-feedback', selection: 'tab-indicator', tab: 'route-slide', panel: 'sidebar-reveal',
  disclosure: 'auto-height-expand', page: 'snap-in', modal: 'snap-in', list: 'filter-reflow',
  review: 'mask-wipe', toast: 'ui-toast', toastReflow: 'toast-stack', success: 'checkbox-stroke',
  caption: 'tx-pop-on-subtitle', progress: 'progress-fill', spinner: 'spinner-arc',
} as const;
export const motionDistances = { page: 48, panel: 24, modal: 48, tab: 32, toast: 24, menu: 24 } as const;
export const motionScales = { press: .94, hover: 1.025 } as const;
export const motionEase = [.33, 1, .68, 1] as const;
export const motionSnapEase = [.22, .61, .36, 1] as const;
export const motionRevealEase = [.65, 0, .35, 1] as const;
export const motionExitEase = [.32, 0, .67, 0] as const;
export const motionLayoutTransition = { type: 'spring', visualDuration: .38, bounce: .14 } as const;
export const motionToastTransition = { type: 'spring', visualDuration: .38, bounce: .14 } as const;
export const motionCssEase = `cubic-bezier(${motionEase.join(', ')})`;
export const motionCssRevealEase = `cubic-bezier(${motionRevealEase.join(', ')})`;
export const motionCssExitEase = `cubic-bezier(${motionExitEase.join(', ')})`;
export const motionPresets = {
  swap: { duration: motionDurations.swap, x: 0, y: 0 },
  page: { duration: motionDurations.content, x: motionDistances.page, y: 0 },
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
