// SPDX-License-Identifier: GPL-3.0-or-later
export const nativeSpecs = Object.freeze([
  { name: 'ai-recovery', platforms: ['win32', 'linux'] },
  { name: 'draft-study', platforms: ['win32', 'linux'] },
  { name: 'learning-continuity', platforms: ['win32'] },
  { name: 'library-import', platforms: ['win32'] },
  { name: 'media-management', platforms: ['win32'] },
  { name: 'motion', platforms: ['win32'] },
  { name: 'phrase-inspection', platforms: ['win32'] },
  { name: 'playback-rate', platforms: ['win32', 'linux'] },
  { name: 'rendering-occlusion', platforms: ['win32'] },
  { name: 'replay-context', platforms: ['win32'] },
  { name: 'sentence-playback', platforms: ['win32'] },
  { name: 'study', platforms: ['win32', 'linux'] },
  { name: 'transcript-review', platforms: ['win32', 'linux'] },
  { name: 'window-state', platforms: ['win32'] },
]);

export function nativeSpecsForPlatform(platform = process.platform) {
  if (!['win32', 'linux'].includes(platform)) throw new Error(`Unsupported native test platform: ${platform}`);
  return nativeSpecs.filter(spec => spec.platforms.includes(platform)).map(spec => `./e2e/native/${spec.name}.e2e.js`);
}

// `win32` is Node's name, not the W3C capability. Do not supply browserName:
// tauri-driver sets webview2 on Windows and negotiates WebKitGTK on Linux.
export const nativePlatformName = platform => platform === 'win32' ? 'windows' : platform === 'linux' ? 'linux' : undefined;
