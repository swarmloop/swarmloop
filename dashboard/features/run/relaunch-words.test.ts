import { describe, expect, it } from 'vitest';
import type { RelaunchView } from '@contract/relaunch';
import { relaunchLine } from './relaunch-words';

const relaunch = (phases: string[]): RelaunchView => ({
  at: '2026-11-22T02:13:57.000Z',
  reason: 'Rebased onto the epic after input merged',
  phases,
  steps: [],
  open: true,
});

describe('relaunchLine', () => {
  it('joins two phases with and, and writes ci as CI', () => {
    expect(relaunchLine(relaunch(['checks', 'ci']), ' · ')).toBe(
      'Rebased onto the epic after input merged · checks and CI run again',
    );
  });

  it('names one phase and takes the separator it is given', () => {
    expect(relaunchLine(relaunch(['ci']), ': ')).toBe('Rebased onto the epic after input merged: CI run again');
  });

  it('joins three phases with commas and a last and', () => {
    expect(relaunchLine(relaunch(['implementation', 'checks', 'ci']), ': ')).toBe(
      'Rebased onto the epic after input merged: implementation, checks and CI run again',
    );
  });
});
