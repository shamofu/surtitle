// SPDX-License-Identifier: GPL-3.0-or-later
import { createContext, useContext, useState, useSyncExternalStore, type ReactNode } from 'react';
import type { AiModelPreference, AiQuote, TranscriptionPreparation } from '../../shared/contracts/ai';

export interface PreparationScope {
  mediaId: string;
  sourceSignature: string;
  startMs: number;
  endMs: number;
  wholeMedia: boolean;
}

interface PreparationSession {
  operationId: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  promise: Promise<TranscriptionPreparation>;
  result?: TranscriptionPreparation;
  invalidate: () => void;
}

interface EstimateSession {
  promise: Promise<AiQuote>;
  result?: AiQuote;
  invalidate: () => void;
}

const invalidated = () => new Error('Audio preparation and estimates were invalidated after restoring data.');

const scopeKey = (scope: PreparationScope) => JSON.stringify([
  scope.mediaId, scope.sourceSignature, scope.startMs, scope.endMs, scope.wholeMedia,
]);

function audioScope(scope: PreparationScope, streamIndex: number | null) {
  try {
    const source: unknown = JSON.parse(scope.sourceSignature);
    if (!Array.isArray(source) || source.length !== 4 || typeof source[0] !== 'string') return;
    return { ...scope, sourceSignature: JSON.stringify([source[0], streamIndex, source[2], source[3]]) };
  } catch { return; }
}
function audioIndex(scope: PreparationScope): number | null | undefined {
  try { return JSON.parse(scope.sourceSignature)[1] as number | null; } catch { return undefined; }
}

/** An initially automatic choice is the same source only if the receipt confirms it. */
export function preparedSourceMatches(original: string, current: string, preparation: TranscriptionPreparation) {
  if (original === current) return true;
  if (preparation.audioStreamIndex === undefined) return false;
  try {
    const source: unknown = JSON.parse(original);
    if (!Array.isArray(source) || source.length !== 4 || source[1] != null) return false;
    return JSON.stringify([source[0], preparation.audioStreamIndex, source[2], source[3]]) === current;
  } catch { return false; }
}

