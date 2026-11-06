import { DatabaseSync } from 'node:sqlite';

function requireThat(value, message) { if (!value) throw new Error(`Live API budget: ${message}`); }
function integer(value, label, min = 0) {
  requireThat(Number.isSafeInteger(value) && value >= min, `invalid ${label}`);
  return value;
}
function safeNumber(value, label) {
  requireThat(value >= 0n && value <= BigInt(Number.MAX_SAFE_INTEGER), `invalid ${label}`);
  return Number(value);
}
// Parse the JSON number's decimal representation; never round a floating product.
function microdollars(value) {
  requireThat(typeof value === 'number' && Number.isFinite(value) && value >= 0, 'unpriced or invalid maximumUsd');
  const match = /^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/.exec(String(value));
  requireThat(match, 'invalid maximumUsd');
  const coefficient = BigInt(match[1] + (match[2] ?? ''));
  const scale = 6 + Number(match[3] ?? 0) - (match[2]?.length ?? 0);
  const divisor = 10n ** BigInt(Math.abs(scale));
  requireThat(scale >= 0 || coefficient % divisor === 0n, 'maximumUsd has fractional microUSD');
  return safeNumber(scale >= 0 ? coefficient * divisor : coefficient / divisor, 'maximumUsd');
}
function withSnapshot(dbPath, callback, timeoutMs = 1000) {
  integer(timeoutMs, 'timeoutMs');
  requireThat(timeoutMs <= 10_000, 'timeoutMs exceeds bounded wait');
  const db = new DatabaseSync(dbPath, {readOnly:true});
  let transactionStarted = false, primaryError;
  try {
    // Native startup/WAL activity may briefly exclude an independent observer.
    // Busy handling waits only; no failed check ever becomes permission to send.
    db.exec(`PRAGMA busy_timeout=${timeoutMs}`);
    db.exec('BEGIN');
    transactionStarted = true;
    return callback(db);
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    let cleanupError;
    try { if (transactionStarted) db.exec('ROLLBACK'); }
    catch (error) { cleanupError = error; }
    try { db.close(); }
    catch (error) { cleanupError ??= error; }
    // Preserve the failing validation/query rather than masking it with cleanup.
    if (!primaryError && cleanupError) throw cleanupError;
  }
}
function rows(db, sql, ...args) {
  const statement = db.prepare(sql);
  statement.setReadBigInts(true);
  return statement.all(...args);
}
function totalsInSnapshot(db) {
  let total = 0n, charged = 0n, held = 0n;
  const unpricedAttemptIds = [], inFlightAttemptIds = [], unknownAttemptIds = [];
  const attempts = rows(db, 'SELECT id,state,reserve_microusd,charged_microusd FROM ai_attempts');
  for (const row of attempts) {
    if (row.state === 'released') requireThat(row.charged_microusd === 0n, 'released attempt lacks explicit zero charge');
    if (row.state === 'reserved') inFlightAttemptIds.push(row.id);
    if (row.state === 'unknown') unknownAttemptIds.push(row.id);
    for (const value of [row.reserve_microusd, row.charged_microusd]) requireThat(value === null || (typeof value === 'bigint' && value >= 0n), 'invalid ledger money');
    const amount = row.charged_microusd ?? row.reserve_microusd;
    if (amount === null) unpricedAttemptIds.push(row.id);
    else { total += amount; if (row.charged_microusd === null) held += amount; else charged += amount; }
  }
  return {totalMicrousd:safeNumber(total,'lifetime total'),chargedMicrousd:safeNumber(charged,'charged total'),heldMicrousd:safeNumber(held,'held total'),attemptCount:attempts.length,unpricedAttemptIds,inFlightAttemptIds,unknownAttemptIds};
}
/** Read every historical attempt from the same dedicated evaluation charges.sqlite.
 * No date filter, no provider filter, no writes, no implicit database creation.
 * Optional timeoutMs waits for transient SQLite locks (default 1000, maximum 10000 ms).
 * Amount is COALESCE(charged_microusd,reserve_microusd), including acknowledged/429 holds.
 */
export function readCampaignTotals(dbPath, {timeoutMs = 1000} = {}) { return withSnapshot(dbPath, totalsInSnapshot, timeoutMs); }

