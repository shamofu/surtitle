import { call } from '../../../shared/native/transport';
import type { SubtitleSegment } from '../../../shared/contracts/media';

export type EditorKind = 'phrase' | 'subtitle';
export interface EditorDraft {
  id: string;
  mediaId: string;
  kind: EditorKind;
  sourceKey: string;
  version: number;
  fields: Record<string, string>;
  sourceCues: SubtitleSegment[];
  sourceMediaSignature: string;
  bindingVerified: boolean;
  stale: boolean;
  createdAt: string;
  updatedAt: string;
}
export interface EditorDraftReference { id: string; version: number }
export interface EditorDraftInput {
  id: string;
  mediaId: string;
  kind: EditorKind;
  sourceKey: string;
  expectedVersion: number;
  fields: Record<string, string>;
  sourceCues: SubtitleSegment[];
}
const versionReference = ({ id, version }: EditorDraftReference): EditorDraftReference => ({ id, version });
export const editorDraftApi = {
  list: (mediaId: string) => call<EditorDraft[]>('list_editor_drafts', { mediaId }),
  save: (request: EditorDraftInput) => call<EditorDraft>('save_editor_draft', { request }),
  discard: (reference: EditorDraftReference) => call<void>('delete_editor_draft', { reference: versionReference(reference) }),
  rebind: (reference: EditorDraftReference, sourceCues: SubtitleSegment[]) =>
    call<EditorDraft>('rebind_editor_draft', { reference: versionReference(reference), sourceCues }),
  commitSubtitle: (reference: EditorDraftReference, segment: SubtitleSegment) =>
    call<string | null>('commit_subtitle_editor_draft', { reference: versionReference(reference), segment }),
  savePhrase: (reference: EditorDraftReference, request: {
    mediaId: string; segmentId: string; sourceCueIds?: string[];
    sourceRange?: { startMs: number; endMs: number };
    term: string; meaning: string; example: string; explanation?: string; translation?: string;
  }, operationId?: string) => call<void>('save_phrase_editor_draft', { reference: versionReference(reference), request, operationId }),
};

export function editorSourceKey(cues: Pick<SubtitleSegment, 'id'>[]) {
  return JSON.stringify(cues.map(cue => cue.id));
}
