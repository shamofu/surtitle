import { useEffect, useRef, useState } from 'react';
import { nativeAvailable } from '../../../shared/native/transport';
import { acquireEditorDraft, type EditorDraftSession, type DraftSessionOptions } from './session';
export { clearEditorDraftSessions, flushEditorDrafts } from './session';
export { editorDraftApi, editorSourceKey } from './api';

export function useEditorDraft<T extends object>(options: Omit<DraftSessionOptions, 'initialValue'> & {
  initialValue: T;
  onRestore?: (value: T) => void;
}) {
  const [, render] = useState(0);
  const session = useRef<EditorDraftSession | undefined>(undefined);
  const callbacks = useRef(options); callbacks.current = options;
  const restored = useRef(false);
  useEffect(() => {
    if (!nativeAvailable()) return;
    restored.current = false;
    const handle = acquireEditorDraft({ ...options, initialValue: options.initialValue as Record<string, string> });
    session.current = handle.session;
    const update = () => {
      if (handle.session.ready && !restored.current) {
        restored.current = true;
        callbacks.current.onRestore?.(handle.session.value as T);
      }
      render(value => value + 1);
    };
    const unsubscribe = handle.session.subscribe(update);
    update();
    return () => { unsubscribe(); handle.release(); session.current = undefined; };
  }, [options.mediaId, options.kind, options.sourceKey]);
  return {
    draft: session.current?.draft,
    status: session.current?.status ?? 'saved',
    error: session.current?.error ?? '',
    stale: session.current?.draft?.stale ?? false,
    value: (session.current?.value as T | undefined) ?? options.initialValue,
    setValue: (value: T) => session.current?.setValue(value as Record<string, string>),
    flush: (force = false) => session.current?.flush(force) ?? Promise.resolve(undefined),
    retry: () => session.current?.retry() ?? Promise.resolve(undefined),
    discard: () => session.current?.discard() ?? Promise.resolve(),
    consume: () => session.current?.consume(),
    rebind: (sourceCues: DraftSessionOptions['sourceCues']) => session.current?.rebind(sourceCues) ?? Promise.resolve(undefined),
  };
}
