// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, it } from 'vitest';
import fixture from '../../src-tauri/fixtures/data-change.json';
import responses from '../../src-tauri/fixtures/command-results.json';
import { isDataChange, isChangeCheckpoint } from '../shared/contracts/synchronization';
import { validateCommand, validateCommandResult, type CommandName } from '../shared/native/commands';
import { call } from '../shared/native/transport';
import { validNativeEvent } from '../shared/native/event-contracts';
import type { UiDraft } from '../shared/contracts/editing';

it('accepts the same native serialization fixture and rejects malformed or newer protocol data', () => {
  expect(isDataChange(fixture)).toBe(true);
  expect(validNativeEvent('data-changed', fixture)).toBe(true);
  expect(isDataChange({ ...fixture, domain: 'playback' })).toBe(false);
  expect(isDataChange({ ...fixture, version: 2 })).toBe(false);
  expect(isDataChange({ ...fixture, revision: 1.5 })).toBe(false);
  expect(isDataChange({ ...fixture, entityId: 5 })).toBe(false);
  expect(isDataChange({ ...fixture, accidentalField: true })).toBe(false);
  expect(isChangeCheckpoint({ version: 1, epoch: 'session', revision: 3, domains: [{ domain: 'cards', revision: 4 }] })).toBe(false);
});

it('validates command-specific return envelopes serialized by Rust', () => {
  for (const [name, value] of Object.entries(responses)) expect(() => validateCommandResult(name as CommandName, value)).not.toThrow();
  expect(() => validateCommandResult('list_ui_drafts', {})).toThrow('Invalid native result');
  expect(() => validateCommandResult('select_media_files', [1])).toThrow('Invalid native result');
  expect(() => validateCommandResult('import_subtitles', null)).toThrow('Invalid native result');
  expect(() => validateCommandResult('commit_subtitle_editor_draft', {})).toThrow('Invalid native result');
  expect(() => validateCommandResult('get_snapshot_patch', [])).toThrow('Invalid native result');
  expect(() => validateCommandResult('restore_learning', {})).toThrow('Invalid native result');
  expect(() => validateCommandResult('restore_learning', { warnings: [false] })).toThrow('Invalid native result');
  const archive: UiDraft = { kind: 'card', entityId: 'card-1', revision: 8, fields: { term: 'unfinished' }, updatedAt: '2026-10-11T00:00:00Z', stale: true, archiveId: 'archive-1' };
  expect(responses.archive_ui_draft).toEqual(archive);
});

it('checks command names, exact argument envelopes and finite primitive payloads before IPC', () => {
  expect(() => validateCommand('get_app_snapshot', undefined)).not.toThrow();
  expect(() => validateCommand('list_segments', { mediaId: 'media' })).not.toThrow();
  expect(() => validateCommand('extract_embedded_subtitles', { mediaId: 'media', streamIndex: 2, operationId: undefined })).not.toThrow();
  expect(() => validateCommand('list_segment', { mediaId: 'media' })).toThrow('Unknown native command');
  expect(() => validateCommand('list_segments', { media_id: 'media' })).toThrow('Invalid arguments');
  expect(() => validateCommand('extract_embedded_subtitles', { mediaId: 'media' })).toThrow('streamIndex');
  expect(() => validateCommand('get_snapshot_patch', { domains: ['player'] })).toThrow('domains');
  expect(() => validateCommand('rate_card', { cardId: 'card', rating: 1 })).toThrow('rating');
  expect(() => validateCommand('extract_embedded_subtitles', { mediaId: 'media', streamIndex: NaN })).toThrow('streamIndex');
});

// These assertions are compiled by tsc and never issue IPC.
if (false) {
  // @ts-expect-error result types come from the command and cannot be chosen by a caller
  void call<string>('get_app_snapshot');
  // @ts-expect-error the actual command result is an AppSnapshot
  const forged: Promise<string> = call('get_app_snapshot');
  void forged;
  // @ts-expect-error a typo is not a native command
  void call('list_segment', { mediaId: 'media' });
  // @ts-expect-error required native arguments cannot be omitted
  void call('list_segments');
  // @ts-expect-error argument names follow Tauri's camelCase wire format
  void call('list_segments', { media_id: 'media' });
}
