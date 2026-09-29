// SPDX-License-Identifier: GPL-3.0-or-later
import { call } from '../../shared/native/transport';
import type {
  ToolId,
  ExternalToolCandidate,
  AppSettings,
} from '../../shared/contracts/settings';

export const settingsApi = {
  importCredential: () => call<void>('import_credential'),
  updateSettings: (settings: AppSettings) =>
    call<void>('update_settings', { settings }),
  updateAppearance: (appearance: {
    locale?: AppSettings['locale'];
    theme?: AppSettings['theme'];
  }) => call<void>('update_appearance', appearance),
  scanExternalTools: (rescan = true) =>
    call<ExternalToolCandidate[]>('scan_external_tools', { rescan }),
  checkToolUpdates: () => call<void>('check_tool_updates'),
  setToolProvider: (request: {
    toolId: ToolId;
    provider: 'managed' | 'external';
    path?: string;
  }) => call<void>('set_tool_provider', { request }),
  installTool: (toolId: ToolId) => call<void>('install_tool', { toolId }),
  updateTool: (toolId: ToolId) => call<void>('update_tool', { toolId }),
  rollbackTool: (toolId: ToolId) => call<void>('rollback_tool', { toolId }),
};
