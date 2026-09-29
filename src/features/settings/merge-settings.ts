// SPDX-License-Identifier: GPL-3.0-or-later
import type { AiPurpose } from '../../shared/contracts/ai';
import type { AppSettings } from '../../shared/contracts/settings';

export function equalSetting(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object')
    return false;
  const a = left as Record<string, unknown>,
    b = right as Record<string, unknown>;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].every((key) => equalSetting(a[key], b[key]));
}

export function mergeSettingFields<T extends object>(
  previous: T,
  current: T,
  next: T,
): T {
  const merged = { ...next };
  for (const key of Object.keys({
    ...previous,
    ...current,
    ...next,
  }) as (keyof T)[]) {
    // A newly persisted change wins a same-field conflict. Unrelated local
    // edits survive refreshes without restoring obsolete backend settings.
    if (equalSetting(previous[key], next[key])) merged[key] = current[key];
  }
  return merged;
}

export function mergeSettingsRefresh(
  previous: AppSettings | undefined,
  current: AppSettings | undefined,
  next: AppSettings,
): AppSettings {
  if (!previous || !current) return next;
  const merged = mergeSettingFields(previous, current, next);
  merged.aiModels = {};
  const purposes = Object.keys({
    ...previous.aiModels,
    ...current.aiModels,
    ...next.aiModels,
  }) as AiPurpose[];
  for (const purpose of purposes) {
    const before = previous.aiModels?.[purpose],
      local = current.aiModels?.[purpose],
      saved = next.aiModels?.[purpose];
    const selected =
      before && local && saved
        ? mergeSettingFields(before, local, saved)
        : equalSetting(before, saved)
          ? local
          : saved;
    if (!selected) continue;
    const model = { ...selected };
    if (before && local && saved) {
      // Level and token budget are one exclusive choice, not independent fields.
      const unchanged = equalSetting(
        [before.thinkingLevel, before.thinkingBudget],
        [saved.thinkingLevel, saved.thinkingBudget],
      );
      const thinking = unchanged ? local : saved;
      model.thinkingLevel = thinking.thinkingLevel;
      model.thinkingBudget = thinking.thinkingBudget;
    }
    const localIdentity =
      model.modelId.trim() === local?.modelId.trim() &&
      merged.vertexLocation === current.vertexLocation;
    const savedIdentity =
      model.modelId.trim() === saved?.modelId.trim() &&
      merged.vertexLocation === next.vertexLocation;
    // Prices belong to one model/location. Never combine a preserved local
    // model with a refreshed price for another model, or vice versa.
    if (!localIdentity)
      model.price = savedIdentity ? (saved?.price ?? null) : null;
    else if (!savedIdentity) model.price = local?.price ?? null;
    merged.aiModels[purpose] = model;
  }
  return merged;
}
