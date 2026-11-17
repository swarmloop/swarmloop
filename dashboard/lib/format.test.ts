import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { cores, dayLabel, memory, relative, tokens } from './format.ts';

describe('tokens', () => {
  it('shows an integer under 1,000 and the nearest thousand as k', () => {
    assert.equal(tokens(0), '0');
    assert.equal(tokens(999), '999');
    assert.equal(tokens(1000), '1k');
    assert.equal(tokens(1499), '1k');
    assert.equal(tokens(1500), '2k');
    assert.equal(tokens(777_326), '777k');
    assert.equal(tokens(999_499), '999k');
  });

  it('shows one decimal million and drops a trailing .0', () => {
    assert.equal(tokens(999_500), '1M');
    assert.equal(tokens(1_000_000), '1M');
    assert.equal(tokens(1_200_000), '1.2M');
    assert.equal(tokens(1_050_000), '1.1M');
    assert.equal(tokens(2_000_000), '2M');
  });
});

describe('relative and dayLabel', () => {
  const now = new Date(2026, 10, 12, 15, 0, 0);
  const at = (month: number, day: number, hour: number, minute = 0): string =>
    new Date(2026, month, day, hour, minute).toISOString();

  it('reads now, minutes and hours on the same day', () => {
    assert.equal(relative(new Date(2026, 10, 12, 14, 59, 30).toISOString(), now), 'now');
    assert.equal(relative(at(10, 12, 14, 57), now), '3m');
    assert.equal(relative(at(10, 12, 13, 0), now), '2h');
  });

  it('reads yesterday and an older day by calendar day', () => {
    assert.equal(relative(at(10, 11, 23, 0), now), 'yesterday');
    assert.equal(relative(at(10, 9, 9), now), 'Nov 9');
    const early = new Date(2026, 10, 12, 0, 5);
    assert.equal(relative(at(10, 11, 23, 50), early), 'yesterday');
  });

  it('returns an invalid time as it is', () => {
    assert.equal(relative('soon', now), 'soon');
    assert.equal(dayLabel('soon', now), 'soon');
  });

  it('labels a day', () => {
    assert.equal(dayLabel(at(10, 12, 1), now), 'Today');
    assert.equal(dayLabel(at(10, 11, 23, 59), now), 'Yesterday');
    assert.equal(dayLabel(at(10, 10, 12), now), 'Nov 10');
  });
});

describe('cores', () => {
  it('is percent of one core divided by 100 with one decimal', () => {
    assert.equal(cores(262), '2.6');
    assert.equal(cores(680), '6.8');
    assert.equal(cores(0), '0.0');
  });
});

describe('memory', () => {
  const mb = 1024 * 1024;

  it('reads KB below one megabyte', () => {
    assert.equal(memory(512 * 1024), '512 KB');
  });

  it('reads MB below 1024 MB with at most one decimal', () => {
    assert.equal(memory(900.3 * mb), '900.3 MB');
    assert.equal(memory(1.5 * mb), '1.5 MB');
    assert.equal(memory(200 * mb), '200 MB');
  });

  it('reads GB from 1024 MB up with at most one decimal', () => {
    assert.equal(memory(1024 * mb), '1 GB');
    assert.equal(memory(4107.3 * mb), '4 GB');
    assert.equal(memory(1536 * mb), '1.5 GB');
    assert.equal(memory(1023.96 * mb), '1 GB');
    assert.equal(memory(1023.9 * mb), '1023.9 MB');
  });
});
