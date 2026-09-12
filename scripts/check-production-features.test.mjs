// SPDX-License-Identifier: GPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateProductionFeatures } from './check-production-features.mjs';

test('accepts the production graph with unrelated dependency features', () => {
  assert.equal(validateProductionFeatures('surtitle v0.1.0 (local)|custom-protocol\nsurtitle-ai v0.1.0 (local)|\nserde v1.0.0|derive').length, 2);
});
test('rejects resolved development permits and fixture features', () => {
  for (const feature of ['development-validation', 'e2e-fixtures']) {
    assert.throws(() => validateProductionFeatures(`surtitle v0.1.0|custom-protocol\nsurtitle-ai v0.1.0|${feature}`), /Development-only/);
  }
  assert.throws(() => validateProductionFeatures('surtitle v0.1.0|custom-protocol,e2e-test\nsurtitle-ai v0.1.0|'), /Development-only/);
});
test('rejects an incomplete or failed cargo graph', () => {
  assert.throws(() => validateProductionFeatures('error: feature unavailable'), /missing/);
});
