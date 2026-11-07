import { describe, expect, it } from 'vitest';
import type { StepEvent, StepEventBody } from '@contract/step-events';
import { commandEvents, stepEvent } from '../../../test/step-events';
import {
  actorOf,
  filterEvents,
  firstProblemId,
  groupByActor,
  groupByAttempt,
  issueLinks,
  sideOf,
} from './transcript-model';

const agent = { runtime: 'claude', model: 'opus', mode: 'agent', timeLimitMs: 1000, session: 'fresh' as const };
const launch = { runtime: 'claude', model: 'opus', chatId: null, resumed: false };

const bodies: [StepEventBody, 'left' | 'right'][] = [
  [{ kind: 'input.received', name: 'plan', inputKind: 'plan', documentId: 1, summary: 'a plan' }, 'right'],
  [{ kind: 'issue.opened', issueId: 'i-1', source: 'review', title: 'a bug' }, 'left'],
  [{ kind: 'handoff.received', handoffId: 4, issueIds: ['i-1'] }, 'right'],
  [{ kind: 'handoff.sent', handoffId: 1, targetStep: 'implement', artifactKinds: [], issueIds: [] }, 'left'],
  [{ kind: 'handoff.sent', handoffId: 2, targetStep: 'commit', artifactKinds: [], issueIds: [] }, 'left'],
  [{ kind: 'handoff.sent', handoffId: 3, targetStep: null, artifactKinds: [], issueIds: [] }, 'left'],
  [{ kind: 'attempt.started', stepKind: 'agent', agent }, 'left'],
  [{ kind: 'attempt.finished', route: 'next', summary: 'ok' }, 'left'],
  [{ kind: 'attempt.interrupted', route: 'wait', summary: 'stopped' }, 'left'],
  [{ kind: 'http.call', method: 'GET', url: 'https://x.test', statusCode: 200, durationMs: 5 }, 'left'],
  [{ kind: 'agent.launched', ...launch }, 'left'],
  [{ kind: 'agent.finished', ...launch, killReason: null, tokensIn: 1, tokensOut: 2, usd: 0 }, 'left'],
  [{ kind: 'artifact.produced', artifactKind: 'plan', documentId: 2, summary: 'plan: 9 items' }, 'left'],
];

describe('sideOf', () => {
  it.each(bodies)('puts %j on its side', (body, side) => {
    expect(sideOf(stepEvent(1, body))).toBe(side);
  });

  it('puts a command on the left whoever ran it', () => {
    for (const event of commandEvents(1, 's', { executable: 'git' })) {
      expect(sideOf(event)).toBe('left');
    }
  });

  it('does not use the step that wrote the event', () => {
    const body: StepEventBody = {
      kind: 'handoff.sent',
      handoffId: 1,
      targetStep: 'implement',
      artifactKinds: [],
      issueIds: [],
    };
    expect(sideOf(stepEvent(1, body, { step: 'plan' }))).toBe('left');
    expect(sideOf(stepEvent(1, body, { step: 'implement' }))).toBe('left');
  });
});

