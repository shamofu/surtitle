// SPDX-License-Identifier: GPL-3.0-or-later
import { useCallback, useMemo } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { queryKeys } from './keys';
import type { DataChange } from './keys';
import { mutateData } from './mutations';

/** Mutating a resource does not require subscribing to the entire app snapshot. */
export function useDataActions() {
  const client = useQueryClient();
  const refresh = useCallback(async () => {
    await client.invalidateQueries({ queryKey: queryKeys.snapshot });
  }, [client]);
  const mutate = useCallback(
    <T>(action: () => Promise<T>, change: DataChange) =>
      mutateData(client, action, change),
    [client],
  );
  return useMemo(() => ({ refresh, mutate }), [refresh, mutate]);
}
