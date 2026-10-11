// SPDX-License-Identifier: GPL-3.0-or-later
import { call } from '../../shared/native/transport';
import type { ToolId, AppSettings } from '../../shared/contracts/settings';

export const settingsApi = {
  state: () => call('get_settings_state'),
  patch: (expectedRevision: string, patch: Record<string, unknown>) =>
    call('update_settings_patch', { expectedRevision, patch }),
  importCredential: () => call('import_credential'),
  updateSettings: (settings: AppSettings) =>
    call('update_settings', { settings }),
  updateAppearance: (appearance: {
    locale?: AppSettings['locale'];
    theme?: AppSettings['theme'];
  }) => call('update_appearance', appearance),
  scanExternalTools: (rescan = true) =>
    call('scan_external_tools', { rescan }),
  checkToolUpdates: () => call('check_tool_updates'),
  setToolProvider: (request: {
    toolId: ToolId;
    provider: 'managed' | 'external';
    path?: string;
  }) => call('set_tool_provider', { request }),
  installTool: (toolId: ToolId) => call('install_tool', { toolId }),
  updateTool: (toolId: ToolId) => call('update_tool', { toolId }),
  rollbackTool: (toolId: ToolId) => call('rollback_tool', { toolId }),
};
