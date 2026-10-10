// SPDX-License-Identifier: GPL-3.0-or-later
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useAppearance } from './Appearance';
import { useSnapshot } from './Snapshot';
import { libraryApi } from '../../features/library/api';
import { call, nativeAvailable } from '../../shared/native/transport';
import { queryKeys } from '../../shared/query/keys';
import { activityFinished, recentActivities, rootActivities, type Activity, type ActivityDescriptor, type ActivityUpdate, type OperationProgress, type TrackedOptions } from '../../shared/contracts/activity';

interface Activities {
  activities: Activity[];
  runningCount: number;
  isOpen: boolean;
  open: () => void;
  close: () => void;
  error?: string;
  runTracked: <T>(descriptor: ActivityDescriptor, action: (update: (patch: ActivityUpdate) => void) => Promise<T>, options?: TrackedOptions<T>) => Promise<T>;
}
const Context = createContext<Activities | null>(null);

/** An older snapshot must never regress or revive a finished operation. */
export function mergeOperationProgress(current: Record<string, OperationProgress>, incoming: OperationProgress[]) {
  const next = { ...current };
  for (const operation of incoming) {
    const prior = next[operation.id];
    if (prior && (Date.parse(prior.updatedAt) > Date.parse(operation.updatedAt) ||
      (prior.status !== 'running' && operation.status === 'running'))) continue;
    next[operation.id] = operation;
  }
  const retained = recentActivities(Object.values(next).map(operation => ({ ...operation, source: 'native' as const })));
  return Object.fromEntries(retained.map(operation => [operation.id, next[operation.id]]));
}

