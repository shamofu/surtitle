// SPDX-License-Identifier: GPL-3.0-or-later
import type { AppSettings } from './settings';
import type { StudyCard } from './cards';

export type DraftKind = 'settings' | 'card' | 'draft_card' | 'import';
export type EditFields = Record<string, string>;
export interface UiDraft {
  kind: DraftKind;
  entityId: string;
  revision: number;
  fields: EditFields;
  updatedAt: string;
  stale: boolean;
  /** Immutable input preserved after a competing write; never automatically applied. */
  archiveId?: string;
}
export interface SettingsState { settings: AppSettings; revision: string }
export interface CardEditState { card: StudyCard; revision: string }