/** Own pending native requests at the app root, so route unmounts never restart them. */
export function createPreparationSessions() {
  const sessions = new Map<string, PreparationSession>();
  const estimates = new Map<string, EstimateSession>();
  const aliases = new Map<string, string>();
  const listeners = new Set<() => void>();
  let revision = 0;
  const publish = () => listeners.forEach(listener => listener());
  const keyFor = (scope: PreparationScope) => aliases.get(scopeKey(scope)) ?? scopeKey(scope);
  const pendingAutomaticSelection = (scope: PreparationScope) => {
    if (typeof audioIndex(scope) !== 'number') return;
    const automatic = audioScope(scope, null);
    const pending = automatic && sessions.get(scopeKey(automatic));
    return pending?.status === 'running' ? pending : undefined;
  };
  const store = {
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    get(scope: PreparationScope) { return sessions.get(keyFor(scope)) ?? pendingAutomaticSelection(scope); },
    revision: () => revision,
    clear() {
      for (const session of sessions.values()) session.invalidate();
      for (const estimate of estimates.values()) estimate.invalidate();
      revision += 1;
      sessions.clear(); estimates.clear(); aliases.clear(); publish();
    },
    estimate(scope: PreparationScope, model: AiModelPreference, action: () => Promise<AiQuote>, fresh = false) {
      const key = JSON.stringify([keyFor(scope), model]);
      const existing = estimates.get(key);
      if (existing && (!existing.result || (!fresh && Date.parse(existing.result.expiresAt) > Date.now()))) return existing.promise;
      let resolve!: (value: AiQuote) => void;
      let reject!: (error: unknown) => void;
      const promise = new Promise<AiQuote>((ok, fail) => { resolve = ok; reject = fail; });
      const entry: EstimateSession = { promise, invalidate: () => reject(invalidated()) };
      estimates.set(key, entry);
      void Promise.resolve().then(() => {
        if (estimates.get(key) !== entry) throw invalidated();
        return action();
      }).then(result => {
        if (estimates.get(key) !== entry) { reject(invalidated()); return; }
        entry.result = result;
        const finished = [...estimates.entries()].filter(([, item]) => item.result);
        for (const [oldKey] of finished.slice(0, Math.max(0, finished.length - 20))) estimates.delete(oldKey);
        resolve(result);
      }, error => { if (estimates.get(key) === entry) estimates.delete(key); reject(error); });
      return promise;
    },
    forgetEstimate(scope: PreparationScope) {
      for (const key of estimates.keys()) if (JSON.parse(key)[0] === keyFor(scope)) estimates.delete(key);
    },
    prepare(scope: PreparationScope, action: (operationId: string) => Promise<TranscriptionPreparation>): Promise<TranscriptionPreparation> {
      const key = keyFor(scope);
      const existing = sessions.get(key);
      if (existing && (existing.status === 'running' || existing.status === 'completed')) return existing.promise;
      // ensure_audio_stream persists its automatic choice before extraction finishes.
      // Wait for that receipt, and only reuse it when it confirms this exact stream.
      const automatic = pendingAutomaticSelection(scope);
      if (automatic) return automatic.promise.then(result => result.audioStreamIndex === audioIndex(scope) ? result : store.prepare(scope, action));
      const operationId = crypto.randomUUID();
      // Install before calling native code, including when two consumers start in one turn.
      let resolve!: (value: TranscriptionPreparation) => void;
      let reject!: (error: unknown) => void;
      const promise = new Promise<TranscriptionPreparation>((ok, fail) => { resolve = ok; reject = fail; });
      const session: PreparationSession = { operationId, status: 'running', promise, invalidate: () => reject(invalidated()) };
      sessions.set(key, session);
      publish();
      const settle = (status: PreparationSession['status'], result?: TranscriptionPreparation) => {
        if (sessions.get(key) !== session) return;
        if (result?.audioStreamIndex !== undefined && audioIndex(scope) == null) {
          const resolved = audioScope(scope, result.audioStreamIndex);
          if (resolved) aliases.set(scopeKey(resolved), key);
        }
        sessions.set(key, { ...session, status, result });
        const finished = [...sessions.entries()].filter(([, item]) => item.status !== 'running');
        for (const [oldKey] of finished.slice(0, Math.max(0, finished.length - 20))) {
          sessions.delete(oldKey);
          for (const [alias, target] of aliases) if (target === oldKey) aliases.delete(alias);
        }
        publish();
      };
      try {
        void action(operationId).then(result => { settle('completed', result); resolve(result); }, error => {
          settle(/cancelled|canceled/i.test(String(error)) ? 'cancelled' : 'failed'); reject(error);
        });
      } catch (error) {
        settle('failed'); reject(error);
      }
      return promise;
    },
  };
  return store;
}

type PreparationSessions = ReturnType<typeof createPreparationSessions>;
const Context = createContext<PreparationSessions | null>(null);
export function PreparationSessionsProvider({ children }: { children: ReactNode }) {
  const [sessions] = useState(createPreparationSessions);
  return <Context.Provider value={sessions}>{children}</Context.Provider>;
}

export function usePreparationSession(scope: PreparationScope) {
  const sessions = useContext(Context);
  if (!sessions) throw new Error('PreparationSessionsProvider missing');
  const session = useSyncExternalStore(sessions.subscribe, () => sessions.get(scope));
  const revision = useSyncExternalStore(sessions.subscribe, sessions.revision);
  return { session, revision,
    prepare: (action: (operationId: string) => Promise<TranscriptionPreparation>) => sessions.prepare(scope, action),
    estimate: (model: AiModelPreference, action: () => Promise<AiQuote>, fresh = false) => sessions.estimate(scope, model, action, fresh),
    forgetEstimate: () => sessions.forgetEstimate(scope),
  };
}

export function useClearPreparationSessions() {
  const sessions = useContext(Context);
  if (!sessions) throw new Error('PreparationSessionsProvider missing');
  return sessions.clear;
}
