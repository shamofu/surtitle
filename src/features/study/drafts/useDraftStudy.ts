// SPDX-License-Identifier: GPL-3.0-or-later
import { useMounted } from './lifecycle';

import { useEffect, useRef, useState } from 'react';

import { studyApi } from '../api';
import { nativeAvailable } from '../../../shared/native/transport';
import type { Media } from '../../../shared/contracts/media';
import type { TranscriptReview } from '../../../shared/contracts/transcript';
import { useSnapshot, useNotifications } from '../../../app/runtime';
import { draftStudyApi } from './api';
import { savedDraftText } from './saved-text';
import type { DraftSelection } from './api';

export const PAGE_SIZE = 40;
export const BLOCK_PAGE_SIZE = 8;

export function useDraftStudy(media: Media) {
  const { data } = useSnapshot();
  const { report } = useNotifications();
  const mounted = useMounted();
  const jobs =
    data?.jobs.filter(
      (job) => job.mediaId === media.id && job.transcriptReview,
    ) || [];
  const [chosenJob, setChosenJob] = useState('');
  const jobId = jobs.some((job) => job.id === chosenJob)
    ? chosenJob
    : jobs[0]?.id;
  const identity = useRef(jobId);
  identity.current = jobId;
  const [loaded, setLoaded] = useState<{
    jobId: string;
    view: TranscriptReview;
  }>();
  const view = loaded && loaded.jobId === jobId ? loaded.view : undefined;
  const [bookmarks, setBookmarks] = useState<DraftSelection[]>([]);
  const [active, setActive] = useState<DraftSelection>();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const mutation = useRef(0);
  const preparing = useRef(false);
  const [refresh, setRefresh] = useState(0);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [page, setPage] = useState(0);
  const [blockPage, setBlockPage] = useState(0);
  const [sourceText, setSourceText] = useState<Record<number, string | null>>(
    {},
  );
  const [reading, setReading] = useState<number>();

  useEffect(() => {
    setSelectedIds([]);
    setPage(0);
    setBlockPage(0);
    setSourceText({});
    setReading(undefined);
  }, [jobId]);

  useEffect(() => {
    if (!nativeAvailable()) {
      setLoading(false);
      return;
    }
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function poll() {
      const revision = mutation.current;
      const results = await Promise.allSettled([
        draftStudyApi.list(media.id),
        jobId ? studyApi.transcriptReview(jobId) : Promise.resolve(undefined),
      ]);
      if (disposed || identity.current !== jobId) return;
      if (revision === mutation.current) {
        const [selections, review] = results;
        if (selections.status === 'fulfilled') setBookmarks(selections.value);
        if (review.status === 'fulfilled' && review.value && jobId)
          setLoaded({ jobId, view: review.value });
        const failed = results.find((result) => result.status === 'rejected');
        setError(
          failed?.status === 'rejected'
            ? String(
                failed.reason instanceof Error
                  ? failed.reason.message
                  : failed.reason,
              )
            : '',
        );
      }
      setLoading(false);
      // Schedule only after completion, so a slow native read cannot overlap the next poll.
      timer = setTimeout(() => void poll(), 2000);
    }
    void poll();
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
    };
  }, [jobId, media.id, refresh]);

  async function prepare(request: {
    jobId: string;
    cueIds?: string[];
    ordinal?: number;
  }) {
    if (preparing.current) return;
    preparing.current = true;
    setBusy(true);
    mutation.current++;
    const selected = await report(() => draftStudyApi.prepare(request));
    if (!mounted.current) return;
    preparing.current = false;
    setBusy(false);
    mutation.current++;
    if (selected) {
      setBookmarks((items) => [
        selected,
        ...items.filter((item) => item.id !== selected.id),
      ]);
      if (identity.current === request.jobId) setActive(selected);
    }
  }
  async function readSource(ordinal: number) {
    if (!jobId || reading !== undefined) return;
    const requestedJob = jobId;
    setReading(ordinal);
    const result = await report(() =>
      studyApi.transcriptResultDetail(requestedJob, ordinal),
    );
    if (!mounted.current || identity.current !== requestedJob) return;
    setReading(undefined);
    if (result)
      setSourceText((items) => ({
        ...items,
        [ordinal]: savedDraftText(result.evidence?.response) ?? null,
      }));
  }
  function saved(selection: DraftSelection) {
    mutation.current++;
    setBookmarks((items) => [
      selection,
      ...items.filter((item) => item.id !== selection.id),
    ]);
    setActive(selection);
  }
  const cues = view?.draft.segments || [];
  const chosen = cues.filter((cue) => selectedIds.includes(cue.id));
  const first = cues.findIndex((cue) => cue.id === chosen[0]?.id);
  const consecutive =
    chosen.length > 0 &&
    chosen.length <= 50 &&
    chosen.length === selectedIds.length &&
    chosen.every((cue, index) => cues[first + index]?.id === cue.id);
  const effectivePage = Math.min(
    page,
    Math.max(0, Math.ceil(cues.length / PAGE_SIZE) - 1),
  );
  const chunks = view?.draft.chunks || [];
  const effectiveBlockPage = Math.min(
    blockPage,
    Math.max(0, Math.ceil(chunks.length / BLOCK_PAGE_SIZE) - 1),
  );
  function removeActive() {
    mutation.current++;
    setBookmarks((items) => items.filter((item) => item.id !== active?.id));
    setActive(undefined);
  }
  return {
    jobs,
    jobId,
    view,
    bookmarks,
    active,
    setActive,
    error,
    loading,
    busy,
    setRefresh,
    setChosenJob,
    selectedIds,
    setSelectedIds,
    setPage,
    setBlockPage,
    sourceText,
    reading,
    prepare,
    readSource,
    saved,
    cues,
    chosen,
    consecutive,
    effectivePage,
    chunks,
    effectiveBlockPage,
    removeActive,
  };
}
