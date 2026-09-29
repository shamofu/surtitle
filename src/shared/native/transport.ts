// SPDX-License-Identifier: GPL-3.0-or-later
import { invoke, isTauri } from '@tauri-apps/api/core';

export const nativeAvailable = () => isTauri();

export async function call<T>(
  command: string,
  args?: Record<string, unknown>,
): Promise<T> {
  if (!nativeAvailable())
    throw new Error(
      'この操作には Surtitle デスクトップアプリが必要です。 / Open Surtitle desktop to use this feature.',
    );
  try {
    return await invoke<T>(command, args);
  } catch (error) {
    throw new Error(
      typeof error === 'string'
        ? error
        : error instanceof Error
          ? error.message
          : JSON.stringify(error),
    );
  }
}
