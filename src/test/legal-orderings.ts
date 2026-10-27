// SPDX-License-Identifier: GPL-3.0-or-later
/** Enumerate every topological order; bounds are structural, never filters. */
export function legalOrders<T extends string>(prerequisites: Record<T, readonly NoInfer<T>[]>): T[][] {
  const actions = Object.keys(prerequisites) as T[];
  const result: T[][] = [];
  function visit(prefix: T[]) {
    if (prefix.length === actions.length) { result.push(prefix); return; }
    for (const action of actions) if (!prefix.includes(action) && prerequisites[action].every(before => prefix.includes(before))) visit([...prefix, action]);
  }
  visit([]);
  if (!result.length) throw new Error('Cyclic legal ordering prerequisites');
  return result;
}

export function controlled<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

/** Flush promise continuations without advancing debounce/recovery clocks. */
export async function settle() { for (let i = 0; i < 24; i++) await Promise.resolve(); }
