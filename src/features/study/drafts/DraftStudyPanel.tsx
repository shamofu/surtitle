// SPDX-License-Identifier: GPL-3.0-or-later
import { AnimatedDetails } from '../../../shared/ui/AnimatedDetails';
import { useDraftStudy, PAGE_SIZE, BLOCK_PAGE_SIZE } from './useDraftStudy';
import { cueOrigin } from './provenance';
import { DraftSelectionEditor } from './DraftSelectionEditor';

import type { PlayRange } from './lifecycle';
// SPDX-License-Identifier: GPL-3.0-or-later

import { BookmarkPlus, Play } from 'lucide-react';

import type { Media } from '../../../shared/contracts/media';

import { useAppearance, useNotifications } from '../../../app/runtime';

import { timestamp } from '../../../shared/format';

import { Badge, Button, EmptyState, Field } from '../../../shared/ui/index';
import './draft-study.css';

export function DraftStudyPanel(props: {
  media: Media;
  onPlay: PlayRange;
  onReview: (jobId: string) => void;
  playbackReady: boolean;
  onAddSubtitles?: () => void;
  onEstimate?: () => void;
}) {
  // A media switch drops editor state before any late asynchronous result can be shown.
  return <DraftStudyContent key={props.media.id} {...props} />;
}

function DraftStudyContent({
  media,
  onPlay,
  onReview,
  playbackReady,
  onAddSubtitles,
  onEstimate,
}: {
  media: Media;
  onPlay: PlayRange;
  onReview: (jobId: string) => void;
  playbackReady: boolean;
  onAddSubtitles?: () => void;
  onEstimate?: () => void;
}) {
  const { t } = useAppearance();
  const { report } = useNotifications();
  const {
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
  } = useDraftStudy(media);
  const originLabel = (origin: string) =>
    origin === 'manual'
      ? t('手動修正', 'Manual correction')
      : origin === 'mixed'
        ? t('AI・手動の下書き', 'AI / manual draft')
        : origin === 'ai'
          ? t('AIの下書き', 'AI draft')
          : t('出所は全体の確認画面を参照', 'See full review for provenance');
  if (!jobs.length && !bookmarks.length && !loading && !error)
    return (
      <EmptyState icon={<BookmarkPlus size={26} />} title={t('下書きはまだありません', 'No drafts yet')}
        description={t('字幕を読み込むか、文字起こしを見積もれます。届いた区間から原音を確認できます。', 'Import subtitles or estimate a transcription. You can check each received passage against the audio.')}>
        {onAddSubtitles && <Button onClick={onAddSubtitles}>{t('字幕を読み込む', 'Import subtitles')}</Button>}
        {onEstimate && <Button variant="ghost" onClick={onEstimate}>{t('文字起こしを見積もる', 'Estimate transcription')}</Button>}
      </EmptyState>
    );

  return (
    <section
      className="draft-study"
      aria-label={t('下書きから学ぶ', 'Study from drafts')}
    >
      <header className="draft-study-heading">
        <div>
          <h2>
            {t(
              '気になるところから、学び始める',
              'Start with a moment that interests you',
            )}
          </h2>
          <p>
            {t(
              '受信済みの下書きを読み、必要な表現だけ原音で確認できます。',
              'Read available drafts and check the phrases you want to learn against the audio.',
            )}
          </p>
        </div>
        <Badge tone="warning">{t('下書き', 'Draft')}</Badge>
      </header>
      {error && (
        <p className="notice warning" role="status">
          {t('下書きの更新に失敗しました。', 'Could not refresh drafts.')}{' '}
          {error}{' '}
          <Button onClick={() => setRefresh((value) => value + 1)}>
            {t('再読込', 'Reload')}
          </Button>
        </p>
      )}
      {jobs.length > 0 && (
        <Field label={t('文字起こしの下書き', 'Transcription draft')}>
          <select
            value={jobId || ''}
            disabled={busy}
            onChange={(event) => {
              setChosenJob(event.target.value);
              setActive(undefined);
            }}
          >
            {jobs.map((job, index) => (
              <option key={job.id} value={job.id}>
                {index + 1}. {job.createdAt} · {job.status}
              </option>
            ))}
          </select>
        </Field>
      )}
      {loading && !view && (
        <p role="status">{t('下書きを読み込み中…', 'Loading drafts…')}</p>
      )}
      {view && (
        <>
          <div className="scope-heading">
            <span>
              {timestamp(view.draft.startMs)}–{timestamp(view.draft.endMs)} ·{' '}
              {cues.length} {t('字幕', 'subtitles')}
            </span>
            <Button onClick={() => onReview(view.jobId)}>
              {t('全体を確認・採用', 'Review or adopt the full result')}
            </Button>
          </div>
          {(view.draft.pendingRanges.length > 0 ||
            view.draft.conflicts.some((conflict) => !conflict.resolution)) && (
            <p className="helper-text">
              {t(
                '未受信・要確認の区間があります。ほかの区間から学習を続けられます。',
                'Some ranges are pending or need review. You can keep studying other moments.',
              )}
            </p>
          )}
          <div
            className="draft-study-cues"
            role="list"
            aria-label={t('利用できる下書き字幕', 'Available draft subtitles')}
          >
            {cues
              .slice(effectivePage * PAGE_SIZE, (effectivePage + 1) * PAGE_SIZE)
              .map((cue) => {
                const conflict = view.draft.conflicts.some(
                  (item) =>
                    !item.resolution &&
                    item.startMs < cue.endMs &&
                    item.endMs > cue.startMs,
                );
                return (
                  <article
                    key={cue.id}
                    role="listitem"
                    className="draft-study-cue"
                  >
                    <input
                      type="checkbox"
                      aria-label={t(
                        `字幕を選ぶ: ${cue.text}`,
                        `Select subtitle: ${cue.text}`,
                      )}
                      checked={selectedIds.includes(cue.id)}
                      disabled={busy}
                      onChange={(event) =>
                        setSelectedIds((ids) =>
                          event.target.checked
                            ? [...ids, cue.id]
                            : ids.filter((id) => id !== cue.id),
                        )
                      }
                    />
                    <div>
                      <p>{cue.text}</p>
                      <div className="draft-study-meta">
                        <Badge>{originLabel(cueOrigin(cue, view))}</Badge>
                        <span>{t('字幕区間', 'Subtitle interval')}</span>
                        {(conflict || cue.status === 'provisional') && (
                          <Badge tone="warning">
                            {conflict
                              ? t('候補が競合', 'Conflicting alternatives')
                              : t('つなぎ目は未確定', 'Join not finalized')}
                          </Badge>
                        )}
                      </div>
                    </div>
                    <Button
                      disabled={!playbackReady || busy}
                      onClick={() =>
                        void report(async () => {
                          await onPlay(cue);
                        })
                      }
                    >
                      <Play size={13} />
                      {timestamp(cue.startMs, true)}–
                      {timestamp(cue.endMs, true)}
                    </Button>
                  </article>
                );
              })}
            {!cues.length && (
              <p className="helper-text">
                {t(
                  '時刻付きの下書きはまだありません。音声区間を開いて、保存済みの本文を確認できます。',
                  'No timed draft is available yet. Open a source audio range to inspect any saved text.',
                )}
              </p>
            )}
          </div>
          {cues.length > PAGE_SIZE && (
            <div className="draft-study-pagination">
              <Button
                disabled={effectivePage === 0}
                onClick={() => setPage(effectivePage - 1)}
              >
                {t('前へ', 'Previous')}
              </Button>
              <span>
                {effectivePage + 1} / {Math.ceil(cues.length / PAGE_SIZE)}
              </span>
              <Button
                disabled={(effectivePage + 1) * PAGE_SIZE >= cues.length}
                onClick={() => setPage(effectivePage + 1)}
              >
                {t('次へ', 'Next')}
              </Button>
            </div>
          )}
          <div className="inline-actions">
            <Button
              disabled={busy || !consecutive}
              onClick={() =>
                void prepare({
                  jobId: view.jobId,
                  cueIds: chosen.map((cue) => cue.id),
                })
              }
            >
              <BookmarkPlus size={15} />
              {t('選んだ字幕をあとで確認', 'Keep selected subtitles for later')}
            </Button>
            {selectedIds.length > 0 && (
              <Button disabled={busy} onClick={() => setSelectedIds([])}>
                {t('選択を解除', 'Clear selection')}
              </Button>
            )}
          </div>
          {selectedIds.length > 0 && !consecutive && (
            <p className="helper-text">
              {t(
                '隣り合う字幕を50件以内で選んでください。更新で字幕が変わった場合は選び直してください。',
                'Select up to 50 consecutive subtitles. Reselect if the draft has changed.',
              )}
            </p>
          )}
          <AnimatedDetails className="draft-study-blocks">
            <summary>
              {t(
                '音声区間と保存された本文',
                'Source audio ranges and saved text',
              )}
            </summary>
            <p className="helper-text">
              {t(
                'ここで表示する時刻は取得元の音声範囲です。本文の単語や文に対応する時刻ではありません。',
                'These times identify the source audio block. They do not locate individual words or sentences in its text.',
              )}
            </p>
            {chunks
              .slice(
                effectiveBlockPage * BLOCK_PAGE_SIZE,
                (effectiveBlockPage + 1) * BLOCK_PAGE_SIZE,
              )
              .map((chunk) => (
                <article key={chunk.ordinal} className="draft-study-block">
                  <div className="scope-heading">
                    <strong>
                      {t('音声区間', 'Source block')} {chunk.ordinal + 1} ·{' '}
                      {timestamp(chunk.requestStartMs, true)}–
                      {timestamp(chunk.requestEndMs, true)}
                    </strong>
                    <Badge
                      tone={chunk.status === 'pending' ? 'warning' : 'neutral'}
                    >
                      {chunk.status === 'pending'
                        ? t('字幕の時刻が未確定', 'Subtitle timing unavailable')
                        : originLabel(
                            chunk.source === 'manual' ? 'manual' : 'ai',
                          )}
                    </Badge>
                  </div>
                  <div className="inline-actions">
                    <Button
                      disabled={!playbackReady || busy}
                      onClick={() =>
                        void report(async () => {
                          await onPlay({
                            startMs: chunk.requestStartMs,
                            endMs: chunk.requestEndMs,
                          });
                        })
                      }
                    >
                      <Play size={13} />
                      {t('取得元の音声を聴く', 'Play source block')}
                    </Button>
                    <Button
                      disabled={busy || reading !== undefined}
                      onClick={() => void readSource(chunk.ordinal)}
                    >
                      {t('保存済みの本文を表示', 'Show saved text')}
                    </Button>
                    <Button
                      disabled={busy}
                      onClick={() =>
                        void prepare({
                          jobId: view.jobId,
                          ordinal: chunk.ordinal,
                        })
                      }
                    >
                      <BookmarkPlus size={13} />
                      {t(
                        'この音声区間をあとで確認',
                        'Keep this source block for later',
                      )}
                    </Button>
                  </div>
                  {sourceText[chunk.ordinal] !== undefined && (
                    <div className="draft-study-raw">
                      {sourceText[chunk.ordinal] === null ? (
                        <p className="helper-text">
                          {t(
                            '表示できる本文がありません。原音を聴いて入力するか、全体の確認画面で保存応答を確認してください。',
                            'No unambiguous saved text is available. Listen and enter text, or inspect the response in the full review.',
                          )}
                        </p>
                      ) : (
                        <>
                          <Badge>
                            {t(
                              'AI本文・時刻との対応は未確認',
                              'AI text · no verified text timing',
                            )}
                          </Badge>
                          <p>{sourceText[chunk.ordinal]}</p>
                        </>
                      )}
                    </div>
                  )}
                </article>
              ))}
            {chunks.length > BLOCK_PAGE_SIZE && (
              <div className="draft-study-pagination">
                <Button
                  disabled={!effectiveBlockPage}
                  onClick={() => setBlockPage(effectiveBlockPage - 1)}
                >
                  {t('前の音声区間', 'Previous source blocks')}
                </Button>
                <span>
                  {effectiveBlockPage + 1} /{' '}
                  {Math.ceil(chunks.length / BLOCK_PAGE_SIZE)}
                </span>
                <Button
                  disabled={
                    (effectiveBlockPage + 1) * BLOCK_PAGE_SIZE >= chunks.length
                  }
                  onClick={() => setBlockPage(effectiveBlockPage + 1)}
                >
                  {t('次の音声区間', 'Next source blocks')}
                </Button>
              </div>
            )}
          </AnimatedDetails>
        </>
      )}
      {!!bookmarks.length && (
        <div className="draft-study-bookmarks">
          <h3>{t('あとで確認する表現', 'Kept for review')}</h3>
          <div className="draft-study-bookmark-list">
            {bookmarks.map((bookmark) => (
              <button
                key={bookmark.id}
                className={active?.id === bookmark.id ? 'selected' : ''}
                disabled={busy}
                onClick={() => setActive(bookmark)}
              >
                <span>
                  {bookmark.text.trim() ||
                    t('本文を入力する音声区間', 'Source block awaiting text')}
                </span>
                <small>
                  {timestamp(bookmark.startMs)}–{timestamp(bookmark.endMs)} ·{' '}
                  {bookmark.confirmed
                    ? t('学習用に確認済み', 'Checked for learning')
                    : t('未確認', 'Not checked')}
                </small>
              </button>
            ))}
          </div>
        </div>
      )}
      {active && (
        <DraftSelectionEditor
          key={`${active.id}:${active.version}`}
          selection={{
            ...active,
            canConfirm:
              bookmarks.find((item) => item.id === active.id)?.canConfirm ??
              active.canConfirm,
            blockingReasons:
              bookmarks.find((item) => item.id === active.id)
                ?.blockingReasons ?? active.blockingReasons,
          }}
          stale={
            active.stale ||
            !bookmarks.some((item) => item.id === active.id) ||
            bookmarks.some(
              (item) =>
                item.id === active.id &&
                (item.version !== active.version || item.stale),
            )
          }
          playbackReady={playbackReady}
          onPlay={onPlay}
          onSaved={saved}
          onClose={() => setActive(undefined)}
          onRemoved={removeActive}
        />
      )}
    </section>
  );
}
