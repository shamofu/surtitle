// SPDX-License-Identifier: GPL-3.0-or-later
import type { QueryClient } from '@tanstack/react-query';
import type { AppSettings } from '../../shared/contracts/settings';
import type { EditFields } from '../../shared/contracts/editing';
import { editingSession } from '../../shared/editing/session';
import { settingsApi } from './api';
import { validOutputTokens } from '../ai/ModelEditor';
import { queryKeys } from '../../shared/query/keys';
import type { AppSnapshot } from '../../shared/contracts/snapshot';

const numbers = ['retention', 'replayContextMs', 'dailyBudgetUsd', 'monthlyBudgetUsd', 'perJobBudgetUsd'] as const;
const budgetKeys = ['dailyBudgetUsd', 'monthlyBudgetUsd', 'perJobBudgetUsd'] as const;
const keys = ['locale', 'theme', 'motionPreference', 'captionGapMode', 'learningLanguage', 'explanationLanguage', 'retention', 'sentencePause', 'replayContextMs', 'proficiency', 'vertexLocation', 'dailyBudgetUsd', 'monthlyBudgetUsd', 'perJobBudgetUsd', 'aiModels'] as const;
const openaiBudgetKeys = ['openaiDailyBudgetUsd', 'openaiMonthlyBudgetUsd', 'openaiPerJobBudgetUsd'] as const;
const allKeys = [...keys, 'activeProvider', 'openaiModels', ...openaiBudgetKeys];
export const budgetFieldKey = (key: typeof budgetKeys[number], provider: string) => provider === 'openai' ? `openai${key[0].toUpperCase()}${key.slice(1)}` : key;

export function settingsFields(settings: AppSettings): EditFields {
  const complete = { ...settings, motionPreference: settings.motionPreference ?? 'system', captionGapMode: settings.captionGapMode ?? 'review', replayContextMs: settings.replayContextMs ?? 150,
    sentencePause: settings.sentencePause ?? false, proficiency: settings.proficiency ?? 'B1',
    monthlyBudgetUsd: settings.monthlyBudgetUsd ?? settings.dailyBudgetUsd, perJobBudgetUsd: settings.perJobBudgetUsd ?? settings.dailyBudgetUsd };
  return { ...Object.fromEntries(keys.map(key => [key, key === 'aiModels' ? JSON.stringify(settings.aiModels ?? {}) : String(complete[key] ?? '')])),
    activeProvider: settings.activeProvider ?? 'vertex', openaiModels: JSON.stringify(settings.openai?.aiModels ?? {}),
    ...Object.fromEntries(budgetKeys.map(key => [budgetFieldKey(key, 'openai'), String(settings.openai?.[key] ?? settings.openai?.dailyBudgetUsd ?? 0)])),
    retentionInput: Number.isFinite(settings.retention) ? String(Number((settings.retention * 100).toFixed(4))) : '' };
}
export function settingsFromFields(fields: EditFields, base: AppSettings): AppSettings {
  const next = { ...base } as AppSettings;
  for (const key of keys) {
    if (fields[key] === undefined) continue;
    let value: unknown = fields[key];
    if (numbers.includes(key as typeof numbers[number])) value = fields[key].trim() === '' ? Number.NaN : Number(fields[key]);
    if (key === 'sentencePause') value = fields[key] === 'true';
    if (key === 'aiModels') { try { value = JSON.parse(fields[key]); } catch { continue; } }
    Object.assign(next, { [key]: value });
  }
  next.activeProvider = fields.activeProvider === 'openai' ? 'openai' : 'vertex';
  next.openai = { ...(base.openai ?? { credentialConfigured: false, dailyBudgetUsd: 0 }) };
  if (fields.openaiModels !== undefined) { try { next.openai.aiModels = JSON.parse(fields.openaiModels); } catch { /* retain base */ } }
  for (const key of budgetKeys) {
    const raw = fields[budgetFieldKey(key, 'openai')];
    if (raw !== undefined) next.openai[key] = raw.trim() === '' ? Number.NaN : Number(raw);
  }
  return next;
}
function valid(key: string, value: unknown) {
  if (key === 'captionGapMode') return value === 'review' || value === 'preview';
  if (numbers.includes(key as typeof numbers[number])) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return false;
    if (key === 'retention') return value >= .7 && value <= .97;
    return value >= 0 && value <= 1000 && (key !== 'replayContextMs' || Number.isInteger(value));
  }
  if (['learningLanguage', 'explanationLanguage', 'vertexLocation'].includes(key)) return typeof value === 'string' && value.trim().length > 0;
  if (key === 'aiModels') return Object.values(value as NonNullable<AppSettings['aiModels']>).every(model => !model || validOutputTokens(model.maxOutputTokens));
  return true;
}
export function settingsEditor(client: QueryClient) {
  return editingSession('settings', 'default', {
    draftOnly: ['modelInputs', 'retentionInput'],
    read: async () => { const state = await settingsApi.state(); return { fields: settingsFields(state.settings), revision: state.revision }; },
    save: async (fields, previous) => {
      const current = settingsFromFields(fields, {} as AppSettings);
      const currentFields = settingsFields(current);
      const valueFor = (key: string): unknown => key === 'openaiModels' ? current.openai.aiModels : openaiBudgetKeys.includes(key as typeof openaiBudgetKeys[number]) ? Number(currentFields[key]) : current[key as keyof AppSettings];
      const changed = allKeys.filter(key => fields[key] !== previous.fields[key] && valid(key.startsWith('openai') ? key === 'openaiModels' ? 'aiModels' : `${key[6].toLowerCase()}${key.slice(7)}` : key, valueFor(key)));
      let state = previous;
      // Credential operations change the native revision without changing any
      // editable field. Rebase only that case; edits from another writer still
      // go through the session's normal conflict and input-recovery path.
      const latest = await settingsApi.state();
      const latestFields = settingsFields(latest.settings);
      if (latest.revision !== previous.revision && allKeys.every(key => latestFields[key] === previous.fields[key])) {
        state = { fields: latestFields, revision: latest.revision };
      }
      const applied: string[] = [];
      const normal = changed.filter(key => !budgetKeys.includes(key as typeof budgetKeys[number]) && !openaiBudgetKeys.includes(key as typeof openaiBudgetKeys[number]));
      if (normal.length) {
        const result = await settingsApi.patch(state.revision, Object.fromEntries(normal.map(key => [key, valueFor(key)])));
        client.setQueryData<AppSnapshot>(queryKeys.snapshot, data => data && { ...data, settings: result.settings });
        state = { fields: settingsFields(result.settings), revision: result.revision };
        applied.push(...normal);
        // Each successful transaction reaches the session before another store
        // is written, so a later budget failure cannot hide the new revision.
        return { ...state, applied };
      }
      for (const provider of ['vertex', 'openai'] as const) {
        const budgets = changed.filter(key => budgetKeys.some(budgetKey => key === budgetFieldKey(budgetKey, provider)));
        if (!budgets.length) continue;
        const values = Object.fromEntries(budgetKeys.map(key => {
          const field = budgetFieldKey(key, provider);
          return [key, Number(budgets.includes(field) ? fields[field] : state.fields[field])];
        }));
        const result = await settingsApi.patch(state.revision, { budgets: { provider, ...values } });
        client.setQueryData<AppSnapshot>(queryKeys.snapshot, data => data && { ...data, settings: result.settings });
        state = { fields: settingsFields(result.settings), revision: result.revision };
        applied.push(...budgets);
        return { ...state, applied };
      }
      return { ...state, applied };
    },
  });
}
