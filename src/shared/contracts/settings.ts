// SPDX-License-Identifier: GPL-3.0-or-later
import type { AiPurpose, AiModelPreference } from './ai';

export type ToolId = 'ffmpeg' | 'yt-dlp' | 'deno' | 'vad';

export interface ToolStatus {
  id: ToolId;
  name: string;
  provider: 'managed' | 'external';
  status: 'ready' | 'missing' | 'installing' | 'error';
  version?: string;
  path?: string;
  error?: string;
  canRollback: boolean;
  updateAvailable?: boolean;
  latestVersion?: string;
}

export interface ExternalToolCandidate {
  toolId: ToolId;
  path: string;
  version?: string | null;
  selectable: boolean;
  verification: 'unverified';
  reason?: string | null;
}

export interface AppSettings {
  theme: 'dark' | 'light' | 'system';
  locale: 'ja' | 'en';
  learningLanguage: string;
  explanationLanguage: string;
  dailyBudgetUsd: number;
  vertexProject: string;
  vertexLocation: string;
  credentialConfigured: boolean;
  retention: number;
  sentencePause?: boolean;
  replayContextMs?: number;
  proficiency?: string;
  ytDlpChannel?: 'nightly' | 'stable';
  aiModels?: Partial<Record<AiPurpose, AiModelPreference>>;
}
