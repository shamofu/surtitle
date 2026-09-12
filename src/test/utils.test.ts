// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { activeSegment, dueCards, parseTimestamp, quoteCanBeApproved, timestamp } from '../utils';
import type { StudyCard, SubtitleSegment } from '../api';

describe('long media ranges', () => {
  it('round-trips multi-hour positions and accepts millisecond precision', () => {
    expect(timestamp(6 * 3600 * 1000 + 123000)).toBe('6:02:03');
    expect(parseTimestamp('6:02:03')).toBe(21723000);
    expect(parseTimestamp('01:02.125')).toBe(62125);
    expect(parseTimestamp(' 12.5 ')).toBe(12500);
    expect(parseTimestamp(timestamp(62525, true))).toBe(62525);
  });
  it.each(['-1', '1:60', '1:00:60', '1:1:1:1', '', 'abc', 'Infinity', '99999999999999999999999'])('rejects malformed or unsafe range %s', value => {
    expect(parseTimestamp(value)).toBeNull();
  });
  it('uses exclusive segment ends so the next subtitle activates at its boundary', () => {
    const segments = [{ id: 'first', startMs: 0, endMs: 1000 }, { id: 'second', startMs: 1000, endMs: 2000 }] as SubtitleSegment[];
    expect(activeSegment(segments, 999)).toBe('first');
    expect(activeSegment(segments, 1000)).toBe('second');
    expect(activeSegment(segments, 2000)).toBeUndefined();
  });
});
describe('approval and due state', () => {
  const now = Date.parse('2026-09-08T00:00:00Z');
  it('requires explicit acknowledgement, budget permission, and an unexpired quote', () => {
    const quote = { canApprove: true, expiresAt: new Date(now + 1000).toISOString() };
    expect(quoteCanBeApproved(quote, false, now)).toBe(false);
    expect(quoteCanBeApproved({ ...quote, canApprove: false }, true, now)).toBe(false);
    expect(quoteCanBeApproved(quote, true, now + 1000)).toBe(false);
    expect(quoteCanBeApproved({ ...quote, expiresAt: 'invalid' }, true, now)).toBe(false);
    expect(quoteCanBeApproved(quote, true, now)).toBe(true);
  });
  it('excludes suspended, invalid, and future cards from the due queue', () => {
    const cards = [
      { id: 'due', dueAt: new Date(now).toISOString(), suspended: false },
      { id: 'future', dueAt: new Date(now + 1).toISOString(), suspended: false },
      { id: 'suspended', dueAt: new Date(now - 1).toISOString(), suspended: true },
      { id: 'invalid', dueAt: 'invalid', suspended: false },
    ] as StudyCard[];
    expect(dueCards(cards, now).map(card => card.id)).toEqual(['due']);
  });
});