export function ActivityProvider({ children }: { children: ReactNode }) {
  const { data } = useSnapshot();
  const { t } = useAppearance();
  const [isOpen, setOpen] = useState(false);
  const [local, setLocal] = useState<Activity[]>([]);
  const [operations, setOperations] = useState<Record<string, OperationProgress>>({});
  const seenDownloads = useRef(new Set<string>());
  const downloadBaseline = useRef<Set<string> | undefined>(undefined);
  const seenJobs = useRef(new Set<string>());
  const jobBaseline = useRef<Set<string> | undefined>(undefined);
  const jobUpdates = useRef(new Map<string, { signature: string; updatedAt: string }>());
  const startedAt = useRef(Date.now());
  const generations = useRef(new Map<string, symbol>());
  const downloads = useQuery({ queryKey: queryKeys.downloads, queryFn: libraryApi.downloadJobs, enabled: nativeAvailable(), refetchInterval: 1000 });
  const native = useQuery({ queryKey: queryKeys.operations, queryFn: () => call<OperationProgress[]>('list_operation_progress'), enabled: nativeAvailable(), refetchInterval: 1000 });
  useEffect(() => {
    if (native.data) setOperations(current => mergeOperationProgress(current, native.data));
  }, [native.data]);
  const runTracked = useCallback(async <T,>(descriptor: ActivityDescriptor, action: (update: (patch: ActivityUpdate) => void) => Promise<T>, options?: TrackedOptions<T>): Promise<T> => {
    const id = descriptor.id ?? `local:${crypto.randomUUID()}`;
    const generation = Symbol(id);
    generations.current.set(id, generation);
    let settled = false;
    let current: Activity = { ...descriptor, id, source: 'local', status: 'running', updatedAt: new Date().toISOString() };
    const publish = (patch: Partial<Activity>) => {
      if (settled || generations.current.get(id) !== generation) return;
      current = { ...current, ...patch, updatedAt: new Date().toISOString() };
      const value = current;
      setLocal(items => recentActivities([...items.filter(item => item.id !== id), value]));
    };
    publish({});
    try {
      const result = await action(patch => publish(patch));
      const outcome = options?.classifyResult?.(result);
      publish(outcome ?? { status: current.status === 'running' ? 'completed' : current.status });
      return result;
    } catch (error) {
      publish({ status: current.status === 'cancelled' ? 'cancelled' : 'failed', error: error instanceof Error ? error.message : String(error) });
      throw error;
    } finally {
      settled = true;
      if (generations.current.get(id) === generation) generations.current.delete(id);
    }
  }, []);
  const activities = useMemo(() => {
    const downloadActivities: Activity[] = [];
    if (downloads.data && !downloadBaseline.current) downloadBaseline.current = new Set(downloads.data.map(item => item.id));
    for (const download of downloads.data ?? []) {
      if (download.status === 'running' || !downloadBaseline.current?.has(download.id) || Date.parse(download.updatedAt) >= startedAt.current) seenDownloads.current.add(download.id);
      if (!seenDownloads.current.has(download.id)) continue;
      downloadActivities.push({ id: `download:${download.id}`, source: 'download', sourceId: download.id, kind: 'download', label: download.request.title || download.request.pathOrUrl,
        status: download.status, phase: download.phase, completed: download.storedBytes,
        total: download.totalBytesExact && download.phase === 'downloading' ? download.totalBytes : undefined, unit: 'bytes', mediaId: download.mediaId,
        updatedAt: download.updatedAt, error: download.error });
    }
    const jobActivities: Activity[] = [];
    if (data?.jobs && !jobBaseline.current) jobBaseline.current = new Set(data.jobs.map(job => job.id));
    for (const job of data?.jobs ?? []) {
      const status = job.status === 'queued' ? 'waiting' : job.status;
      if (!activityFinished({ status }) || !jobBaseline.current?.has(job.id) || Date.parse(job.createdAt) >= startedAt.current) seenJobs.current.add(job.id);
      if (!seenJobs.current.has(job.id)) continue;
      const signature = JSON.stringify([job.status, job.progress, job.message]);
      let update = jobUpdates.current.get(job.id);
      if (update?.signature !== signature) {
        update = { signature, updatedAt: new Date().toISOString() };
        jobUpdates.current.set(job.id, update);
      }
      const media = data?.media.find(item => item.id === job.mediaId);
      const purpose = job.kind === 'transcribe' || job.automaticTranscript ? t('文字起こし', 'Transcription')
        : job.kind === 'translate' ? t('翻訳', 'Translation') : t('語彙・解説', 'Vocabulary and explanations');
      jobActivities.push({ id: `ai:${job.id}`, source: 'ai', sourceId: job.id, kind: job.kind, label: media ? `${media.title} · ${purpose}` : purpose,
        status, phase: job.message || 'running', completed: job.progress, total: 1,
        mediaId: job.mediaId, updatedAt: update.updatedAt });
    }
    // Native parents reference the persisted job id; the UI adapters namespace it.
    const jobParents = new Map([...downloadActivities, ...jobActivities].map(activity => [activity.sourceId, activity.id]));
    const nativeActivities: Activity[] = Object.values(operations).map(operation => ({ ...operation, source: 'native',
      phase: operation.kind === 'preparation' && operation.phase === 'extracting' ? 'extracting_audio' : operation.phase,
      parentId: operation.parentId && !operations[operation.parentId] ? jobParents.get(operation.parentId) ?? operation.parentId : operation.parentId }));
    return recentActivities([...local, ...nativeActivities, ...downloadActivities, ...jobActivities]);
  }, [local, operations, downloads.data, data?.jobs, data?.media, t]);
  const open = useCallback(() => setOpen(true), []);
  const close = useCallback(() => setOpen(false), []);
  const value = useMemo<Activities>(() => ({ activities, runningCount: rootActivities(activities).filter(item => item.status === 'running').length,
    isOpen, open, close, runTracked, error: native.error?.message || downloads.error?.message }), [activities, isOpen, open, close, runTracked, native.error, downloads.error]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useActivities() {
  const value = useContext(Context);
  if (!value) throw new Error('ActivityProvider missing');
  return value;
}
