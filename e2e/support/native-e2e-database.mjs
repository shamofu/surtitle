// SPDX-License-Identifier: GPL-3.0-or-later
import { DatabaseSync } from 'node:sqlite';

export function withReadOnlyDatabase(path, action, { timeoutMs = 10000 } = {}) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 2147483647) {
    throw new RangeError('SQLite busy timeout must be an integer between 0 and 2147483647 ms');
  }
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    // The native application can briefly lock its WAL while these independent
    // observers inspect it. Wait for that lock without changing stored data.
    database.exec(`PRAGMA busy_timeout = ${timeoutMs}`);
    return action(database);
  } finally { database.close(); }
}
