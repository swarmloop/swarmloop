import { settled } from '../../../contract/subtask';
import type { TaskState, TurnState } from './turn-state';

export const NONE = 'none';

/** Where the brief of a task that has not started is read in the sandbox. */
export function briefPath(slug: string): string {
  return `/work/brief/tasks/${slug}.md`;
}

/** Whether the task has a brief file: only a task that has not started may still change its brief. */
export function hasBriefFile(task: TaskState): boolean {
  return task.runKey === null && !settled(task);
}

/** Every task of the state: the active milestone's, the planned milestones' and those that belong to none. */
export function allTasks(state: TurnState): TaskState[] {
  const milestones = [...(state.active ? [state.active] : []), ...state.planned];
  return [...milestones.flatMap((milestone) => milestone.tasks), ...state.items];
}

function list(values: string[]): string {
  return values.length > 0 ? values.join(', ') : NONE;
}

/** One task: its status and run, what it waits for, and its subtasks. A task that has not started also names the file of its brief. A settled task is its head line alone. */
export function taskText(task: TaskState): string {
  const head = `- ${task.slug} [${task.status}] revision ${task.revision}${task.runKey === null ? '' : ` run ${task.runKey}`}: ${task.title}`;
  if (settled(task)) return head;
  const lines = [
    head,
    `    repositories: ${list(task.repositories)}; covers: ${list(task.covers)}; depends: ${list(task.depends)}`,
    `    files: ${list(task.files)}`,
  ];
  if (task.fixesMain !== null) lines.push(`    fixes the main of ${task.fixesMain}`);
  if (task.wait) lines.push(`    waits: ${task.wait}`);
  if (task.reason) lines.push(`    reason: ${task.reason}`);
  for (const subtask of task.subtasks) {
    lines.push(
      `    subtask ${subtask.id} [${subtask.status}]: ${subtask.title}; depends: ${list(subtask.depends)}; files: ${list(subtask.files)}`,
    );
  }
  if (hasBriefFile(task)) {
    lines.push(`    brief: ${task.description.length} characters in ${briefPath(task.slug)}`);
  }
  return lines.join('\n');
}

export function tasksText(tasks: TaskState[]): string {
  return tasks.length > 0 ? tasks.map(taskText).join('\n') : NONE;
}

type MilestoneOf = NonNullable<TurnState['active']>;

export function backlogText(backlog: TurnState['backlog']): string {
  return [
    `name: ${backlog.name}`,
    `repositories: ${list(backlog.repositories)}`,
    `merge mode: ${backlog.mergeMode === 'green' ? 'a task merges when its checks are green' : 'a task waits for the owner to say it may merge'}`,
    backlog.paused ? 'the backlog is paused' : 'the backlog is running',
  ].join('\n');
}

export function milestoneHead(milestone: MilestoneOf): string {
  return `M${milestone.number} ${milestone.title} (${milestone.status}): ${milestone.goal}`;
}

export function requirementText(item: MilestoneOf['requirements'][number]): string {
  return `- ${item.ref} [${item.status}]: ${item.text}`;
}

export function milestoneText(milestone: MilestoneOf): string {
  const requirements = milestone.requirements.map(requirementText);
  return [
    milestoneHead(milestone),
    'Requirements:',
    requirements.length > 0 ? requirements.join('\n') : NONE,
    'Tasks:',
    tasksText(milestone.tasks),
  ].join('\n');
}

export function messageText(message: { author: string; at: string; text: string }): string {
  return `${message.author} (${message.at}): ${message.text}`;
}

export function eventText(event: TurnState['events'][number]): string {
  const facts = Object.entries(event.facts).map(
    ([name, value]) => `    ${name}: ${value.replaceAll('\n', '\n      ')}`,
  );
  return [`- ${event.kind.replaceAll('-', ' ')} at ${event.at}`, ...facts].join('\n');
}
