// SPDX-License-Identifier: GPL-3.0-or-later
import { call } from '../native/transport';

export const snapshotApi = {
  snapshot: () => call('get_app_snapshot'),
};
