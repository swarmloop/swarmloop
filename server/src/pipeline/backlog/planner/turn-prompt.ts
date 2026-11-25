import { Injectable } from '@nestjs/common';
import type { SandboxMount } from '../../../core/sandbox-mount';
import { settled } from '../../../contract/subtask';
import { skillPrompt } from '../../../steps/shared/skill-prompt';
import { BacklogTurnState, type TaskState, type TurnState } from './turn-state';

type Section = { heading: string; body: string };

const NONE = 'none';

function indent(text: string): string {
  return text
    .split('\n')
    .map((line) => `    ${line}`)
    .join('\n');
}

function list(values: string[]): string {
  return values.length > 0 ? values.join(', ') : NONE;
}

/** One task: its status and run, what it waits for, and its subtasks. A task that has not started also shows its brief, since only that kind may change. A settled task is its head line alone. */
function taskText(task: TaskState): string {
  const head = `- ${task.slug} [${task.status}]${task.runKey === null ? '' : ` run ${task.runKey}`}: ${task.title}`;
  if (settled(task)) return head;
  const lines = [
    head,
    `    repositories: ${list(task.repositories)}; covers: ${list(task.covers)}; depends: ${list(task.depends)}`,
    `    files: ${list(task.files)}`,
  ];
  if (task.fixesMain !== null) lines.push(`    fixes the main of ${task.fixesMain}`);
  if (task.wait) lines.push(`    waits: ${task.wait}`);
  for (const subtask of task.subtasks) {
    lines.push(
      `    subtask ${subtask.id} [${subtask.status}]: ${subtask.title}; depends: ${list(subtask.depends)}; files: ${list(subtask.files)}`,
    );
  }
  if (task.runKey === null) lines.push('    brief:', indent(indent(task.description)));
  return lines.join('\n');
}

function tasksText(tasks: TaskState[]): string {
  return tasks.length > 0 ? tasks.map(taskText).join('\n') : NONE;
}

function milestoneText(milestone: NonNullable<TurnState['active']>): string {
  const requirements = milestone.requirements.map((item) => `- ${item.ref} [${item.status}]: ${item.text}`);
  return [
    `M${milestone.number} ${milestone.title} (${milestone.status}): ${milestone.goal}`,
    'Requirements:',
    requirements.length > 0 ? requirements.join('\n') : NONE,
    'Tasks:',
    tasksText(milestone.tasks),
  ].join('\n');
}

function eventText(event: TurnState['events'][number]): string {
  const facts = Object.entries(event.facts).map(
    ([name, value]) => `    ${name}: ${value.replaceAll('\n', '\n      ')}`,
  );
  return [`- ${event.kind.replaceAll('-', ' ')} at ${event.at}`, ...facts].join('\n');
}

/** What the planner reads at a turn, as plain sections. Run keys, slugs and refs are the only names it shows. */
function sectionsOf(state: TurnState): Section[] {
  const { backlog } = state;
  const planned = state.planned.map(milestoneText);
  const messages = state.messages.map((message) => `${message.author} (${message.at}): ${message.text}`);
  return [
    {
      heading: 'Backlog',
      body: [
        `name: ${backlog.name}`,
        `repositories: ${list(backlog.repositories)}`,
        `merge mode: ${backlog.mergeMode === 'green' ? 'a task merges when its checks are green' : 'a task waits for the owner to say it may merge'}`,
        backlog.paused ? 'the backlog is paused' : 'the backlog is running',
      ].join('\n'),
    },
    { heading: 'Active milestone', body: state.active ? milestoneText(state.active) : NONE },
    { heading: 'Planned milestones', body: planned.length > 0 ? planned.join('\n\n') : NONE },
    { heading: 'Backlog items', body: tasksText(state.items) },
    {
      heading: 'Decisions',
      body:
        state.decisions.length > 0 ? state.decisions.map((item) => `- ${item.text} (${item.who})`).join('\n') : NONE,
    },
    {
      heading: 'Messages, oldest first',
      body: [
        ...(messages.length > 0 ? messages : [NONE]),
        '',
        `${state.olderMessages} older messages are left out. The latest messages of the chat, and how many are older, are at GET /backlogs/${backlog.name}/messages.`,
      ].join('\n'),
    },
    { heading: 'Events of this turn', body: state.events.length > 0 ? state.events.map(eventText).join('\n') : NONE },
  ];
}

/** Builds the prompt of a planner turn from the state the database gives, never from a run's chat. */
@Injectable()
export class BacklogTurnPrompt {
  constructor(private readonly state: BacklogTurnState) {}

  async build(backlogName: string, turnKey: string, mounts: SandboxMount[], names: string[]): Promise<string> {
    const state = await this.state.read(backlogName, turnKey);
    return skillPrompt(
      'backlog-plan',
      `Plan the backlog ${backlogName}: answer the messages and the events of this turn.`,
      names,
      sectionsOf(state),
      mounts,
    );
  }
}