describe('groupByAttempt', () => {
  const second = { attemptId: 'attempt-2' };
  const events: StepEvent[] = [
    stepEvent(6, { kind: 'attempt.started', stepKind: 'agent', agent: { ...agent, model: 'sonnet' } }, second),
    stepEvent(1, { kind: 'attempt.started', stepKind: 'agent', agent }),
    stepEvent(2, { kind: 'input.received', name: 'plan', inputKind: 'plan', documentId: 1, summary: 'a plan' }),
    ...commandEvents(3, 's1', { executable: 'git' }),
    stepEvent(5, { kind: 'attempt.finished', route: 'return', summary: 'tests failed' }),
    stepEvent(7, { kind: 'artifact.produced', artifactKind: 'diff', documentId: 4, summary: 'a diff' }, second),
  ];

  it('lists the attempts in order, each with its events in seq order', () => {
    const groups = groupByAttempt(events);

    expect(groups.map((group) => group.number)).toEqual([1, 2]);
    expect(groups.map((group) => group.items.map((item) => item.event.seq))).toEqual([[2, 3, 5], [7]]);
  });

  it('gives the reason and the runtime or model only when they changed', () => {
    const [first, next] = groupByAttempt(events);

    expect(first).toMatchObject({ why: 'first run', modelName: 'opus', outcome: 'Moved to return' });
    expect(next).toMatchObject({ why: 'run again', modelName: 'sonnet', outcome: null });
  });

  it('pairs a command with its end and reads the problem from it', () => {
    const [group] = groupByAttempt([
      ...commandEvents(1, 'a', { executable: 'ls' }),
      ...commandEvents(3, 'b', { executable: 'make', exitCode: 2 }),
    ]);

    expect(group?.items.map((item) => item.end?.exitCode)).toEqual([0, 2]);
    expect(group?.items.map((item) => item.problem?.cause ?? null)).toEqual([null, 'exit code 2']);
  });

  it('finds a problem in a kill, an http error and an interrupted attempt', () => {
    const [group] = groupByAttempt([
      stepEvent(1, {
        kind: 'agent.finished',
        ...launch,
        killReason: 'time limit',
        tokensIn: 0,
        tokensOut: 0,
        usd: 0,
      }),
      stepEvent(2, { kind: 'http.call', method: 'GET', url: 'u', statusCode: 503, durationMs: 1 }),
      stepEvent(3, { kind: 'http.call', method: 'GET', url: 'u', statusCode: null, durationMs: 1 }),
      stepEvent(4, { kind: 'http.call', method: 'GET', url: 'u', statusCode: 200, durationMs: 1 }),
      stepEvent(5, { kind: 'attempt.interrupted', route: 'wait', summary: 'stopped' }),
    ]);

    expect(group?.items.map((item) => item.problem?.cause ?? null)).toEqual([
      'killed: time limit',
      'status 503',
      'no response',
      null,
      'stopped',
    ]);
  });

  it('names the first problem of the step', () => {
    expect(firstProblemId(events)).toBeNull();
    expect(firstProblemId([...events, ...commandEvents(8, 'x', { executable: 'make', exitCode: 1 }, second)])).toBe(
      'event-8',
    );
  });
});

describe('filterEvents', () => {
  const [group] = groupByAttempt([
    stepEvent(1, { kind: 'input.received', name: 'plan', inputKind: 'plan', documentId: 1, summary: '' }),
    ...commandEvents(2, 'a', { executable: 'make', exitCode: 1 }),
    stepEvent(4, { kind: 'handoff.received', handoffId: 3, issueIds: ['i'] }),
    stepEvent(5, { kind: 'artifact.produced', artifactKind: 'diff', documentId: 4, summary: 'a diff' }),
  ]);
  const items = group?.items ?? [];
  const seqs = (filter: Parameters<typeof filterEvents>[1]) =>
    filterEvents(items, filter).map((item) => item.event.seq);

  it('keeps the order of the list in every view', () => {
    expect(seqs('all')).toEqual([1, 2, 4, 5]);
    expect(seqs('inputs')).toEqual([1, 4]);
    expect(seqs('actions')).toEqual([2, 5]);
    expect(seqs('problems')).toEqual([2]);
  });
});

describe('issues across windows', () => {
  const opened = stepEvent(1, { kind: 'issue.opened', issueId: 'i-1', source: 'pipeline', title: 'lint failed' });
  const resolved = stepEvent(5, { kind: 'issue.resolved', issueId: 'i-1', evidence: 'pipeline a-2' });
  const received = (seq: number) => stepEvent(seq, { kind: 'handoff.received', handoffId: 3, issueIds: ['i-1'] });
  const kinds = (events: StepEvent[]) =>
    groupByAttempt(events).flatMap((group) => group.items.map((item) => item.event.kind));

  it('shows an issue as one problem card in its window, also when the event is repeated', () => {
    const again = { ...opened, eventId: 'again', seq: 2 };
    const [group] = groupByAttempt([opened, again]);
    expect(group?.items).toHaveLength(1);
    expect(group?.items[0]).toMatchObject({
      side: 'left',
      problem: { cause: 'lint failed', action: 'issue i-1' },
    });
  });

  it('shows an issue as one input card in the target window, also when the delivery is repeated', () => {
    expect(kinds([received(1), received(2)])).toEqual(['handoff.received']);
  });

  it('shows the same issue again in a later attempt', () => {
    const second = { attemptId: 'attempt-2' };
    const again = stepEvent(
      6,
      { kind: 'issue.opened', issueId: 'i-1', source: 'pipeline', title: 'lint failed' },
      second,
    );
    const groups = groupByAttempt([opened, again]);
    expect(groups.map((group) => group.items.map((item) => item.event.kind))).toEqual([
      ['issue.opened'],
      ['issue.opened'],
    ]);
    const receivedAgain = stepEvent(7, { kind: 'handoff.received', handoffId: 4, issueIds: ['i-1'] }, second);
    expect(groupByAttempt([received(1), receivedAgain]).map((group) => group.items.length)).toEqual([1, 1]);
  });

  it('adds a card for the resolution and keeps the problem card', () => {
    expect(kinds([opened, resolved])).toEqual(['issue.opened', 'issue.resolved']);
  });

  it('links an issue to its first problem event and marks it resolved', () => {
    const link = { eventId: 'event-1', title: 'lint failed', source: 'pipeline', line: '', returnedTo: null };
    expect(issueLinks([opened, resolved]).get('i-1')).toEqual({ ...link, resolved: true });
    expect(issueLinks([opened]).get('i-1')).toEqual({ ...link, resolved: false });
  });
});

