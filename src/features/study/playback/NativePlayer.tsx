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
  Settings2,
} from 'lucide-react';
import { playerApi } from './api';
import { VolumeControl } from './VolumeControl';

import { nativeAvailable } from '../../../shared/native/transport';

import type { Media } from '../../../shared/contracts/media';
import type { PlayerControlRequest, PlayerState, PlayerSurfaceRect } from '../../../shared/contracts/player';
import type { SubtitleSegment } from '../../../shared/contracts/media';

import {
  useAppearance,
  useNotifications,
  useSurface,
  useDataActions,
} from '../../../app/runtime';
import { timestamp } from '../../../shared/format';
import { AnimatedValue, MotionRegion, MotionSwap } from '../../../shared/motion';
import { shouldIgnoreShortcut } from '../../../shared/keyboard';
import { Button, IconButton, Modal, useModalExit } from '../../../shared/ui/index';

type SurfacePlacement = {
  owner: object;
  request: PlayerControlRequest & { action: 'bounds' | 'hide' };
  signature: string;
  complete?: (error?: unknown) => void;
};
const noOccludingElements: readonly HTMLElement[] = [];
const surfaceRect = (rect: DOMRect): PlayerSurfaceRect => ({ x: rect.x, y: rect.y, width: rect.width, height: rect.height });
function intersection(a: PlayerSurfaceRect, b: PlayerSurfaceRect): PlayerSurfaceRect {
  const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y);
  return { x, y, width: Math.max(0, Math.min(a.x + a.width, b.x + b.width) - x),
    height: Math.max(0, Math.min(a.y + a.height, b.y + b.height) - y) };
}

// One native HWND is shared across player mounts. Serialize its placements so an
// old bounds acknowledgement cannot overtake a modal/unmount hide or newer media.
const surfacePlacement = (() => {
  let wanted: SurfacePlacement | undefined;
  let hide: SurfacePlacement | undefined;
  let active = false;
  let confirmed: SurfacePlacement | undefined;
  const same = (a: SurfacePlacement | undefined, b: SurfacePlacement) =>
    a?.owner === b.owner && a.signature === b.signature;
  const flush = () => {
    if (active) return;
    const next = hide || wanted;
    if (!next) return;
    if (hide === next) hide = undefined;
    if (same(confirmed, next)) {
      if (same(wanted, next)) { wanted = undefined; next.complete?.(); }
      flush();
      return;
    }
    active = true;
    void playerApi.player(next.request).then(() => {
      confirmed = next;
      if (!hide && same(wanted, next)) {
        const complete = wanted?.complete;
        wanted = undefined;
        complete?.();
      }
    }, error => {
      confirmed = undefined;
      if (!hide && same(wanted, next)) {
        const complete = wanted?.complete;
        // A completion may enqueue recovery work. Clear the old slot first so
        // that work keeps its acknowledgement and can reveal withheld cards.
        wanted = undefined;
        complete?.(error);
      }
    }).finally(() => { active = false; flush(); });
  };
  return (owner: object, request: SurfacePlacement['request'], complete?: SurfacePlacement['complete']) => {
    const next = { owner, request, complete, signature: JSON.stringify(request) };
    wanted = next;
    // A hide is a barrier: reopening may replace desired bounds, but must never
    // cancel the hide already requested by a modal or a departing player.
    if (request.action === 'hide') hide = next;
    flush();
  };
})();

