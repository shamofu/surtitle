// SPDX-License-Identifier: GPL-3.0-or-later
import type { Page } from '@playwright/test';
import type { AppSnapshot } from '../../src/shared/contracts/snapshot';
import type { SubtitleSegment } from '../../src/shared/contracts/media';

// This fixture is installed only by Playwright through request interception.
// The ordinary browser preview continues to have no fabricated native state.
export async function installLearningFixture(page: Page, locale: 'ja' | 'en', theme: 'light' | 'dark') {
  const media = {
    id: 'visual-fixture', title: 'A walk along the coast', path: 'test-fixture.mp4',
    kind: 'video' as const, durationMs: 840000, lastPositionMs: 76000,
    learningLanguage: 'en', explanationLanguage: 'ja', status: 'ready' as const,
    createdAt: '2026-09-01T00:00:00Z', segmentCount: 120, cardCount: 2,
  };
  const segments: SubtitleSegment[] = Array.from({ length: 120 }, (_, index) => ({
    id: `visual-cue-${index}`, mediaId: media.id, startMs: index * 7000, endMs: (index + 1) * 7000,
    text: index === 10 ? 'Sometimes the best way to find your way is to take a little detour.' : [
      'We took the path that follows the coast.', 'There is no need to hurry.',
      'The sea looks different every morning.', 'Let’s stop here for a moment.',
    ][index % 4],
    translation: index === 10 ? '少し寄り道をすることが、自分の道を見つける一番の方法になることもある。' : '海岸に沿った小道を歩きました。',
    status: 'confirmed',
  }));
  const snapshot: AppSnapshot = {
    media: [media, { ...media, id: 'audio-fixture', title: 'Coffee and a conversation', kind: 'audio', lastPositionMs: 0, cardCount: 0 }],
    cards: [{
      id: 'phrase-fixture', mediaId: media.id, segmentId: segments[10].id, term: 'take a little detour',
      meaning: '少し寄り道をする', example: segments[10].text, language: 'en',
      translation: segments[10].translation, explanation: '予定していた道から少し外れること。会話では、話題が横道にそれる場合にも使えます。',
      sourceTitle: media.title, createdAt: '2026-09-01T00:00:00Z', dueAt: '2026-09-01T00:00:00Z',
      reviewCount: 2, suspended: false, audioPath: 'test-phrase.wav',
    }],
    settings: { locale, theme, learningLanguage: 'en', explanationLanguage: 'ja', dailyBudgetUsd: 0,
      vertexProject: '', vertexLocation: 'global', credentialConfigured: false, retention: 0.9,
      replayContextMs: 150, sentencePause: false, proficiency: 'B1', aiModels: {}, ytDlpChannel: 'nightly' },
    jobs: [], budget: { spentUsd: 0, reservedUsd: 0, limitUsd: 0 },
    tools: [{ id: 'ffmpeg', name: 'FFmpeg', provider: 'external', status: 'ready', canRollback: false, version: '8.0' }],
  };
  await page.addInitScript(({ snapshot, segments }) => {
    const state = { ready: true, positionMs: 76000, durationMs: 840000, paused: true, rate: 1, volume: 80, tracks: [], sentencePause: false };
    const subscribers = new Map<string, Set<(event: { payload: unknown }) => void>>();
    const closeSubscribers = new Set<() => boolean>();
    const calls: { command: string; args: Record<string, any> }[] = [];
    let closeCount = 0;
    const publish = (event: string, payload: unknown) => subscribers.get(event)?.forEach(callback => callback({ payload }));
    localStorage.setItem('surtitle-review-notified-day', new Date().toLocaleDateString('en-CA'));
    Object.assign(window, { __learningFixture: {
      calls,
      state,
      subscribeClose(callback: () => boolean) { closeSubscribers.add(callback); return () => closeSubscribers.delete(callback); },
      requestClose() { return [...closeSubscribers].some(callback => callback()); },
      async close() { closeCount += 1; },
      closeCount() { return closeCount; },
      subscribe(event: string, callback: (event: { payload: unknown }) => void) {
        const listeners = subscribers.get(event) ?? new Set();
        subscribers.set(event, listeners); listeners.add(callback);
        return () => listeners.delete(callback);
      },
      async call(command: string, args: Record<string, any> = {}) {
        calls.push({ command, args });
        if (command === 'get_app_snapshot') return structuredClone(snapshot);
        if (command === 'list_segments') return structuredClone(segments);
        if (['list_vocabulary_candidates', 'list_draft_selections', 'list_download_jobs', 'scan_external_tools'].includes(command)) return [];
        if (command === 'load_media') return;
        if (command === 'get_player_state') return { ...state };
        if (command === 'update_appearance') { Object.assign(snapshot.settings, args); return; }
        if (command === 'player_control') {
          const request = args.request;
          if (request.action === 'pause') state.paused = true;
          if (request.action === 'play') state.paused = false;
          if (request.action === 'seek') state.positionMs = request.value;
          if (request.action === 'source-seek') {
            state.positionMs = Math.max(0, request.startMs - (snapshot.settings.replayContextMs ?? 0));
            state.paused = false;
          }
          if (request.action === 'rate') state.rate = request.value;
          if (request.action === 'volume') state.volume = request.value;
          if (request.action === 'sentence-pause') state.sentencePause = request.value === 1;
          publish('player-state', { ...state });
          return;
        }
        throw new Error(`Unimplemented visual-test command: ${command}`);
      },
    } });
  }, { snapshot, segments });
  await page.route(/\/src\/shared\/native\/transport\.ts(?:\?|$)/, route => route.fulfill({
    contentType: 'application/javascript', body: 'export const nativeAvailable = () => true; export const call = (command, args) => window.__learningFixture.call(command, args);',
  }));
  await page.route(/\/src\/shared\/native\/events\.ts(?:\?|$)/, route => route.fulfill({
    contentType: 'application/javascript', body: 'export const subscribeNative = (event, callback) => window.__learningFixture.subscribe(event, callback);',
  }));
  await page.route(/\/src\/shared\/native\/window\.ts(?:\?|$)/, route => route.fulfill({
    contentType: 'application/javascript', body: 'export const subscribeWindowClose = callback => window.__learningFixture.subscribeClose(callback); export const closeWindow = () => window.__learningFixture.close();',
  }));
}
