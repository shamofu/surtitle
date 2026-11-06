// SPDX-License-Identifier: GPL-3.0-or-later
import type { AppSettings } from '../../shared/contracts/settings';
import type { AiProvider } from '../../shared/contracts/ai';

export const providerLabel = (provider: AiProvider) => provider === 'openai' ? 'OpenAI' : 'Vertex AI';
export const activeProvider = (settings?: AppSettings): AiProvider => settings?.activeProvider ?? 'vertex';
export const providerProfile = (settings?: AppSettings) => activeProvider(settings) === 'openai' ? settings?.openai : settings;
export const providerConfigured = (settings?: AppSettings) => !!providerProfile(settings)?.credentialConfigured &&
  (activeProvider(settings) === 'openai' || !!settings?.vertexProject);
export const providerConfigurationKey = (settings?: AppSettings) => JSON.stringify([activeProvider(settings), settings?.aiConfigurationGeneration ?? 0]);

export interface AiConfiguration { provider: AiProvider; aiConfigurationGeneration: number }
export const aiConfiguration = (settings?: AppSettings): AiConfiguration => ({ provider: activeProvider(settings), aiConfigurationGeneration: settings?.aiConfigurationGeneration ?? 0 });
