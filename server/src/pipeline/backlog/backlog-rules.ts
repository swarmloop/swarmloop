import { BadRequestException, ConflictException } from '@nestjs/common';
import type { MergeMode, MilestoneStatus } from '../../contract/backlog';

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MERGE_MODES: MergeMode[] = ['green', 'ok'];

const TRANSITIONS: Record<MilestoneStatus, MilestoneStatus[]> = {
  proposed: ['queued', 'active'],
  queued: ['active'],
  active: ['accepted'],
  accepted: [],
};

export function checkBacklogName(name: unknown): string {
  if (typeof name !== 'string' || !NAME.test(name)) {
    throw new BadRequestException('a backlog name is letters, digits, dots, dashes and underscores, up to 64');
  }
  return name;
}

/** Every repository is a checkout project; the list is not empty and has no repeat. */
export function checkRepositories(repositories: unknown, checkouts: string[]): string[] {
  if (!Array.isArray(repositories) || repositories.length === 0) {
    throw new BadRequestException('a backlog needs at least one repository');
  }
  const names = repositories as unknown[];
  for (const name of names) {
    if (typeof name !== 'string' || !checkouts.includes(name)) {
      throw new BadRequestException(`${String(name)} is not a checkout project`);
    }
  }
  return [...new Set(names as string[])];
}

export function checkMergeMode(mode: unknown): MergeMode {
  if (!MERGE_MODES.includes(mode as MergeMode)) {
    throw new BadRequestException(`the merge mode is one of: ${MERGE_MODES.join(', ')}`);
  }
  return mode as MergeMode;
}

export function checkText(text: unknown, what: string): string {
  if (typeof text !== 'string' || text.trim().length === 0) {
    throw new BadRequestException(`${what} is empty`);
  }
  return text.trim();
}

/** The status a milestone may move to, or a 409 that names both. */
export function checkTransition(from: MilestoneStatus, to: MilestoneStatus): MilestoneStatus {
  if (!TRANSITIONS[from].includes(to)) {
    throw new ConflictException(`a ${from} milestone cannot become ${to}`);
  }
  return to;
}

export function nextMilestoneNumber(numbers: number[]): number {
  return Math.max(0, ...numbers) + 1;
}

/** The refs of new requirements of a milestone: one past the highest taken, never reused. */
export function nextRequirementRefs(milestone: number, taken: string[], count: number): string[] {
  const prefix = `M${milestone}.R`;
  const highest = taken
    .filter((ref) => ref.startsWith(prefix))
    .map((ref) => Number(ref.slice(prefix.length)))
    .filter((index) => Number.isInteger(index))
    .reduce((top, index) => Math.max(top, index), 0);
  return Array.from({ length: count }, (_, index) => `${prefix}${highest + index + 1}`);
}

interface QueuedMilestone {
  id: number;
  number: number;
  status: MilestoneStatus;
}

interface MilestoneMove {
  id: number;
  status: MilestoneStatus;
  queuedAfterId: number | null;
}

/** Run backlog: the chosen milestone is active; every other proposed one queues after the one before it, in number order. */
export function queueBacklog(chosen: QueuedMilestone, milestones: QueuedMilestone[]): MilestoneMove[] {
  checkTransition(chosen.status, 'active');
  const moves: MilestoneMove[] = [{ id: chosen.id, status: 'active', queuedAfterId: null }];
  let before = chosen.id;
  const others = milestones
    .filter((milestone) => milestone.id !== chosen.id && milestone.status === 'proposed')
    .sort((left, right) => left.number - right.number);
  for (const milestone of others) {
    moves.push({ id: milestone.id, status: checkTransition(milestone.status, 'queued'), queuedAfterId: before });
    before = milestone.id;
  }
  return moves;
}
