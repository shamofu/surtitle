// SPDX-License-Identifier: GPL-3.0-or-later
import type { Page } from '@playwright/test';
import type { AppSnapshot } from '../../src/shared/contracts/snapshot';
import type { SubtitleSegment } from '../../src/shared/contracts/media';
import type { AiContinuation } from '../../src/features/ai/continuations';
import type { EditorDraft, EditorDraftInput, EditorDraftReference } from '../../src/features/study/editor-drafts/api';

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
    const storageKey = 'surtitle-browser-learning-fixture';
    const editorDrafts = new Map<string, EditorDraft>();
    const continuations = new Map<string, AiContinuation>();
    const stored = localStorage.getItem(storageKey);
    if (stored) {
      const saved = JSON.parse(stored) as {
        snapshot: AppSnapshot; segments: SubtitleSegment[];
        editorDrafts: EditorDraft[]; continuations: AiContinuation[];
      };
      Object.assign(snapshot, saved.snapshot);
      segments.splice(0, segments.length, ...saved.segments);
      saved.editorDrafts.forEach(draft => editorDrafts.set(draft.id, draft));
      saved.continuations.forEach(item => continuations.set(item.id, item));
    }
    const persist = () => localStorage.setItem(storageKey, JSON.stringify({
      snapshot, segments, editorDrafts: [...editorDrafts.values()], continuations: [...continuations.values()],
    }));
    const currentMedia = (mediaId: string) => {
      const item = snapshot.media.find(media => media.id === mediaId);
      if (!item) throw new Error('Media not found');
      return item;
    };
    const mediaSignature = (mediaId: string) => {
      const item = currentMedia(mediaId);
      return JSON.stringify([item.path, item.learningLanguage, item.audioStreamIndex ?? null]);
    };
    const comparable = (value: unknown): string => JSON.stringify(value, (_key, item) => {
      if (item && typeof item === 'object' && !Array.isArray(item)) {
        return Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]]));
      }
      return item;
    });
    const draftView = (draft: EditorDraft): EditorDraft => {
      const item = currentMedia(draft.mediaId);
      const original = draft.sourceMediaSignature ? JSON.parse(draft.sourceMediaSignature) as [string, string, number | null] : null;
      const stale = !draft.bindingVerified || !original || original[0] !== item.path
        || original[1] !== item.learningLanguage
        || (original[2] !== null && original[2] !== (item.audioStreamIndex ?? null))
        || draft.sourceCues.some(cue => comparable(segments.find(current => current.id === cue.id)) !== comparable(cue));
      return structuredClone({ ...draft, stale });
    };
    const checkedDraft = (reference: EditorDraftReference, kind?: EditorDraft['kind']) => {
      const draft = editorDrafts.get(reference.id);
      if (!draft || draft.version !== reference.version || (kind && draft.kind !== kind)) {
        throw new Error('Editor draft changed; reload it without discarding your input');
      }
      if (kind && draftView(draft).stale) throw new Error('The source changed; reconnect this draft to the current subtitles');
      return draft;
    };
    const validateSource = (kind: EditorDraft['kind'], mediaId: string, cues: SubtitleSegment[]) => {
      if (!cues.length || cues.length > 64 || (kind === 'subtitle' && cues.length !== 1)
        || new Set(cues.map(cue => cue.id)).size !== cues.length
        || cues.some(cue => cue.mediaId !== mediaId || cue.startMs < 0 || cue.endMs <= cue.startMs)) {
        throw new Error('Invalid editor draft source');
      }
    };
    const validateFields = (request: EditorDraftInput) => {
      const keys = request.kind === 'phrase' ? ['term', 'meaning', 'example', 'explanation']
        : request.kind === 'subtitle' ? ['start', 'end', 'text', 'translation'] : [];
      if (!keys.length || Object.keys(request.fields).length !== keys.length
        || keys.some(key => typeof request.fields[key] !== 'string' || request.fields[key].length > 64 * 1024)) {
        throw new Error('Invalid editor draft fields');
      }
    };
    const checkedPhraseCues = (mediaId: string, ids: string[]) => {
      const all = segments.filter(cue => cue.mediaId === mediaId);
      const first = all.findIndex(cue => cue.id === ids[0]);
      const cues = all.slice(first, first + ids.length);
      if (!ids.length || ids.length > 64 || first < 0 || cues.length !== ids.length
        || cues.some((cue, index) => cue.id !== ids[index] || (cue.status && !['confirmed', 'generated', 'generated_review'].includes(cue.status)))) {
        throw new Error('Invalid phrase source cues');
      }
      return cues;
    };
    const state = { ready: true, positionMs: 76000, durationMs: 840000, paused: true, rate: 1, volume: 80, tracks: [], sentencePause: false };
    const subscribers = new Map<string, Set<(event: { payload: unknown }) => void>>();
    const closeSubscribers = new Set<() => boolean>();
    const calls: { command: string; args: Record<string, any> }[] = [];
    let closeCount = 0;
    let draftSaveFailure: string | null = null;
    const publish = (event: string, payload: unknown) => subscribers.get(event)?.forEach(callback => callback({ payload }));
    localStorage.setItem('surtitle-review-notified-day', new Date().toLocaleDateString('en-CA'));
    Object.assign(window, { __learningFixture: {
      calls,
      state,
      setDraftSaveFailure(message: string | null) { draftSaveFailure = message; },
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
        if (command === 'list_segments') return structuredClone(segments.filter(cue => !args.mediaId || cue.mediaId === args.mediaId));
        if (['list_vocabulary_candidates', 'list_draft_selections', 'list_download_jobs', 'list_operation_progress', 'scan_external_tools', 'list_transcript_issues'].includes(command)) return [];
        if (command === 'list_ai_continuations') return structuredClone([...continuations.values()]
          .filter(item => snapshot.media.some(media => media.id === item.mediaId))
          .sort((left, right) => (right.updatedAtMs ?? 0) - (left.updatedAtMs ?? 0)));
        if (command === 'save_ai_continuation') {
          const item: AiContinuation = { ...structuredClone(args.continuation), updatedAtMs: Date.now() };
          currentMedia(item.mediaId);
          continuations.set(item.id, item); persist();
          return structuredClone(item);
        }
        if (command === 'discard_ai_continuation') { continuations.delete(args.id); persist(); return; }
        if (command === 'list_editor_drafts') return [...editorDrafts.values()]
          .filter(draft => draft.mediaId === args.mediaId).map(draftView);
        if (command === 'save_editor_draft') {
          if (draftSaveFailure) throw new Error(draftSaveFailure);
          const request = args.request as EditorDraftInput;
          currentMedia(request.mediaId);
          validateFields(request);
          validateSource(request.kind, request.mediaId, request.sourceCues);
          let draft: EditorDraft;
          if (request.expectedVersion === 0) {
            if (editorDrafts.has(request.id) || [...editorDrafts.values()].some(current => current.mediaId === request.mediaId
              && current.kind === request.kind && current.sourceKey === request.sourceKey)) {
              throw new Error('Editor draft already exists');
            }
            const now = new Date().toISOString();
            draft = { id: request.id, mediaId: request.mediaId, kind: request.kind, sourceKey: request.sourceKey,
              version: 1, fields: structuredClone(request.fields), sourceCues: structuredClone(request.sourceCues),
              sourceMediaSignature: mediaSignature(request.mediaId), bindingVerified: true, stale: false,
              createdAt: now, updatedAt: now };
          } else {
            const current = checkedDraft({ id: request.id, version: request.expectedVersion });
            if (current.mediaId !== request.mediaId || current.kind !== request.kind || current.sourceKey !== request.sourceKey) {
              throw new Error('Editor draft identity changed');
            }
            draft = { ...current, fields: structuredClone(request.fields), version: current.version + 1,
              updatedAt: new Date().toISOString() };
          }
          editorDrafts.set(draft.id, draft); persist();
          return draftView(draft);
        }
        if (command === 'delete_editor_draft') {
          checkedDraft(args.reference); editorDrafts.delete(args.reference.id); persist(); return;
        }
        if (command === 'rebind_editor_draft') {
          const current = checkedDraft(args.reference);
          const sourceCues = args.sourceCues as SubtitleSegment[];
          validateSource(current.kind, current.mediaId, sourceCues);
          if (current.kind === 'phrase') checkedPhraseCues(current.mediaId, sourceCues.map(cue => cue.id));
          const draft = { ...current, sourceCues: structuredClone(sourceCues), sourceKey: JSON.stringify(sourceCues.map(cue => cue.id)),
            sourceMediaSignature: mediaSignature(current.mediaId), bindingVerified: true,
            version: current.version + 1, updatedAt: new Date().toISOString() };
          if (draftView(draft).stale) throw new Error('The source changed again; reload the current subtitles');
          if ([...editorDrafts.values()].some(other => other.id !== draft.id && other.mediaId === draft.mediaId
            && other.kind === draft.kind && other.sourceKey === draft.sourceKey)) throw new Error('Editor draft already exists');
          editorDrafts.set(draft.id, draft); persist();
          return draftView(draft);
        }
        if (command === 'commit_subtitle_editor_draft') {
          const draft = checkedDraft(args.reference, 'subtitle');
          const segment = args.segment as SubtitleSegment;
          const index = segments.findIndex(cue => cue.id === segment.id);
          if (index < 0 || draft.sourceCues[0].id !== segment.id || draft.mediaId !== segment.mediaId
            || !segment.text.trim() || !Number.isSafeInteger(segment.startMs) || !Number.isSafeInteger(segment.endMs)
            || segment.startMs < 0 || segment.endMs <= segment.startMs) throw new Error('Invalid subtitle editor source or segment');
          segments[index] = structuredClone({ ...segment, status: 'confirmed' });
          editorDrafts.delete(draft.id); persist();
          return null;
        }
        if (command === 'save_phrase_editor_draft') {
          const draft = checkedDraft(args.reference, 'phrase');
          const request = args.request;
          const ids: string[] = request.sourceCueIds?.length ? request.sourceCueIds : [request.segmentId];
          if (draft.mediaId !== request.mediaId || ids[0] !== request.segmentId
            || comparable(draft.sourceCues.map(cue => cue.id)) !== comparable(ids)
            || !request.term.trim() || request.term.length >= 4096) throw new Error('Invalid phrase editor source or term');
          const cues = checkedPhraseCues(request.mediaId, ids);
          const item = currentMedia(request.mediaId);
          const now = new Date().toISOString();
          const translation = cues.every(cue => cue.translation?.trim()) ? cues.map(cue => cue.translation).join('\n') : undefined;
          snapshot.cards.push({ id: crypto.randomUUID(), mediaId: item.id, segmentId: request.segmentId,
            term: request.term.trim(), meaning: request.meaning, example: request.example, explanation: request.explanation,
            translation: request.translation ?? translation, language: item.learningLanguage,
            sourceTitle: item.title, sourceUrl: item.sourceUrl, sourceCues: structuredClone(cues),
            createdAt: now, dueAt: now, reviewCount: 0, suspended: false });
          item.cardCount += 1;
          editorDrafts.delete(draft.id); persist(); return;
        }
        if (command === 'load_media') return;
        if (command === 'get_player_state') return { ...state };
        if (command === 'update_appearance') { Object.assign(snapshot.settings, args); persist(); return; }
        if (command === 'update_settings') { Object.assign(snapshot.settings, structuredClone(args.settings)); persist(); return; }
        if (command === 'edit_card') {
          const card = snapshot.cards.find(item => item.id === args.request.id);
          if (!card) throw new Error('Phrase not found');
          Object.assign(card, structuredClone(args.request)); persist(); return;
        }
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
