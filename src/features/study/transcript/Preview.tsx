// SPDX-License-Identifier: GPL-3.0-or-later
import { useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Play } from 'lucide-react';

import type { ReviewCue } from '../../../shared/contracts/transcript';
import type { ReviewText } from '../../../shared/contracts/transcript';

import { useAppearance } from '../../../app/runtime';
import { timestamp } from '../../../shared/format';
import { AnimatedValue, MotionSwap } from '../../../shared/motion';
import { Badge } from '../../../shared/ui/index';

export function DraftCues({
  cues,
  play,
}: {
  cues: ReviewCue[];
  play: (cue: ReviewText) => void;
}) {
  const { t } = useAppearance();
  const scroll = useRef<HTMLDivElement>(null);
  const virtual = useVirtualizer({
    count: cues.length,
    getScrollElement: () => scroll.current,
    estimateSize: () => 84,
    overscan: 6,
  });
  return (
    <div
      className="draft-cues"
      ref={scroll}
      aria-label={t('採用前の字幕', 'Subtitle draft')}
    >
      <div
        className="virtual-transcript"
        style={{ height: virtual.getTotalSize() }}
      >
        {virtual.getVirtualItems().map((item) => {
          const cue = cues[item.index];
          return (
            <article
              className="draft-cue"
              key={cue.id}
              data-index={item.index}
              ref={virtual.measureElement}
              style={{ transform: `translateY(${item.start}px)` }}
            >
              <button className="segment-time" onClick={() => play(cue)}>
                <Play size={12} />
                <AnimatedValue value={timestamp(cue.startMs, true)} />
              </button>
              <MotionSwap stateKey={`${cue.text}:${cue.status}`}>
                <p>{cue.text}</p>
                {cue.status === 'provisional' && (
                  <Badge tone="warning">
                    {t('処理中・未確定', 'Pending / provisional')}
                  </Badge>
                )}
              </MotionSwap>
            </article>
          );
        })}
      </div>
    </div>
  );
}

export function Alternatives({
  title,
  segments,
  play,
  disabled = false,
}: {
  title: string;
  segments: ReviewText[];
  play: (cue: ReviewText) => void;
  disabled?: boolean;
}) {
  const { t } = useAppearance();
  return (
    <section className="boundary-alternative">
      <h4>{title}</h4>
      <MotionSwap stateKey={JSON.stringify(segments)}>{segments.length ? (
        segments.map((cue, index) => (
          <div key={index}>
            <button
              className="text-button mono"
              disabled={disabled}
              onClick={() => play(cue)}
            >
              {timestamp(cue.startMs, true)} – {timestamp(cue.endMs, true)}
            </button>
            <p>{cue.text}</p>
          </div>
        ))
      ) : (
        <p className="helper-text">
          {t('この結果に発話はありません。', 'No speech in this result.')}
        </p>
      )}</MotionSwap>
    </section>
  );
}
