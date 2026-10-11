// SPDX-License-Identifier: GPL-3.0-or-later
import { invoke, isTauri } from '@tauri-apps/api/core';
import { validateCommand, validateCommandResult, type CommandCall } from './commands';
import type { CommandResults } from './command-registry';

export const nativeAvailable = () => isTauri();

export async function call<const C extends CommandCall>(...[command, args]: C): Promise<CommandResults[C[0]]> {
  validateCommand(command, args);
  if (!nativeAvailable())
    throw new Error(
      'この操作には Surtitle デスクトップアプリが必要です。 / Open Surtitle desktop to use this feature.',
    );
  try {
    const result = await invoke<unknown>(command, args);
    validateCommandResult(command, result);
    return result as CommandResults[C[0]];
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
