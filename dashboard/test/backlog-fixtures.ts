import type { BacklogView } from '@contract/backlog';
import type { BacklogChatView, BacklogMessageView } from '@contract/backlog-chat';

type Milestone = BacklogView['milestones'][number];
type Requirement = BacklogView['requirements'][number];
type Task = BacklogView['tasks'][number];

export function milestone(overrides: Partial<Milestone> = {}): Milestone {
  return { number: 3, title: 'Checkout', goal: 'A shopper can pay', status: 'active', ...overrides };
}

export function requirement(overrides: Partial<Requirement> = {}): Requirement {
  return { ref: 'M3.R1', milestone: 3, text: 'A shopper pays by card', status: 'open', closedBy: [], ...overrides };
}

export function task(overrides: Partial<Task> = {}): Task {
  return {
    slug: 'pay-by-card',
    title: 'Pay by card',
    description: 'Add the card form.',
    covers: ['M3.R1'],
    depends: [],
    milestone: 3,
    status: 'running',
    note: '',
    runKey: null,
    run: null,
    waitsForOk: false,
    repositories: ['shop'],
    merged: {},
    revision: 0,
    ...overrides,
  };
}

/** A backlog whose active milestone M3 has 4 of its 7 requirements closed. */
export function backlogView(overrides: Partial<BacklogView> = {}): BacklogView {
  const requirements = Array.from({ length: 7 }, (_, index) =>
    requirement({
      ref: `M3.R${index + 1}`,
      text: `Requirement ${index + 1}`,
      status: index < 4 ? 'closed' : index === 4 ? 'ready' : 'open',
      closedBy: index < 4 ? [`task-${index + 1}`] : [],
    }),
  );
  return {
    name: 'swarmloop',
    owner: 'ada',
    repositories: ['shop'],
    mergeMode: 'green',
    paused: false,
    milestones: [milestone()],
    requirements,
    tasks: [task()],
    decisions: [],
    events: [],
    ...overrides,
  };
}

export function chatMessage(overrides: Partial<BacklogMessageView> = {}): BacklogMessageView {
  return {
    id: 1,
    author: 'person',
    kind: 'message',
    text: 'Plan the checkout',
    proposes: null,
    createdAt: '2026-01-01T10:00:00.000Z',
    ...overrides,
  };
}

export function backlogChatView(overrides: Partial<BacklogChatView> = {}): BacklogChatView {
  return { messages: [chatMessage()], older: 0, turns: [], ...overrides };
}

/** A backlog whose milestone M3 asks to run: it waits for a person to open it. */
export function proposedMilestoneBacklog(name = 'shop'): BacklogView {
  return backlogView({ name, milestones: [milestone({ status: 'proposed' })], tasks: [] });
}

/** A backlog whose active milestone M3 has 6 tasks, 4 of them merged. */
export function activeMilestoneBacklog(name = 'shop'): BacklogView {
  const tasks = Array.from({ length: 6 }, (_, index) =>
    task({ slug: `task-${index + 1}`, title: `Task ${index + 1}`, status: index < 4 ? 'merged' : 'running' }),
  );
  return backlogView({ name, milestones: [milestone({ status: 'active', title: 'Checkout' })], tasks });
}
