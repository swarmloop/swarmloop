import { BadRequestException, ConflictException } from '@nestjs/common';
import type { MergeMode, MilestoneStatus, RequirementStatus } from '../../contract/backlog';
import { milestoneWorkDone } from '../../contract/milestone-work';
import { settled, type Subtask } from '../../contract/subtask';

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MERGE_MODES: MergeMode[] = ['green', 'ok'];

const TRANSITIONS: Record<MilestoneStatus, MilestoneStatus[]> = {
  proposed: ['queued', 'active'],
  queued: ['active'],
  active: ['accepted', 'queued'],
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

/** A 409 that says what is left, unless the milestone's work is done (see `milestoneWorkDone`). */
export function checkWorkDone(
  number: number,
  tasks: Pick<Subtask, 'status'>[],
  requirements: { status: RequirementStatus }[],
): void {
  if (milestoneWorkDone(tasks, requirements)) return;
  const unsettled = tasks.filter((task) => !settled(task)).length;
  const open = requirements.filter((requirement) => requirement.status !== 'closed').length;
  const left = [
    unsettled > 0 ? `${unsettled} ${unsettled === 1 ? 'task is' : 'tasks are'} not merged or skipped` : '',
    open > 0 ? `${open} ${open === 1 ? 'requirement is' : 'requirements are'} open` : '',
  ].filter((part) => part !== '');
  throw new ConflictException(
    `M${number} is not done: ${left.length > 0 ? left.join(', ') : 'it has no tasks and no requirements'}`,
  );
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
  queuedAfterId?: number | null;
}

interface MilestoneMove {
  id: number;
  status: MilestoneStatus;
  queuedAfterId: number | null;
}

/** The last milestone of the chain that starts at `start` and follows each queued milestone to the one queued behind it. */
function endOfChain(start: QueuedMilestone, milestones: QueuedMilestone[]): number {
  let end = start.id;
  for (let step = 0; step < milestones.length; step += 1) {
    const next = milestones.find((other) => other.status === 'queued' && other.queuedAfterId === end);
    if (next === undefined) break;
    end = next.id;
  }
  return end;
}

/**
 * The one queue rule. With no active milestone the first chosen one, by number, becomes active and the other chosen ones queue in a chain behind it.
 * With an active milestone every chosen one queues, in number order, behind the last milestone of the chain that starts at the active one.
 * Every move goes through `checkTransition`, so a chosen milestone that cannot make the move is refused.
 */
export function queueMilestones(chosen: QueuedMilestone[], milestones: QueuedMilestone[]): MilestoneMove[] {
  const ordered = [...chosen].sort((left, right) => left.number - right.number);
  const taken = new Set(ordered.map((milestone) => milestone.id));
  const active = milestones
    .filter((milestone) => milestone.status === 'active' && !taken.has(milestone.id))
    .sort((left, right) => left.number - right.number)[0];
  const moves: MilestoneMove[] = [];
  let before: number;
  if (active === undefined) {
    const [first, ...rest] = ordered;
    if (first === undefined) return moves;
    moves.push({ id: first.id, status: checkTransition(first.status, 'active'), queuedAfterId: null });
    before = first.id;
    ordered.splice(0, ordered.length, ...rest);
  } else {
    before = endOfChain(active, milestones);
  }
  for (const milestone of ordered) {
    moves.push({ id: milestone.id, status: checkTransition(milestone.status, 'queued'), queuedAfterId: before });
    before = milestone.id;
  }
  return moves;
}

/** With more than one active milestone the lowest-numbered stays active and the later ones queue behind the end of the queue, in number order. */
export function repairActiveMilestones(milestones: QueuedMilestone[]): MilestoneMove[] {
  const active = milestones.filter((milestone) => milestone.status === 'active').sort((a, b) => a.number - b.number);
  return queueMilestones(active.slice(1), milestones);
}
