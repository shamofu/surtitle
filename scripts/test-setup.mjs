import { setImmediate } from 'node:timers/promises';
import { afterEach } from 'vitest';

// Synchronous Git/Python and filesystem checks can otherwise keep a worker in
// one microtask chain for an entire file. Let Vitest receive progress replies
// between tests, even when the combined work exceeds its RPC deadline.
afterEach(async () => {
  await setImmediate();
});