export function NativePlayer({
  media,
  selected,
  selectionRevision,
  onPosition,
  onReady,
  draftMode = false,
  repeatTarget = null,
  settingsOpen = false,
  onSettingsOpen,
  onSettingsClose = () => {},
  onUseStudySubtitles,
  interactionsDisabled = false,
}: {
  media: Media;
  draftMode?: boolean;
  repeatTarget?: HTMLElement | null;
  settingsOpen?: boolean;
  onSettingsOpen?: () => void;
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
  const { surfaceHidden, activeModal, occludingElements = noOccludingElements } = useSurface();
  const activeModalRef = useRef(activeModal);
  activeModalRef.current = activeModal;
  const { refresh } = useDataActions();
  const settingsExit = useModalExit(settingsOpen);
  const viewport = useRef<HTMLDivElement>(null);
  const surfaceOwner = useRef({});
  const surfaceButton = useRef<HTMLButtonElement>(null);
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
  const volumeOperation = useRef(0);
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
  const toggleSurface = () => {
    if (!loaded || surfaceHidden || interactionsDisabled || settingsOpen) return;
    surfaceButton.current?.focus({ preventScroll: true });
    // Let the native player choose from its current state, even when clicks
    // arrive faster than the periodic player-state snapshots.
    void control({ action: 'toggle-pause' });
  };
  const surfaceClick = useRef(toggleSurface);
  surfaceClick.current = toggleSurface;
  useEffect(() => {
    if (!nativeAvailable()) return;
    // The native video is a sibling HWND above the WebView, so DOM clicks alone
    // cannot receive pointer input from the actual decoded image.
    return subscribeNative('player-surface-click', () => surfaceClick.current(),
      error => notify(String(error), 'error'));
  }, [notify]);
  const selectionSignature = selected
    ? JSON.stringify([selected.id, selected.startMs, selected.endMs])
    : '';
  const changeVolume = useCallback(async (value: number) => {
    const operation = volumeOperation.current;
    if (!await control({ action: 'volume', value })) return;
    try {
      if (operation !== volumeOperation.current) return;
      const current = await playerApi.playerState();
      if (operation === volumeOperation.current) acceptState(current);
    } catch (error) {
      if (operation === volumeOperation.current) notify(String(error), 'error');
    }
  }, [control, acceptState, notify]);
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
    const stop = subscribeNative(
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
      volumeOperation.current += 1;
      stop();
      surfacePlacement(surfaceOwner.current, { action: 'hide' });
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
  useLayoutEffect(() => {
    if (!nativeAvailable()) return;
    let frame = 0;
    let disposed = false;
    let placementVersion = 0;
    const marked = new Set<HTMLElement>();
    const focusBeforeHide = new Map<HTMLElement, HTMLElement>();
    const measuredCards = new Map<HTMLElement, string>();
    const revealCards = () => {
      const top = activeModalRef.current;
      const target = top && marked.has(top) ? focusBeforeHide.get(top) ?? top : undefined;
      for (const element of marked) delete element.dataset.nativeOcclusion;
      // visibility:hidden can move focus to BODY while the native exclusion is
      // pending. Restore only that lost focus in the current top modal; newer
      // child/other-modal focus and input selection must remain untouched.
      if (target && top?.isConnected && document.hasFocus() && document.activeElement === document.body) {
        const connectedTarget = target.isConnected && top.contains(target) ? target : top;
        connectedTarget.focus({ preventScroll: true });
        if (document.activeElement === document.body) top.focus({ preventScroll: true });
      }
      marked.clear();
      focusBeforeHide.clear();
    };
    setSurfaceError('');
    const measure = () => {
        frame = 0;
        if (disposed) return;
        const rect = viewport.current?.getBoundingClientRect();
        const main = viewport.current
          ?.closest('.page-content')
          ?.getBoundingClientRect();
        const windowRect = { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight };
        const pageClip = main ? intersection(surfaceRect(main), windowRect) : windowRect;
        const clip = rect ? intersection(surfaceRect(rect), pageClip) : pageClip;
        const occlusions: PlayerSurfaceRect[] = [];
        for (const element of occludingElements) {
          if (!element.isConnected) continue;
          const card = surfaceRect(element.getBoundingClientRect());
          const overlap = intersection(card, clip);
          if (overlap.width <= 0 || overlap.height <= 0) continue;
          occlusions.push(card);
          const signature = JSON.stringify(card);
          if (measuredCards.get(element) !== signature) {
            if (document.activeElement instanceof HTMLElement && element.contains(document.activeElement)) {
              focusBeforeHide.set(element, document.activeElement);
            }
            element.dataset.nativeOcclusion = 'pending';
            marked.add(element);
            measuredCards.set(element, signature);
          }
        }
        const version = ++placementVersion;
        const hidden =
          !loaded ||
          !rect ||
          rect.width < 1 ||
          rect.height < 1 ||
          clip.width < 1 || clip.height < 1 ||
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
                clip,
                occlusions,
                inputBlocked: surfaceHidden || interactionsDisabled,
              },
            };
        surfacePlacement(surfaceOwner.current, request, error => {
          if (disposed || version !== placementVersion) return;
          if (error) {
            setSurfaceError(String(error));
            // An explicit display error must never leave the native HWND over
            // an inaccessible dialog. This is failure recovery, not modal policy.
            surfacePlacement(surfaceOwner.current, { action: 'hide' }, revealCards);
          } else {
            revealCards();
            if (!hidden) setSurfaceError('');
          }
        });
    };
    const update = () => {
      // Do not postpone a scheduled measurement on every ResizeObserver tick.
      // The last animation frame is measured even when an older IPC is pending.
      if (!frame) frame = window.requestAnimationFrame(measure);
    };
    const visibility = () => {
      if (document.hidden) {
        window.cancelAnimationFrame(frame);
        frame = 0;
        surfacePlacement(surfaceOwner.current, { action: 'hide' });
      } else update();
    };
    const observer = new ResizeObserver(update);
    if (viewport.current) observer.observe(viewport.current);
    const scrollContainer = viewport.current?.closest('.page-content');
    if (scrollContainer) observer.observe(scrollContainer);
    for (const element of occludingElements) observer.observe(element);
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    document.addEventListener('visibilitychange', visibility);
    // New opaque cards are withheld until their region has been acknowledged;
    // the uncovered video keeps rendering with unchanged geometry.
    measure();
    return () => {
      disposed = true;
      revealCards();
      window.cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
      document.removeEventListener('visibilitychange', visibility);
    };
  }, [loaded, surfaceHidden, occludingElements, interactionsDisabled, media.id, surfaceAttempt]);
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
      {t('区間リピート', 'Repeat range')}
    </Button>
  );
  return (
    <>
      <section className="player-card" aria-label={t('メディアプレイヤー', 'Media player')}>
        <div ref={viewport} className="native-player-viewport" data-testid="native-player-viewport">
          <MotionSwap stateKey={`${loadStatus}:${loadError}`} className="video-placeholder" disabled>
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
          </MotionSwap>
          {loaded && <button ref={surfaceButton} type="button" className="player-surface-toggle"
            disabled={interactionsDisabled || surfaceHidden || settingsOpen}
            aria-label={state?.paused !== false ? t('映像を再生', 'Play video') : t('映像を一時停止', 'Pause video')}
            onClick={toggleSurface} />}
        </div>
        <fieldset className="player-controls" disabled={interactionsDisabled}>
          <div className="seek-control">
            <input
              type="range" min="0" max={Math.max(duration, 1)} step="100"
              value={Math.min(position, duration || 1)}
              data-motion-immediate={seekDraft !== null ? '' : undefined}
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
              style={{ '--playback-progress': `${duration ? (position / duration) * 100 : 0}%` } as React.CSSProperties}
            />
          </div>
          <div className="player-control-row">
            <div className="control-cluster player-transport">
              <Button className="player-skip" variant="ghost" aria-label={t('5 秒戻る', 'Back 5 seconds')} disabled={!loaded} onClick={() => void control({ action: 'seek', value: Math.max(0, position - 5000) })}>
                <RotateCcw size={18} />{t('5秒', '5s')}
              </Button>
              <Button className="play-button" aria-label={state?.paused !== false ? t('再生', 'Play') : t('一時停止', 'Pause')} disabled={!loaded} onClick={() => void control({ action: state?.paused ? 'play' : 'pause' })}>
                <MotionSwap as="span" stateKey={state?.paused !== false ? 'play' : 'pause'}>{state?.paused !== false ? <Play size={19} fill="currentColor" /> : <Pause size={19} fill="currentColor" />}</MotionSwap>
                <span>{state?.paused !== false ? t('再生', 'Play') : t('一時停止', 'Pause')}</span>
              </Button>
              <Button className="player-skip" variant="ghost" aria-label={t('5 秒進む', 'Forward 5 seconds')} disabled={!loaded} onClick={() => void control({ action: 'seek', value: Math.min(duration, position + 5000) })}>
                <RotateCw size={18} />{t('5秒', '5s')}
              </Button>
              <span className="player-time"><AnimatedValue value={timestamp(position)} immediate={seekDraft !== null} /> <span className="player-duration">/ <AnimatedValue value={timestamp(duration)} /></span></span>
            </div>
            <div className="control-cluster player-options">
              <label className="speed-select">
                <span aria-hidden="true">{t('速度', 'Speed')}</span>
                <select aria-label={t('再生速度', 'Playback speed')} value={state?.rate || 1} disabled={!loaded} onChange={(event) => void control({ action: 'rate', value: Number(event.target.value) })}>
                  {[0.5, 0.75, 1, 1.25, 1.5, 1.75, 2].map((rate) => <option key={rate} value={rate}>{rate}×</option>)}
                </select>
                <ChevronDown size={12} />
              </label>
              <VolumeControl key={media.id} value={state?.volume ?? 80} disabled={controlsDisabled}
                label={t('音量', 'Volume')} onChange={changeVolume} />
              {onSettingsOpen && <Button className="player-settings" variant="ghost" aria-haspopup="dialog"
                disabled={interactionsDisabled} onClick={onSettingsOpen}>
                <Settings2 size={16} />{t('再生設定', 'Playback settings')}
              </Button>}
              <IconButton label={t('全画面表示を切り替える', 'Toggle fullscreen')} aria-pressed={fullscreen} disabled={!loaded} onClick={() => {
                const next = !fullscreen;
                setFullscreen(next);
                void control({ action: 'fullscreen', value: next ? 1 : 0 });
              }}>
                <Maximize size={17} />
              </IconButton>
            </div>
          </div>
          <MotionRegion open={!repeatTarget && draftMode && !!selected}>{repeatButton}</MotionRegion>
        </fieldset>
      </section>
      <MotionRegion open={!!surfaceError} mode="status">{surfaceError && <div className="notice warning" role="alert">
        <span>{t('映像を表示できませんでした。', 'The video could not be displayed.')} {surfaceError}</span>
        <Button onClick={() => setSurfaceAttempt(value => value + 1)}>{t('映像表示を再試行', 'Retry video display')}</Button>
      </div>}</MotionRegion>
      {repeatTarget && createPortal(repeatButton, repeatTarget)}
      {settingsOpen && (
        <Modal {...settingsExit.modalProps} title={t('再生設定', 'Playback settings')} onClose={() => void settingsExit.close(onSettingsClose)}>
          <div className="track-controls">
            {(['audio', 'sub'] as const).map((kind) => {
              const tracks = state?.tracks.filter((track) => track.kind === kind) || [];
              return tracks.length > 0 && (
                <label key={kind} className="field">
                  <span>{kind === 'audio' ? t('学習する音声', 'Study audio') : t('学習用の字幕ソース', 'Study subtitle source')}</span>
                  <select
                    aria-label={kind === 'audio' ? t('音声トラック', 'Audio track') : t('字幕トラック', 'Subtitle track')}
                    disabled={controlsDisabled}
                    value={tracks.find((track) => track.selected)?.id ?? 0}
                    onChange={(event) => void (kind === 'audio'
                      ? selectAudio(Number(event.target.value))
                      : control({ action: 'track', trackKind: kind, value: Number(event.target.value) }))}
                  >
                    {kind === 'sub' && <option value={0}>{t('選択なし', 'None selected')}</option>}
                    {tracks.map((track) => (
                      <option key={track.id} value={track.id}>
                        {[track.language, track.title || `${kind} ${track.id}`].filter(Boolean).join(' · ')}
                      </option>
                    ))}
                  </select>
                  {kind === 'sub' && <small className="helper-text">{t('字幕はプレイヤーの下に表示します。埋め込み字幕はここから学習用に取り込めます。', 'Captions appear below the player. You can import embedded captions here for study.')}</small>}
                  {kind === 'sub' && onUseStudySubtitles && (() => {
                    const selectedTrack = tracks.find(track => track.selected);
                    return selectedTrack && !selectedTrack.external && selectedTrack.ffIndex != null && <Button
                      disabled={controlsDisabled}
                      onClick={() => void settingsExit.close(() => {
                        onSettingsClose();
                        onUseStudySubtitles(selectedTrack.ffIndex!);
                      })}
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