describe('actorOf', () => {
  const items = (events: StepEvent[]) => groupByAttempt(events).flatMap((group) => group.items);
  const kindOf = (body: StepEventBody) => actorOf(items([stepEvent(1, body)])[0]).kind;

  it('names the actor of each kind of card', () => {
    expect(kindOf({ kind: 'agent.launched', ...launch })).toBe('agent');
    expect(kindOf({ kind: 'artifact.produced', artifactKind: 'plan', documentId: 2, summary: 's' })).toBe('server');
    expect(kindOf({ kind: 'http.call', method: 'GET', url: 'https://x.test', statusCode: 200, durationMs: 5 })).toBe(
      'server',
    );
    expect(kindOf({ kind: 'activity.started', spanId: 'a', title: 'Check out' })).toBe('server');
    expect(kindOf({ kind: 'handoff.received', handoffId: 4, issueIds: [] })).toBe('pipeline');
    expect(kindOf({ kind: 'input.received', name: 'plan', inputKind: 'plan', documentId: 1, summary: 's' })).toBe(
      'pipeline',
    );
    expect(
      kindOf({
        kind: 'input.received',
        name: 'instructions',
        inputKind: 'instructions:plan',
        documentId: 1,
        summary: 's',
      }),
    ).toBe('person');
  });

  it('takes a command from the one who ran it, and git from git', () => {
    expect(actorOf(items(commandEvents(1, 's', { executable: 'make' }))[0]).kind).toBe('agent');
    expect(actorOf(items(commandEvents(1, 's', { executable: 'git', exitCode: 1 }))[0])).toEqual({
      kind: 'git',
      name: 'Git',
    });
  });
});

describe('groupByActor', () => {
  const input = (seq: number, name: string) =>
    stepEvent(seq, { kind: 'input.received', name, inputKind: name, documentId: seq, summary: name });
  const artifact = (seq: number) =>
    stepEvent(seq, { kind: 'artifact.produced', artifactKind: 'plan', documentId: seq, summary: 'a plan' });
  const grouped = (events: StepEvent[]) =>
    groupByActor(groupByAttempt(events).flatMap((group) => group.items)).map((item) => item.grouped);

  it('groups a run of cards from one actor on one side', () => {
    expect(grouped([input(1, 'plan'), input(2, 'diff'), input(3, 'ref')])).toEqual([false, true, true]);
  });

  it('starts a new group when the actor changes', () => {
    expect(grouped([artifact(1), ...commandEvents(2, 's', { executable: 'make' }), artifact(4)])).toEqual([
      false,
      false,
      false,
    ]);
  });

  it('starts a new group when the side changes', () => {
    const events = [
      stepEvent(1, { kind: 'handoff.sent', handoffId: 1, targetStep: null, artifactKinds: [], issueIds: [] }),
      stepEvent(2, { kind: 'handoff.received', handoffId: 2, issueIds: [] }),
    ];
    expect(grouped(events)).toEqual([false, false]);
  });

  it('breaks at an attempt boundary when it is applied to each attempt', () => {
    const events = [artifact(1), artifact(2), artifact(3)].map((event, index) =>
      index === 2 ? { ...event, attemptId: 'attempt-2' } : event,
    );
    const marks = groupByAttempt(events).map((group) => groupByActor(group.items).map((item) => item.grouped));
    expect(marks).toEqual([[false, true], [false]]);
  });
});
