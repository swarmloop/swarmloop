import { BadRequestException, ConflictException } from '@nestjs/common';
import {
  checkBacklogName,
  checkMergeMode,
  checkRepositories,
  checkTransition,
  nextMilestoneNumber,
  nextRequirementRefs,
  queueBacklog,
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
    for (const [from, to] of [
      ['proposed', 'accepted'],
      ['queued', 'accepted'],
      ['queued', 'proposed'],
      ['active', 'queued'],
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

  it('activates the chosen milestone and queues the other proposed ones in order, each after the one before', () => {
    const milestones = [
      { id: 10, number: 1, status: 'accepted' as const },
      { id: 11, number: 2, status: 'proposed' as const },
      { id: 13, number: 4, status: 'proposed' as const },
      { id: 12, number: 3, status: 'proposed' as const },
    ];
    expect(queueBacklog(milestones[1], milestones)).toEqual([
      { id: 11, status: 'active', queuedAfterId: null },
      { id: 12, status: 'queued', queuedAfterId: 11 },
      { id: 13, status: 'queued', queuedAfterId: 12 },
    ]);
  });

  it('refuses to run a milestone that is already running or accepted', () => {
    const accepted = { id: 1, number: 1, status: 'accepted' as const };
    expect(() => queueBacklog(accepted, [accepted])).toThrow(ConflictException);
  });
});
