// SPDX-License-Identifier: GPL-3.0-or-later
import type { SubtitleSegment } from '../../shared/contracts/media';
export type SelectedContext = SubtitleSegment & { sourceCueIds?: string[] };

export function resolveSourceSelection(
  segments: SubtitleSegment[],
  mediaId: string,
  selectedId: string | undefined,
  selectedCueIds: string[],
) {
  const selectedFirst = segments.find((item) => item.id === selectedId);
  const selectedCues = selectedCueIds
    .map((id) => segments.find((item) => item.id === id))
    .filter((cue): cue is SubtitleSegment => !!cue);
  const firstIndex = segments.findIndex(
    (item) => item.id === selectedCueIds[0],
  );
  const missingOrReorderedSelection =
    !!selectedId &&
    (!selectedFirst ||
      (selectedCueIds.length > 1 &&
        (firstIndex < 0 ||
          selectedCues.length !== selectedCueIds.length ||
          !selectedCueIds.every((id, offset) => {
            const cue = segments[firstIndex + offset];
            return (
              cue?.id === id &&
              cue.mediaId === mediaId &&
              (!cue.status || cue.status === 'confirmed')
            );
          }))));
  const selected: SelectedContext | undefined = missingOrReorderedSelection
    ? undefined
    : selectedFirst && selectedCueIds.length > 1
      ? {
          ...selectedFirst,
          sourceCueIds: selectedCueIds,
          endMs: Math.max(...selectedCues.map((cue) => cue.endMs)),
          text: selectedCues.map((cue) => cue.text).join('\n'),
          translation: selectedCues.every((cue) => cue.translation?.trim())
            ? selectedCues.map((cue) => cue.translation).join('\n')
            : undefined,
          status: selectedCues.every(
            (cue) => !cue.status || cue.status === 'confirmed',
          )
            ? 'confirmed'
            : 'provisional',
        }
      : selectedFirst;

  return { selected, missingOrReorderedSelection };
}
