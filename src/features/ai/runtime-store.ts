// SPDX-License-Identifier: GPL-3.0-or-later
import { useCallback, useSyncExternalStore } from 'react';
import type { AiRuntimeSnapshot } from '../../shared/contracts/ai';
import { nativeAvailable } from '../../shared/native/transport';
import { subscribeNative } from '../../shared/native/events';
import { subscribeRecovery } from '../../shared/native/recovery';
import { aiApi } from './api';

export function mergeAiRuntime(current: AiRuntimeSnapshot | null, incoming: AiRuntimeSnapshot) {
  return current?.jobId === incoming.jobId && current.revision >= incoming.revision ? current : incoming;
}

interface RuntimeState { snapshot: AiRuntimeSnapshot | null; error: boolean }
interface RuntimeSource {
  read: (jobId: string) => Promise<AiRuntimeSnapshot | null>;
  listen: (receive: (snapshot: AiRuntimeSnapshot) => void, ready: () => void) => () => void;
  recover?: (refresh: () => void) => () => void;
}

/** One shared subscription/cache keeps all surfaces on the same attempt and revision. */
export function createAiRuntimeStore(source: RuntimeSource) {
  const entries = new Map<string, { state: RuntimeState; listeners: Set<() => void>; pending?: Promise<void> }>();
  let stop: (() => void) | undefined;
  let stopRecovery: (() => void) | undefined;
  function refreshActive() { entries.forEach((value, jobId) => { if (value.listeners.size) void refresh(jobId); }); }
  function entry(jobId: string) {
    let value = entries.get(jobId);
    if (!value) {
      value = { state: { snapshot: null, error: false }, listeners: new Set() };
      entries.set(jobId, value);
    }
    return value;
  }
  function publish(jobId: string, state: RuntimeState) {
    const value = entry(jobId);
    if (value.state.snapshot === state.snapshot && value.state.error === state.error) return;
    value.state = state;
    value.listeners.forEach(listener => listener());
  }
  function receive(snapshot: AiRuntimeSnapshot) {
    const current = entry(snapshot.jobId).state;
    publish(snapshot.jobId, { snapshot: mergeAiRuntime(current.snapshot, snapshot), error: false });
  }
  function refresh(jobId: string) {
    const value = entry(jobId);
    if (value.pending) return value.pending;
    const beforeRead = value.state.snapshot;
    value.pending = Promise.resolve().then(() => source.read(jobId)).then(snapshot => {
      if (snapshot?.jobId === jobId) receive(snapshot);
      else if (snapshot === null && value.state.snapshot === beforeRead) publish(jobId, { snapshot: null, error: false });
    }).catch(() => publish(jobId, { ...value.state, error: true })).finally(() => { value.pending = undefined; });
    return value.pending;
  }
  return {
    getSnapshot: (jobId: string) => entry(jobId).state,
    refresh,
    subscribe(jobId: string, listener: () => void) {
      const value = entry(jobId);
      value.listeners.add(listener);
      stop ??= source.listen(receive, refreshActive);
      stopRecovery ??= source.recover?.(refreshActive);
      void refresh(jobId);
      return () => {
        value.listeners.delete(listener);
        if (![...entries.values()].some(item => item.listeners.size)) { stop?.(); stop = undefined; stopRecovery?.(); stopRecovery = undefined; }
      };
    },
  };
}

const store = createAiRuntimeStore({
  read: jobId => aiApi.runtime(jobId),
  listen: (receive, ready) => subscribeNative('ai-runtime', event => receive(event.payload), () => {}, ready),
  recover: subscribeRecovery,
});
const empty: RuntimeState = { snapshot: null, error: false };
export function useAiRuntime(jobId: string, _running: boolean) {
  const enabled = nativeAvailable();
  const subscribe = useCallback((listener: () => void) => enabled ? store.subscribe(jobId, listener) : () => {}, [jobId, enabled]);
  const snapshot = useCallback(() => enabled ? store.getSnapshot(jobId) : empty, [jobId, enabled]);
  const state = useSyncExternalStore(subscribe, snapshot, () => empty);
  return state;
}
