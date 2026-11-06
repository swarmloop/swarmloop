import { describe, expect, it } from 'vitest';
import type { StepEvent, StepEventBody } from '@contract/step-events';
import { commandEvents, stepEvent } from '../../../test/step-events';
import { filterEvents, firstProblemId, groupByAttempt, sideOf } from './transcript-model';

const agent = { runtime: 'claude', model: 'opus', mode: 'agent', timeLimitMs: 1000, session: 'fresh' as const };
const launch = { runtime: 'claude', model: 'opus', chatId: null, resumed: false };

const bodies: [StepEventBody, 'left' | 'right'][] = [
  [{ kind: 'input.received', name: 'plan', inputKind: 'plan', documentId: 1, summary: 'a plan' }, 'right'],
  [{ kind: 'issue.opened', issueId: 'i-1', source: 'review', title: 'a bug' }, 'right'],
  [{ kind: 'handoff.sent', handoffId: 1, targetStep: 'implement', artifactKinds: [], issueIds: [] }, 'right'],
  [{ kind: 'handoff.sent', handoffId: 2, targetStep: 'commit', artifactKinds: [], issueIds: [] }, 'left'],
  [{ kind: 'handoff.sent', handoffId: 3, targetStep: null, artifactKinds: [], issueIds: [] }, 'left'],
  [{ kind: 'attempt.started', stepKind: 'agent', agent }, 'left'],
  [{ kind: 'attempt.finished', route: 'next', summary: 'ok' }, 'left'],
  [{ kind: 'attempt.interrupted', route: 'wait', summary: 'stopped' }, 'left'],
  [{ kind: 'http.call', method: 'GET', url: 'https://x.test', statusCode: 200, durationMs: 5 }, 'left'],
  [{ kind: 'agent.launched', ...launch }, 'left'],
  [{ kind: 'agent.finished', ...launch, killReason: null, tokensIn: 1, tokensOut: 2, usd: 0 }, 'left'],
  [{ kind: 'artifact.produced', artifactKind: 'plan', documentId: 2 }, 'left'],
];

describe('sideOf', () => {
  it.each(bodies)('puts %j on its side', (body, side) => {
    expect(sideOf(stepEvent(1, body), 'implement')).toBe(side);
  });

  it('puts a command on the left whoever ran it', () => {
    for (const event of commandEvents(1, 's', { executable: 'git' })) {
      expect(sideOf(event, 'implement')).toBe('left');
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
    expect(sideOf(stepEvent(1, body, { step: 'plan' }), 'implement')).toBe('right');
    expect(sideOf(stepEvent(1, body, { step: 'implement' }), 'commit')).toBe('left');
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
    stepEvent(7, { kind: 'artifact.produced', artifactKind: 'diff', documentId: 4 }, second),
  ];

  it('lists the attempts in order, each with its events in seq order', () => {
    const groups = groupByAttempt(events, 'implement');

    expect(groups.map((group) => group.number)).toEqual([1, 2]);
    expect(groups.map((group) => group.items.map((item) => item.event.seq))).toEqual([[2, 3, 5], [7]]);
  });

  it('gives the reason and the runtime or model only when they changed', () => {
    const [first, next] = groupByAttempt(events, 'implement');

    expect(first).toMatchObject({ reason: null, runtime: 'claude', model: 'opus' });
    expect(next).toMatchObject({ reason: 'return: tests failed', runtime: null, model: 'sonnet' });
  });

  it('pairs a command with its end and reads the problem from it', () => {
    const [group] = groupByAttempt(
      [...commandEvents(1, 'a', { executable: 'ls' }), ...commandEvents(3, 'b', { executable: 'make', exitCode: 2 })],
      'implement',
    );

    expect(group?.items.map((item) => item.end?.exitCode)).toEqual([0, 2]);
    expect(group?.items.map((item) => item.problem?.cause ?? null)).toEqual([null, 'exit code 2']);
  });

  it('finds a problem in a kill, an http error and an interrupted attempt', () => {
    const [group] = groupByAttempt(
      [
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
      ],
      'implement',
    );

    expect(group?.items.map((item) => item.problem?.cause ?? null)).toEqual([
      'killed: time limit',
      'status 503',
      'no response',
      null,
      'stopped',
    ]);
  });

  it('names the first problem of the step', () => {
    expect(firstProblemId(events, 'implement')).toBeNull();
    expect(
      firstProblemId([...events, ...commandEvents(8, 'x', { executable: 'make', exitCode: 1 }, second)], 'implement'),
    ).toBe('event-8');
  });
});

describe('filterEvents', () => {
  const [group] = groupByAttempt(
    [
      stepEvent(1, { kind: 'input.received', name: 'plan', inputKind: 'plan', documentId: 1, summary: '' }),
      ...commandEvents(2, 'a', { executable: 'make', exitCode: 1 }),
      stepEvent(4, { kind: 'issue.opened', issueId: 'i', source: 's', title: 't' }),
      stepEvent(5, { kind: 'artifact.produced', artifactKind: 'diff', documentId: 4 }),
    ],
    'implement',
  );
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
