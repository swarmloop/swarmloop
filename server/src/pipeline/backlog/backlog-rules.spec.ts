import { BadRequestException, ConflictException } from '@nestjs/common';
import type { MilestoneStatus } from '../../contract/backlog';
import {
  checkBacklogName,
  checkMergeMode,
  checkRepositories,
  checkTransition,
  nextMilestoneNumber,
  nextRequirementRefs,
  queueMilestones,
  repairActiveMilestones,
} from './backlog-rules';

describe('backlog rules', () => {
  it('accepts a plain name and refuses an empty, spaced or path-like one', () => {
    expect(checkBacklogName('swarmloop')).toBe('swarmloop');
    for (const name of ['', 'a b', '../x', '-x', 3, undefined]) {
      expect(() => checkBacklogName(name)).toThrow(BadRequestException);
    }
  });

  it('keeps repositories that are checkout projects and refuses the rest', () => {
    expect(checkRepositories(['web', 'web', 'server'], ['web', 'server'])).toEqual(['web', 'server']);
    expect(() => checkRepositories(['other'], ['web'])).toThrow('other is not a checkout project');
    expect(() => checkRepositories([], ['web'])).toThrow(BadRequestException);
    expect(() => checkRepositories('web', ['web'])).toThrow(BadRequestException);
  });

  it('knows the two merge modes', () => {
    expect(checkMergeMode('green')).toBe('green');
    expect(checkMergeMode('ok')).toBe('ok');
    expect(() => checkMergeMode('yolo')).toThrow(BadRequestException);
  });

  it('allows only the milestone transitions of the flow', () => {
    expect(checkTransition('proposed', 'queued')).toBe('queued');
    expect(checkTransition('proposed', 'active')).toBe('active');
    expect(checkTransition('queued', 'active')).toBe('active');
    expect(checkTransition('active', 'accepted')).toBe('accepted');
    expect(checkTransition('active', 'queued')).toBe('queued');
    for (const [from, to] of [
      ['proposed', 'accepted'],
      ['queued', 'accepted'],
      ['queued', 'proposed'],
      ['active', 'proposed'],
      ['accepted', 'active'],
    ] as const) {
      expect(() => checkTransition(from, to)).toThrow(ConflictException);
    }
  });

  it('numbers the next milestone and the next requirements without reuse', () => {
    expect(nextMilestoneNumber([])).toBe(1);
    expect(nextMilestoneNumber([1, 3])).toBe(4);
    expect(nextRequirementRefs(2, [], 2)).toEqual(['M2.R1', 'M2.R2']);
    expect(nextRequirementRefs(2, ['M2.R1', 'M2.R4', 'M1.R9', 'M20.R7'], 2)).toEqual(['M2.R5', 'M2.R6']);
  });

  const milestone = (id: number, status: MilestoneStatus, queuedAfterId: number | null = null) => ({
    id,
    number: id,
    status,
    queuedAfterId,
  });

  it('with no active milestone makes the first chosen active and chains the others behind it by number', () => {
    const milestones = [
      milestone(1, 'accepted'),
      milestone(2, 'proposed'),
      milestone(4, 'proposed'),
      milestone(3, 'proposed'),
    ];
    expect(queueMilestones(milestones.slice(1), milestones)).toEqual([
      { id: 2, status: 'active', queuedAfterId: null },
      { id: 3, status: 'queued', queuedAfterId: 2 },
      { id: 4, status: 'queued', queuedAfterId: 3 },
    ]);
  });

  it('with an active milestone queues the chosen ones behind the last of its chain', () => {
    const milestones = [
      milestone(1, 'active'),
      milestone(2, 'queued', 1),
      milestone(3, 'queued', 2),
      milestone(5, 'proposed'),
      milestone(4, 'proposed'),
    ];
    expect(queueMilestones([milestones[3], milestones[4]], milestones)).toEqual([
      { id: 4, status: 'queued', queuedAfterId: 3 },
      { id: 5, status: 'queued', queuedAfterId: 4 },
    ]);
  });

  it('refuses an already queued or accepted chosen milestone', () => {
    const milestones = [milestone(1, 'active'), milestone(2, 'queued', 1), milestone(3, 'accepted')];
    expect(() => queueMilestones([milestones[1]], milestones)).toThrow(ConflictException);
    expect(() => queueMilestones([milestones[2]], [milestone(3, 'accepted')])).toThrow(ConflictException);
  });

  it('repairs two active milestones by queuing the later ones behind the chain in number order', () => {
    const milestones = [
      milestone(1, 'active'),
      milestone(2, 'queued', 1),
      milestone(4, 'active'),
      milestone(3, 'active'),
    ];
    expect(repairActiveMilestones(milestones)).toEqual([
      { id: 3, status: 'queued', queuedAfterId: 2 },
      { id: 4, status: 'queued', queuedAfterId: 3 },
    ]);
    expect(repairActiveMilestones([milestone(1, 'active'), milestone(2, 'proposed')])).toEqual([]);
  });
});
