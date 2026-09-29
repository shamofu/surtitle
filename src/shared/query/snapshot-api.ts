// SPDX-License-Identifier: GPL-3.0-or-later
import { call } from '../native/transport';
import type { AppSnapshot } from '../contracts/snapshot';

export const snapshotApi = {
  snapshot: () => call<AppSnapshot>('get_app_snapshot'),
};
