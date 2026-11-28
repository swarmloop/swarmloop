import { describe, expect, it } from 'vitest';
import { backlogView, milestone } from '../../../test/backlog-fixtures';
import { plannedMilestones } from './planned-order';

function numbers(milestones: ReturnType<typeof milestone>[]): number[] {
  return plannedMilestones(backlogView({ milestones })).map((item) => item.number);
}

describe('plannedMilestones', () => {
  it('follows the queue from the active milestone, then the proposed ones by number', () => {
    expect(
      numbers([
        milestone({ number: 9, status: 'proposed' }),
        milestone({ number: 7, status: 'queued', queuedAfter: 5 }),
        milestone({ number: 8, status: 'proposed' }),
        milestone({ number: 5, status: 'queued', queuedAfter: 3 }),
        milestone({ number: 3, status: 'active' }),
      ]),
    ).toEqual([5, 7, 8, 9]);
  });

  it('appends a queued milestone the chain does not reach by number', () => {
    expect(
      numbers([
        milestone({ number: 3, status: 'active' }),
        milestone({ number: 6, status: 'queued', queuedAfter: 3 }),
        milestone({ number: 5, status: 'queued', queuedAfter: 2 }),
        milestone({ number: 4, status: 'queued', queuedAfter: 1 }),
        milestone({ number: 7, status: 'proposed' }),
      ]),
    ).toEqual([6, 4, 5, 7]);
  });

  it('leaves out accepted and active milestones', () => {
    expect(
      numbers([
        milestone({ number: 1, status: 'accepted' }),
        milestone({ number: 2, status: 'active' }),
        milestone({ number: 3, status: 'proposed' }),
      ]),
    ).toEqual([3]);
  });
});
