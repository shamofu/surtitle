// SPDX-License-Identifier: GPL-3.0-or-later
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';

import { subscribeNative } from '../../../shared/native/events';
import {
  ChevronDown,
  Headphones,
  Maximize,
  Pause,
  Play,
  Repeat2,
  RotateCcw,
  RotateCw,
  Volume2,
} from 'lucide-react';
import { playerApi } from './api';

import { nativeAvailable } from '../../../shared/native/transport';

import type { Media } from '../../../shared/contracts/media';
import type { PlayerState } from '../../../shared/contracts/player';
import type { SubtitleSegment } from '../../../shared/contracts/media';

import {
  useAppearance,
  useNotifications,
  useSurface,
  useDataActions,
} from '../../../app/runtime';
import { timestamp } from '../../../shared/format';
import { shouldIgnoreShortcut } from '../../../shared/keyboard';
import { Button, IconButton, Modal, useModalExit } from '../../../shared/ui/index';

export function NativePlayer({
  media,
  selected,
  selectionRevision,
  onPosition,
  onReady,
  draftMode = false,
  repeatTarget = null,
  settingsOpen = false,
  onSettingsClose = () => {},
  onUseStudySubtitles,
  interactionsDisabled = false,
}: {
  media: Media;
  draftMode?: boolean;
  repeatTarget?: HTMLElement | null;
  settingsOpen?: boolean;
  onSettingsClose?: () => void;
  onUseStudySubtitles?: (streamIndex: number) => void;
  interactionsDisabled?: boolean;
  selected?: SubtitleSegment;
  selectionRevision: number;
  onPosition: (positionMs: number) => void;
  onReady: (ready: boolean) => void;
}) {
  const { t } = useAppearance();
  const { notify } = useNotifications();
  const { surfaceHidden } = useSurface();
  const { refresh } = useDataActions();
  const settingsExit = useModalExit(settingsOpen);
  const viewport = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<PlayerState>();
  const playerRevision = useRef(-1);
  const acceptState = useCallback((current: PlayerState) => {
    if (current.revision !== undefined) {
      if (current.revision < playerRevision.current) return false;
      playerRevision.current = current.revision;
    }
    setState(current);
    return true;
  }, []);
  const [loadStatus, setLoadStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [loadError, setLoadError] = useState('');
  const [surfaceError, setSurfaceError] = useState('');
  const [surfaceAttempt, setSurfaceAttempt] = useState(0);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [loadPending, setLoadPending] = useState(false);
  const loadBusy = useRef(false);
  const loaded = loadStatus === 'ready';
  const [seekDraft, setSeekDraft] = useState<number | null>(null);
  const seekInput = useRef<number | null>(null);
  const seekOperation = useRef(0);
  const [loop, setLoop] = useState(false);
  const loopActive = useRef(false);
  const loopOperation = useRef(0);
  const [loopBusy, setLoopBusy] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const control = useCallback(
    async (request: Parameters<typeof playerApi.player>[0]) => {
      if (request.action === 'seek' || request.action === 'source-seek') {
        loopOperation.current += 1;
        loopActive.current = false;
        setLoop(false);
        setLoopBusy(false);
      }
      try {
        await playerApi.player(request);
        return true;
      } catch (error) {
        notify(String(error), 'error');
        return false;
      }
    },
    [notify],
  );
  const selectionSignature = selected
    ? JSON.stringify([selected.id, selected.startMs, selected.endMs])
    : '';
  const previousSelection = useRef({
    mediaId: media.id,
    revision: selectionRevision,
    signature: selectionSignature,
  });
  useLayoutEffect(() => {
    const previous = previousSelection.current;
    previousSelection.current = {
      mediaId: media.id,
      revision: selectionRevision,
      signature: selectionSignature,
    };
    // Explicit replays already clear the native loop with their seek. Only a
    // source refresh must clear it here, without erasing a newly requested range stop.
    // Finish before the updated controls become interactive, so a repeat click
    // for the new selection cannot be erased by a pending passive effect.
    if (
      loopActive.current &&
      previous.mediaId === media.id &&
      previous.revision === selectionRevision &&
      previous.signature !== selectionSignature
    ) {
      void playerApi
        .player({ action: 'loop' })
        .catch((error) => notify(String(error), 'error'));
    }
    loopActive.current = false;
    loopOperation.current += 1;
    setLoop(false);
    setLoopBusy(false);
  }, [selectionSignature, media.id, selectionRevision, notify]);
  useEffect(() => {
    if (!nativeAvailable()) return;
    let disposed = false;
    let requested = false;
    let failed = false;
    let eventRevision = 0;
    loadBusy.current = true;
    setLoadPending(true);
    setLoadStatus('loading');
    setLoadError('');
    setState(undefined);
    playerRevision.current = -1;
    setSeekDraft(null);
    seekInput.current = null;
    seekOperation.current += 1;
    loopActive.current = false;
    loopOperation.current += 1;
    setLoop(false);
    setLoopBusy(false);
    onReady(false);
    const fail = (error: unknown) => {
      if (disposed) return;
      failed = true;
      requested = false;
      setLoadError(String(error));
      setLoadStatus('error');
      onReady(false);
    };
    const accept = (current: PlayerState) => {
      if (disposed || failed) return;
      if (!acceptState(current)) return;
      if (current.error) {
        fail(current.error);
      } else {
        setLoadError('');
        setLoadStatus(current.ready === true ? 'ready' : 'loading');
        onReady(current.ready === true);
      }
    };
    const stop = subscribeNative<PlayerState>(
      'player-state',
      (event) => {
        if (requested) {
          eventRevision += 1;
          accept(event.payload);
        }
      },
      fail,
    );
    void playerApi
      .loadMedia(media.id)
      .then(async () => {
        if (disposed || failed) return;
        requested = true;
        const snapshotRevision = eventRevision;
        const current = await playerApi.playerState();
        if (current.revision !== undefined || eventRevision === snapshotRevision) accept(current);
      })
      .catch(fail)
      .finally(() => {
        if (!disposed) {
          loadBusy.current = false;
          setLoadPending(false);
        }
      });
    return () => {
      disposed = true;
      seekOperation.current += 1;
      stop();
      void playerApi.player({ action: 'hide' }).catch(() => {});
    };
  }, [media.id, media.path, onReady, loadAttempt, acceptState]);
  function retryLoad() {
    if (loadBusy.current || interactionsDisabled || loadStatus !== 'error') return;
    // Guard synchronously as well as disabling the button; two clicks in one
    // frame must never issue two load requests.
    loadBusy.current = true;
    setLoadStatus('loading');
    setLoadError('');
    setLoadAttempt((attempt) => attempt + 1);
  }
  useEffect(() => {
    if (state) onPosition(state.positionMs);
  }, [state?.positionMs, onPosition]);
  useEffect(() => {
    if (!nativeAvailable()) return;
    let frame = 0;
    let last = '';
    let disposed = false;
    setSurfaceError('');
    const update = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        const rect = viewport.current?.getBoundingClientRect();
        const main = viewport.current
          ?.closest('.page-content')
          ?.getBoundingClientRect();
        const hidden =
          surfaceHidden ||
          !loaded ||
          !rect ||
          rect.width < 1 ||
          rect.height < 1 ||
          rect.top < (main?.top || 0) ||
          rect.bottom >
            Math.min(main?.bottom || window.innerHeight, window.innerHeight) ||
          document.hidden;
        const request = hidden
          ? { action: 'hide' as const }
          : {
              action: 'bounds' as const,
              bounds: {
                x: rect.x,
                y: rect.y,
                width: rect.width,
                height: rect.height,
                scaleFactor: window.devicePixelRatio,
              },
            };
        const signature = JSON.stringify(request);
        if (signature !== last) {
          last = signature;
          void playerApi.player(request).then(() => {
            if (!disposed && !hidden) setSurfaceError('');
          }).catch(error => {
            if (disposed) return;
            last = '';
            setSurfaceError(String(error));
          });
        }
      });
    };
    const observer = new ResizeObserver(update);
    if (viewport.current) observer.observe(viewport.current);
    const scrollContainer = viewport.current?.closest('.page-content');
    if (scrollContainer) observer.observe(scrollContainer);
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    document.addEventListener('visibilitychange', update);
    update();
    return () => {
      disposed = true;
      window.cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
      document.removeEventListener('visibilitychange', update);
    };
  }, [loaded, surfaceHidden, media.id, surfaceAttempt]);
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (
        shouldIgnoreShortcut(event) ||
        surfaceHidden ||
        interactionsDisabled ||
        !loaded
      )
        return;
      if (event.code === 'Space') {
        event.preventDefault();
        if (event.repeat) return;
        void control({ action: state?.paused ? 'play' : 'pause' });
      }
      if (event.code === 'ArrowLeft' || event.code === 'ArrowRight') {
        event.preventDefault();
        void control({
          action: 'seek',
          value: Math.max(
            0,
            (state?.positionMs || 0) +
              (event.code === 'ArrowLeft' ? -5000 : 5000),
          ),
        });
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [loaded, surfaceHidden, interactionsDisabled, state?.paused, state?.positionMs, control]);
  const duration = state?.durationMs || media.durationMs;
  async function selectAudio(id: number) {
    await control({ action: 'track', trackKind: 'audio', value: id });
    await refresh();
  }
  useEffect(() => {
    if (!loaded) return;
    void control({ action: 'draft-mode', value: draftMode ? 1 : 0 });
    return () => {
      if (draftMode)
        void playerApi
          .player({ action: 'draft-mode', value: 0 })
          .catch(() => {});
    };
  }, [draftMode, loaded, control]);
  async function setSentencePause(enabled: boolean) {
    try {
      await playerApi.player({
        action: 'sentence-pause',
        value: enabled ? 1 : 0,
      });
      acceptState(await playerApi.playerState());
      await refresh();
    } catch (error) {
      notify(String(error), 'error');
    }
  }
  const position = seekDraft ?? state?.positionMs ?? media.lastPositionMs;
  const controlsDisabled = !loaded || interactionsDisabled;
  function previewSeek(value: number) {
    seekOperation.current += 1;
    seekInput.current = value;
    setSeekDraft(value);
  }
  function cancelSeek() {
    seekOperation.current += 1;
    seekInput.current = null;
    setSeekDraft(null);
  }
  function commitSeek() {
    if (controlsDisabled) { cancelSeek(); return; }
    const target = seekInput.current;
    if (target === null) return;
    // Release/blur can both fire. Commit once and keep the chosen position
    // visible until the command and a fresh native snapshot have completed.
    seekInput.current = null;
    const operation = ++seekOperation.current;
    void (async () => {
      try {
        if (!await control({ action: 'seek', value: target })) return;
        if (operation !== seekOperation.current) return;
        const current = await playerApi.playerState();
        if (operation === seekOperation.current) acceptState(current);
      } catch (error) {
        if (operation === seekOperation.current) notify(String(error), 'error');
      } finally {
        if (operation === seekOperation.current) setSeekDraft(null);
      }
    })();
  }
  async function toggleLoop() {
    if (!selected || controlsDisabled || loopBusy) return;
    const previous = loopActive.current;
    const next = !previous;
    const operation = ++loopOperation.current;
    // Track a pending loop so source refreshes can cancel it before it settles.
    loopActive.current = next;
    setLoopBusy(true);
    try {
      await playerApi.player(next
        ? { action: 'source-loop', startMs: selected.startMs, endMs: selected.endMs }
        : { action: 'loop' });
      if (operation === loopOperation.current) setLoop(next);
    } catch (error) {
      if (operation === loopOperation.current) {
        loopActive.current = previous;
        setLoop(previous);
      }
      notify(String(error), 'error');
    } finally {
      if (operation === loopOperation.current) setLoopBusy(false);
    }
  }
  const repeatButton = (
    <Button
      className={`sentence-repeat${loop ? ' active' : ''}`}
      variant={loop ? 'primary' : 'secondary'}
      aria-label={t('選択区間をリピート', 'Repeat selected segment')}
      aria-pressed={loop}
      disabled={controlsDisabled || !selected}
      busy={loopBusy}
      onClick={() => void toggleLoop()}
    >
      <Repeat2 size={18} />
      {t('繰り返す', 'Repeat')}
    </Button>
  );
  return (
    <>
      <section className="player-card" aria-label={t('メディアプレイヤー', 'Media player')}>
        <div ref={viewport} className="native-player-viewport" data-testid="native-player-viewport">
          <div className="video-placeholder">
            {media.kind === 'audio' && <Headphones size={32} aria-hidden="true" />}
            <p role={loadStatus === 'error' ? 'alert' : 'status'}>
              {loadError || (!nativeAvailable()
                ? t('メディアの再生にはデスクトップ版を利用してください。', 'Use the desktop app to play media.')
                : loaded
                ? media.kind === 'audio' ? t('音声を再生', 'Audio playback') : ''
                : t('プレイヤーを準備しています', 'Preparing your player'))}
            </p>
            {loadStatus === 'error' && (
              <Button variant="secondary" disabled={interactionsDisabled} busy={loadPending} onClick={retryLoad}>
                <RotateCw size={16} />{t('プレイヤーを再試行', 'Retry player')}
              </Button>
            )}
          </div>
        </div>
        <fieldset className="player-controls" disabled={interactionsDisabled}>
          <div className="seek-control">
            <input
              type="range" min="0" max={Math.max(duration, 1)} step="100"
              value={Math.min(position, duration || 1)}
              disabled={!loaded || !duration}
              onPointerDown={(event) => {
                if (event.button !== 0 || controlsDisabled) return;
                event.currentTarget.setPointerCapture(event.pointerId);
                previewSeek(event.currentTarget.valueAsNumber);
              }}
              onChange={(event) => previewSeek(event.currentTarget.valueAsNumber)}
              onPointerUp={commitSeek} onKeyUp={commitSeek} onBlur={commitSeek}
              onPointerCancel={cancelSeek}
              aria-label={t('再生位置', 'Playback position')}
              style={{ '--progress': `${duration ? (position / duration) * 100 : 0}%` } as React.CSSProperties}
            />
          </div>
          <div className="player-control-row">
            <div className="control-cluster">
              <IconButton label={t('5 秒戻る', 'Back 5 seconds')} disabled={!loaded} onClick={() => void control({ action: 'seek', value: Math.max(0, position - 5000) })}>
                <RotateCcw size={18} />
              </IconButton>
              <IconButton className="play-button" label={state?.paused !== false ? t('再生', 'Play') : t('一時停止', 'Pause')} disabled={!loaded} onClick={() => void control({ action: state?.paused ? 'play' : 'pause' })}>
                {state?.paused !== false ? <Play size={19} fill="currentColor" /> : <Pause size={19} fill="currentColor" />}
              </IconButton>
              <IconButton label={t('5 秒進む', 'Forward 5 seconds')} disabled={!loaded} onClick={() => void control({ action: 'seek', value: Math.min(duration, position + 5000) })}>
                <RotateCw size={18} />
              </IconButton>
              <span className="player-time">{timestamp(position)} <span>/ {timestamp(duration)}</span></span>
            </div>
            <div className="control-cluster">
              <label className="speed-select">
                <span className="sr-only">{t('再生速度', 'Playback speed')}</span>
                <select value={state?.rate || 1} disabled={!loaded} onChange={(event) => void control({ action: 'rate', value: Number(event.target.value) })}>
                  {[0.5, 0.75, 1, 1.25, 1.5, 1.75, 2].map((rate) => <option key={rate} value={rate}>{rate}×</option>)}
                </select>
                <ChevronDown size={12} />
              </label>
              <Volume2 size={16} aria-hidden="true" />
              <input className="volume-slider" type="range" min="0" max="100" value={state?.volume ?? 100} disabled={!loaded} onChange={(event) => void control({ action: 'volume', value: Number(event.target.value) })} aria-label={t('音量', 'Volume')} />
              <IconButton label={t('全画面表示を切り替える', 'Toggle fullscreen')} aria-pressed={fullscreen} disabled={!loaded} onClick={() => {
                const next = !fullscreen;
                setFullscreen(next);
                void control({ action: 'fullscreen', value: next ? 1 : 0 });
              }}>
                <Maximize size={17} />
              </IconButton>
            </div>
          </div>
          {!repeatTarget && draftMode && selected && repeatButton}
        </fieldset>
      </section>
      {surfaceError && <div className="notice warning" role="alert">
        <span>{t('映像を表示できませんでした。', 'The video could not be displayed.')} {surfaceError}</span>
        <Button onClick={() => setSurfaceAttempt(value => value + 1)}>{t('映像表示を再試行', 'Retry video display')}</Button>
      </div>}
      {repeatTarget && createPortal(repeatButton, repeatTarget)}
      {settingsOpen && (
        <Modal {...settingsExit.modalProps} title={t('再生設定', 'Playback settings')} onClose={() => void settingsExit.close(onSettingsClose)}>
          <div className="track-controls">
            {(['audio', 'sub'] as const).map((kind) => {
              const tracks = state?.tracks.filter((track) => track.kind === kind) || [];
              return tracks.length > 0 && (
                <label key={kind} className="field">
                  <span>{kind === 'audio' ? t('学習する音声', 'Study audio') : t('再生字幕', 'Playback captions')}</span>
                  <select
                    aria-label={kind === 'audio' ? t('音声トラック', 'Audio track') : t('字幕トラック', 'Subtitle track')}
                    disabled={controlsDisabled}
                    value={tracks.find((track) => track.selected)?.id ?? 0}
                    onChange={(event) => void (kind === 'audio'
                      ? selectAudio(Number(event.target.value))
                      : control({ action: 'track', trackKind: kind, value: Number(event.target.value) }))}
                  >
                    {kind === 'sub' && <option value={0}>{t('非表示', 'Off')}</option>}
                    {tracks.map((track) => (
                      <option key={track.id} value={track.id}>
                        {[track.language, track.title || `${kind} ${track.id}`].filter(Boolean).join(' · ')}
                      </option>
                    ))}
                  </select>
                  {kind === 'sub' && onUseStudySubtitles && (() => {
                    const selectedTrack = tracks.find(track => track.selected);
                    return selectedTrack && !selectedTrack.external && selectedTrack.ffIndex != null && <Button
                      disabled={controlsDisabled}
                      onClick={() => void settingsExit.close(() => onUseStudySubtitles(selectedTrack.ffIndex!))}
                    >{t('この字幕を学習に使う', 'Use these captions for study')}</Button>;
                  })()}
                </label>
              );
            })}
          </div>
          <label className="check-field">
            <input type="checkbox" checked={!draftMode && (state?.sentencePause ?? false)} disabled={controlsDisabled || draftMode} onChange={(event) => void setSentencePause(event.target.checked)} />
            <span>{t('字幕グループの終わりで一時停止', 'Pause at the end of a caption group')}</span>
          </label>
          <p className="helper-text">
            {t('句読点や字幕の間隔を目安に、字幕の終端で止まります。選択区間の再生・リピートを優先します。', 'Stops at subtitle ends, using punctuation and gaps to group sentences. Selected ranges and repeat take priority.')}
          </p>
        </Modal>
      )}
    </>
  );
}
