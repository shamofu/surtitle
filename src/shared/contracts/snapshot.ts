// SPDX-License-Identifier: GPL-3.0-or-later
import type { Media } from './media';
import type { StudyCard } from './cards';
import type { ToolStatus, AppSettings } from './settings';
import type { BudgetSummary, JobSummary } from './ai';

export interface AppSnapshot {
  media: Media[];
  cards: StudyCard[];
  tools: ToolStatus[];
  settings: AppSettings;
  jobs: JobSummary[];
  budget: BudgetSummary;
}