/** Check immediately before EVERY native approval/reapproval, with approvals serialized
 * by the caller. Pass the same dedicated profile DB on every restart. This read-only
 * check cannot lock out a separate writer; the runner must be its sole approval owner.
 * quote is an Object.freeze() snapshot of the actual native AiQuote camelCase object.
 * Caller must explicitly pass capMicrousd (live campaign: 60_000_000).
 * timeoutMs bounds SQLite busy handling (default 1000, maximum 10000 ms).
 * Returns safe integer microUSD totals and additionalMicrousd/projectedMicrousd.
 */
export function assertLiveApproval({dbPath, quote, capMicrousd, expectedJobId = quote?.id,
  maxRequests = 120, maxAudioDurationMs = 5_400_000, maxOutputTokens = 8192, nowMs = Date.now(), timeoutMs = 1000}) {
  integer(capMicrousd,'capMicrousd',1);
  integer(maxRequests,'maxRequests',1); integer(maxAudioDurationMs,'maxAudioDurationMs'); integer(maxOutputTokens,'maxOutputTokens',1);
  requireThat(quote && Object.isFrozen(quote), 'quote must be frozen');
  requireThat(quote.provider === 'openai', 'quote provider must be openai');
  requireThat(typeof expectedJobId === 'string' && quote.id === expectedJobId, 'job identity mismatch');
  requireThat(quote.canApprove === true && quote.unpriced === false, 'quote blocked or unpriced');
  requireThat(Number.isFinite(nowMs) && Number.isFinite(Date.parse(quote.expiresAt)) && Date.parse(quote.expiresAt) > nowMs, 'quote expired');
  const additionalMicrousd = microdollars(quote.maximumUsd);
  const retries = quote.retryPolicy?.maxRetries ?? 0;
  integer(retries,'maxRetries');
  requireThat(!quote.retryPolicy || (quote.retryPolicy.version === 1 && retries === 2), 'invalid retry policy');
  const multiplier = retries + 1;
  for (const key of ['requestCount','maximumRequestCount','sendDurationMs','maximumSendDurationMs','maxOutputTokens','totalOutputTokens','maximumTotalOutputTokens']) integer(quote[key],key);
  requireThat(quote.requestCount > 0 && quote.maximumRequestCount <= maxRequests && quote.maxOutputTokens > 0 && quote.maxOutputTokens <= maxOutputTokens && quote.maximumSendDurationMs <= maxAudioDurationMs, 'scope exceeds bounds');
  requireThat(quote.maximumRequestCount === quote.requestCount * multiplier && quote.maximumSendDurationMs === quote.sendDurationMs * multiplier && quote.maximumTotalOutputTokens === quote.totalOutputTokens * multiplier && quote.totalOutputTokens <= quote.requestCount * quote.maxOutputTokens, 'inconsistent quote scope');
  return withSnapshot(dbPath, db => {
    const totals = totalsInSnapshot(db);
    requireThat(totals.unpricedAttemptIds.length === 0, 'unpriced historical attempts');
    requireThat(totals.inFlightAttemptIds.length === 0, 'in-flight attempt exists');
    requireThat(totals.unknownAttemptIds.length === 0, 'unresolved unknown attempt exists');
    const jobs = rows(db, 'SELECT id,digest,state,plan_json,quote_expires_at_ms FROM ai_jobs');
    const job = jobs.find(row => row.id === expectedJobId);
    requireThat(job && job.digest === quote.digest, 'job/digest mismatch');
    requireThat(JSON.parse(job.plan_json).execution?.provider === 'openai', 'stored provider must be openai');
    requireThat(job.quote_expires_at_ms > BigInt(Math.trunc(nowMs)), 'stored quote expired');
    requireThat(!jobs.some(row => row.state === 'approved'), 'approved job may still dispatch');
    requireThat(['prepared','paused','needs_review'].includes(job.state), 'job is not awaiting approval');
    const projectedMicrousd = safeNumber(BigInt(totals.totalMicrousd) + BigInt(additionalMicrousd),'projected total');
    requireThat(projectedMicrousd <= capMicrousd, 'lifetime cap exceeded');
    return {...totals,additionalMicrousd,projectedMicrousd};
  }, timeoutMs);
}
