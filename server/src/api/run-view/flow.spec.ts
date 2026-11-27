import type { DocumentEntity, RunEntity, StepStatEntity } from '../../history/entities';
import { reviewLog } from '../../testing/result-answer';
import fs, { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { LoopEventEntity } from '../../history/entities';
import type { CheckCommandView } from '../../contract/api';
import { actionsFor } from '../../contract/run-state';
import { stateOfStatus, storedState } from '../../history/run-state';
import { parkedConflictIn } from '../../pipeline/parked-conflict';
import type { RelaunchView } from '../../contract/relaunch';
import { phases, returns, usageFigures } from './flow';
import { reason, resumeState, sentence } from './flow-waiting';

/** A row as its writer stores it: the state its status and reason give. */
const withState = (row: RunEntity): RunEntity => ({ ...row, ...stateOfStatus(row) });

describe('usage figures', () => {
  it('shows the cost and tokens of the log, and the highest peak of the stored visits and the open ones', () => {
    const stats = [
      { cpuPeak: 40, memPeak: 900, usd: 7, tokensIn: 5, tokensOut: 5 },
      { cpuPeak: 10, memPeak: 100, usd: 7, tokensIn: 5, tokensOut: 5 },
    ] as StepStatEntity[];

    expect(usageFigures(stats, { usd: 1.25, tokens: 300 }, { cpuPeak: 55, memPeak: 200 })).toEqual({
      usd: 1.25,
      tokens: 300,
      cpuPeak: 55,
      memPeak: 900,
    });
  });
});

describe('failure reason', () => {
  it('shows the current pipeline error instead of an older failing test', () => {
    const run = { status: 'failed', currentStep: 'pipeline' } as RunEntity;
    const stats = [{ id: 2, step: 'pipeline', killReason: null }] as StepStatEntity[];
    const documents = [
      { stepStatId: 1, kind: 'pipeline_log', body: 'result: fail\njob: old-test' },
      { stepStatId: 2, kind: 'error', body: 'CI did not start' },
    ] as DocumentEntity[];
    expect(reason(run, documents, stats)).toBe('CI did not start');
  });

  it('keeps the current job log ahead of its generic error', () => {
    const run = { status: 'failed', currentStep: 'pipeline' } as RunEntity;
    const stats = [{ id: 2, step: 'pipeline', killReason: null }] as StepStatEntity[];
    const documents = [
      { stepStatId: 2, kind: 'pipeline_log', body: 'result: fail\nsha: new\njob: test' },
      { stepStatId: 2, kind: 'error', body: 'pipeline failed' },
    ] as DocumentEntity[];
    expect(reason(run, documents, stats)).toContain('sha: new');
  });
});

describe('return lines', () => {
  it('lists returns from checks, code-review and pipeline in board order', () => {
    const run = { attemptsReview: 1, attemptsPipeline: 2, attemptsChecks: 3 } as RunEntity;
    expect(returns(run).map((edge) => edge.from)).toEqual(['checks', 'code-review', 'pipeline']);
  });
});

describe('return reasons', () => {
  const loops = [
    { counter: 'checks', reason: 'required checks failed', detail: '{"commands":["lint"]}' },
    { counter: 'pipeline', reason: 'old\nline', detail: null },
    { counter: 'pipeline', reason: 'job test failed\nmore', detail: null },
  ] as LoopEventEntity[];

  it('names the failed command for checks and the first line of the latest reason otherwise', () => {
    const run = { attemptsPipeline: 2, attemptsChecks: 1 } as RunEntity;
    expect(returns(run, loops).map((edge) => edge.why)).toEqual(['lint', 'job test failed']);
  });

  it('gives no reason without loop events', () => {
    const run = { attemptsChecks: 1 } as RunEntity;
    expect(returns(run)[0]).not.toHaveProperty('why');
  });
});

describe('return words', () => {
  const at = '2026-11-25T10:00:00.000Z';
  const loops = [
    {
      counter: 'review',
      reason: 'review_requirements,review_quality',
      detail: null,
      createdAt: '2026-11-25T09:00:00.000Z',
    },
    { counter: 'review', reason: 'review_requirements,review_quality,review_regressions', detail: null, createdAt: at },
    {
      counter: 'checks',
      reason: 'required checks failed',
      detail: '{"commands":["npm test --prefix dashboard"]}',
      createdAt: at,
    },
  ] as LoopEventEntity[];
  const rows = [{ command: 'npm test --prefix dashboard', name: 'dashboard tests' }] as CheckCommandView[];
  const run = { attemptsReview: 2, attemptsChecks: 1 } as RunEntity;

  it('says when and why each return happened in words, with its counts as they were', () => {
    expect(returns(run, loops, rows)).toMatchObject([
      { from: 'checks', count: 1, at, words: 'Checks sent it back: dashboard tests' },
      { from: 'code-review', count: 2, at, words: 'Code review sent it back: requirements, quality, regressions' },
    ]);
  });

  it('gives neither without a loop event', () => {
    expect(returns(run)[0]).not.toHaveProperty('words');
    expect(returns(run)[0]).not.toHaveProperty('at');
  });
});

describe('visits of an epic that waits for its tasks', () => {
  const root = mkdtempSync(join(tmpdir(), 'swarmloop-visits-'));
  mkdirSync(join(root, 'data'));
  writeFileSync(join(root, 'data', 'K-1-implement-launches.txt'), '1\n');
  const run = { key: 'K-1', status: 'waiting', currentStep: 'checks', activeAttempt: null } as RunEntity;
  const pass = (attempt: number, model: string | null): StepStatEntity =>
    ({ id: attempt, step: 'implement', attempt, model, status: 'done' }) as StepStatEntity;
  const countOf = (stats: StepStatEntity[]): number | undefined =>
    phases(run, stats, [], root)
      .flatMap((phase) => phase.steps)
      .find((step) => step.name === 'implement')?.attempts;

  it('counts only the visits in which an agent ran', () => {
    expect(countOf([pass(1, null), pass(2, null), pass(3, 'claude-opus-5-5')])).toBe(1);
    expect(countOf([pass(1, null), pass(2, null)])).toBe(0);
    expect(countOf([pass(1, 'm'), pass(2, null), pass(3, 'm')])).toBe(2);
  });

  it('counts a provider-limit stop and the launch after it as one visit, and a trailing stop as one', () => {
    const stop = (attempt: number): StepStatEntity => ({
      ...pass(attempt, 'm'),
      status: 'interrupted',
      killReason: 'RUNTIME_LIMIT',
    });
    expect(countOf([stop(1), pass(1, 'm')])).toBe(1);
    expect(countOf([pass(1, 'm'), stop(2)])).toBe(2);
    expect(countOf([stop(1)])).toBe(1);
  });
});

describe('visits of a server step', () => {
  const run = { key: 'K-1', status: 'waiting', currentStep: 'implement' } as RunEntity;
  const visit = (id: number): StepStatEntity =>
    ({ id, step: 'pipeline', attempt: id, model: null, status: 'waiting' }) as StepStatEntity;
  const countOf = (server: Set<string>): number | undefined =>
    phases(run, [1, 2, 3, 4, 5, 6].map(visit), [], '/nonexistent', [], undefined, [], undefined, server)
      .flatMap((phase) => phase.steps)
      .find((step) => step.name === 'pipeline')?.attempts;

  it('counts the stored visits of a step that runs no agent, with no launch record', () => {
    expect(countOf(new Set(['pipeline']))).toBe(6);
  });

  it('keeps an agent step at its agent visits', () => {
    expect(countOf(new Set())).toBe(0);
  });
});

describe('steps of an open relaunch', () => {
  const finished = '2026-11-22T01:50:00.000Z';
  const relaunchAt = '2026-11-22T02:00:00.000Z';
  const stat = (step: string, finishedAt = finished): StepStatEntity =>
    ({ id: 1, step, status: 'done', finishedAt }) as StepStatEntity;
  const steps = ['checks', 'implement', 'code-review', 'commit', 'merge-request', 'pipeline'];
  const stats = steps.map((step) => stat(step));
  const relaunch: RelaunchView = {
    at: relaunchAt,
    reason: 'Rebased onto the epic after input merged',
    phases: ['checks', 'ci'],
    steps: ['checks', 'commit', 'merge-request', 'pipeline'],
    open: true,
  };
  const run = { key: 'r', currentStep: 'checks', status: 'waiting', attemptsReview: 1 } as RunEntity;
  const statuses = (open?: RelaunchView, own = stats): Record<string, string> =>
    Object.fromEntries(
      phases(run, own, [], '/nonexistent', [], undefined, [], open)
        .flatMap((phase) => phase.steps)
        .map((step) => [step.name, step.status]),
    );

  it('shows the steps the relaunch runs again that have run as will run again, the others as not started', () => {
    const withoutMergeRequest = stats.filter((item) => item.step !== 'merge-request');
    expect(statuses(relaunch)).toMatchObject({
      implement: 'done',
      checks: 'waiting',
      commit: 'again',
      'merge-request': 'again',
      pipeline: 'again',
    });
    expect(statuses(relaunch, withoutMergeRequest)).toMatchObject({ commit: 'again', 'merge-request': 'idle' });
    expect(statuses(undefined)).toMatchObject({ commit: 'done', 'merge-request': 'done', pipeline: 'done' });
  });

  it('shows a step that ran on the new head as it ran', () => {
    const own = stats.map((item) => (item.step === 'commit' ? stat('commit', '2026-11-22T02:05:00.000Z') : item));
    expect(statuses(relaunch, own)).toMatchObject({ commit: 'done', 'merge-request': 'again' });
  });

  it('shows the reviewers, the report and the steps after a relaunched code review as waiting to run', () => {
    const review = {
      ...relaunch,
      phases: ['code-review', 'ci'],
      steps: ['code-review', 'commit', 'merge-request', 'pipeline'],
    };
    const inReview = { ...run, currentStep: 'code-review' };
    const chips = (open?: RelaunchView) =>
      Object.fromEntries(
        phases(inReview, stats, [], '/nonexistent', [], undefined, [], open)
          .flatMap((phase) => phase.steps)
          .map((step) => [step.name, step.status]),
      );
    expect(chips(review)).toMatchObject({
      'code-review-requirements': 'idle',
      'code-review-performance': 'idle',
      'code-review': 'idle',
      commit: 'again',
      'merge-request': 'again',
      pipeline: 'again',
      implement: 'done',
    });
  });

  it('says what a step that will run again did last, and only for such a step', () => {
    const loop = {
      counter: 'pipeline',
      reason: 'merge conflict: automatic rebase',
      detail: null,
      createdAt: finished,
    } as LoopEventEntity;
    const waitingPipeline = stats.map((item) => (item.step === 'pipeline' ? { ...item, status: 'waiting' } : item));
    const shown = phases(
      { ...run, attemptsPipeline: 3 },
      waitingPipeline,
      [],
      '/nonexistent',
      [loop],
      undefined,
      [],
      relaunch,
    )
      .flatMap((phase) => phase.steps)
      .map((step) => [step.name, step.lastOutcome]);
    expect(Object.fromEntries(shown)).toMatchObject({
      pipeline: 'CI sent it back: merge conflict: automatic rebase → implement',
      commit: 'done',
      'merge-request': 'done',
    });
    expect(Object.fromEntries(shown).implement).toBeUndefined();
    expect(Object.fromEntries(shown).checks).toBeUndefined();
  });

  it('leaves the returns and their counts as they were', () => {
    const edges = returns({ ...run, attemptsChecks: 2 }).map((edge) => [edge.counter, edge.count]);
    expect(edges).toEqual([
      ['checks', 2],
      ['review', 1],
    ]);
  });
});

describe('returned step note', () => {
  const run = { key: 'r', currentStep: 'implement', status: 'waiting', attemptsChecks: 1 } as RunEntity;
  const stats = [{ id: 5, step: 'checks', status: 'waiting' }] as StepStatEntity[];
  const issues = JSON.stringify([{ id: 'a' }, { id: 'b' }]);
  const documents = [{ stepStatId: 5, kind: 'issues', body: issues }] as DocumentEntity[];
  const noteOf = (loops: LoopEventEntity[], docs = documents): (string | undefined)[] =>
    phases(run, stats, docs, '/nonexistent', loops)
      .flatMap((phase) => phase.steps)
      .filter((step) => step.name === 'checks')
      .map((step) => step.returnNote);

  it('counts the notes of the step visit', () => {
    expect(noteOf([])).toEqual(['2 notes']);
  });

  it('names the failed command for checks', () => {
    const loops = [{ counter: 'checks', reason: 'x', detail: '{"commands":["lint"]}' }] as LoopEventEntity[];
    expect(noteOf(loops)).toEqual(['Checks sent it back: checks']);
  });

  it('names the failed command by its short name in words', () => {
    const loops = [{ counter: 'checks', reason: 'x', detail: '{"commands":["lint --all"]}' }] as LoopEventEntity[];
    const rows = [{ command: 'lint --all', name: 'lint' }] as CheckCommandView[];
    const note = phases(run, stats, documents, '/nonexistent', loops, undefined, rows)
      .flatMap((phase) => phase.steps)
      .find((step) => step.name === 'checks')?.returnNote;
    expect(note).toBe('Checks sent it back: lint');
  });

  it('gives no note without an issues document', () => {
    expect(noteOf([], [])).toEqual([undefined]);
  });
});

describe('reviewer chip in a later round', () => {
  const finished = reviewLog('ok');

  /** Ids sort opposite to age: 'zzz' is round 1, 'aaa' is round 2. */
  function chipOf(roundTwoOutput: string | null): { status: string; attempts: number } {
    const root = mkdtempSync(join(tmpdir(), 'swarmloop-chip-'));
    mkdirSync(join(root, 'data'));
    const first = join(root, 'data', 'K-1-code-review-quality-zzz-output.txt');
    writeFileSync(first, finished);
    utimesSync(first, new Date(1000), new Date(1000));
    if (roundTwoOutput !== null) {
      const second = join(root, 'data', 'K-1-code-review-quality-aaa-output.txt');
      writeFileSync(second, roundTwoOutput);
      utimesSync(second, new Date(2000), new Date(2000));
    }
    const run = {
      key: 'K-1',
      status: 'running',
      currentStep: 'code-review',
      activeAttempt: 'aaa',
      stepStartedAt: new Date(2000).toISOString(),
    } as RunEntity;
    const flow = phases(run, [], [], root);
    const step = flow.flatMap((phase) => phase.steps).find((item) => item.name === 'code-review-quality');
    return { status: step!.status, attempts: step!.attempts };
  }

  it('does not show the decision of round 1 before round 2 has written anything', () => {
    expect(chipOf(null).status).not.toBe('done');
  });

  it('shows only the running attempt', () => {
    expect(chipOf('process started\nthinking\n').status).toBe('running');
  });

  it('lists no folder when the run has attempt rows, and shows the same chip', () => {
    const root = mkdtempSync(join(tmpdir(), 'swarmloop-chip-rows-'));
    mkdirSync(join(root, 'data'));
    writeFileSync(join(root, 'data', 'K-1-code-review-quality-zzz-output.txt'), finished);
    writeFileSync(join(root, 'data', 'K-1-code-review-quality-aaa-output.txt'), 'process started\nthinking\n');
    const run = {
      key: 'K-1',
      status: 'running',
      currentStep: 'code-review',
      activeAttempt: 'aaa',
      stepStartedAt: new Date(2000).toISOString(),
    } as RunEntity;
    const listing = jest.spyOn(fs, 'readdirSync');
    try {
      const flow = phases(run, [{ attemptId: 'zzz', step: 'code-review' }] as StepStatEntity[], [], root);
      const step = flow.flatMap((phase) => phase.steps).find((item) => item.name === 'code-review-quality');
      expect(step!.status).toBe('running');
      expect(listing).not.toHaveBeenCalled();
    } finally {
      listing.mockRestore();
    }
  });
});

describe('reviewer chip of a limited reviewer', () => {
  it('shows a reviewer that a provider limit stopped as waiting, not failed', () => {
    const root = mkdtempSync(join(tmpdir(), 'swarmloop-chip-limit-'));
    mkdirSync(join(root, 'data'));
    const run = { key: 'K-1', status: 'waiting', currentStep: 'code-review', activeAttempt: null } as RunEntity;
    const stats = [
      { id: 1, step: 'code-review-quality', status: 'interrupted', killReason: 'RUNTIME_LIMIT', attempt: 1 },
    ] as StepStatEntity[];
    const step = phases(run, stats, [], root)
      .flatMap((phase) => phase.steps)
      .find((item) => item.name === 'code-review-quality');
    expect(step?.status).toBe('waiting');
  });
});

describe('chips of a code-review that is preparing', () => {
  function reviewChips(run: Partial<RunEntity>, logs: Record<string, string> = {}): Record<string, string> {
    const root = mkdtempSync(join(tmpdir(), 'swarmloop-chip-preparing-'));
    mkdirSync(join(root, 'data'));
    for (const [name, body] of Object.entries(logs)) {
      writeFileSync(join(root, 'data', `K-1-${name}-aaa-output.txt`), body);
    }
    const flow = phases(
      { key: 'K-1', status: 'running', currentStep: 'code-review', activeAttempt: 'aaa', ...run } as RunEntity,
      [],
      [],
      root,
    );
    const steps = flow.find((phase) => phase.phase === 'code-review')?.steps ?? [];
    return Object.fromEntries(steps.map((step) => [step.name, step.status]));
  }

  it('shows every reviewer and the report as preparing, never idle, right after checks end', () => {
    const chips = reviewChips({});

    expect(Object.keys(chips).length).toBeGreaterThan(2);
    expect(Object.values(chips).filter((status) => status === 'idle')).toEqual([]);
    expect(chips['code-review-quality']).toBe('preparing');
    expect(chips['code-review']).toBe('preparing');
  });

  it('shows no card as preparing once a reviewer has started', () => {
    const chips = reviewChips({}, { 'code-review-quality': 'starting\n' });

    expect(Object.values(chips)).not.toContain('preparing');
    expect(chips['code-review-requirements']).toBe('running');
  });

  it('keeps a card idle when the run is not in code-review', () => {
    expect(reviewChips({ currentStep: 'implement' })['code-review-quality']).toBe('idle');
  });
});

describe('chips of a second code-review round', () => {
  const finished = (decision: 'ok' | 'return') => reviewLog(decision);
  const ANGLES = ['requirements', 'quality', 'regressions', 'security', 'performance'];
  const roundOne = new Date(1000);
  const roundTwo = new Date(5000);

  /** Round 1 returned on every angle and the report; round 2 has written the given logs. */
  function chips(logs: Record<string, string>): Record<string, string> {
    const root = mkdtempSync(join(tmpdir(), 'swarmloop-chip-round-'));
    mkdirSync(join(root, 'data'));
    const write = (name: string, attempt: string, body: string, at: Date) => {
      const file = join(root, 'data', `K-1-${name}-${attempt}-output.txt`);
      writeFileSync(file, body);
      utimesSync(file, at, at);
    };
    for (const name of [...ANGLES.map((angle) => `code-review-${angle}`), 'code-review-report']) {
      write(name, 'one', finished('return'), roundOne);
    }
    for (const [name, body] of Object.entries(logs)) {
      write(name, 'two', body, new Date(6000));
    }
    const documents = [
      ...ANGLES.map((angle) => ({ stepStatId: 1, kind: `review_${angle}`, body: 'old\ndecision: return\n' })),
      { stepStatId: 1, kind: 'review_report', body: 'old\ndecision: return\n' },
    ] as DocumentEntity[];
    const stats = [
      { id: 1, step: 'code-review', attempt: 1, status: 'waiting', stepStartedAt: roundOne.toISOString() },
    ] as StepStatEntity[];
    const run = {
      key: 'K-1',
      status: 'running',
      currentStep: 'code-review',
      activeAttempt: 'two',
      stepStartedAt: roundTwo.toISOString(),
    } as RunEntity;
    const steps = phases(run, stats, documents, root).find((phase) => phase.phase === 'code-review')?.steps ?? [];
    return Object.fromEntries(steps.map((step) => [step.name, step.status]));
  }

  const NOT_YET = ['returned', 'failed', 'waiting', 'done', 'idle'];

  it('shows every reviewer and the report as preparing before anything is written in round 2', () => {
    expect(new Set(Object.values(chips({})))).toEqual(new Set(['preparing']));
  });

  it('shows a reviewer that is still starting, and the others, as running, not as round 1 left them', () => {
    const shown = chips({ 'code-review-quality': 'starting\n' });
    expect(Object.values(shown).filter((status) => NOT_YET.includes(status))).toEqual([]);
    expect(shown['code-review-quality']).toBe('running');
    expect(shown['code-review']).toBe('running');
  });

  it('shows only the reviewer that decided in round 2 as decided, and the report as running', () => {
    const shown = chips({ 'code-review-quality': finished('ok'), 'code-review-security': 'thinking\n' });
    expect(shown['code-review-quality']).toBe('done');
    expect(shown['code-review-security']).toBe('running');
    expect(shown['code-review-requirements']).toBe('running');
    expect(shown['code-review']).toBe('running');
  });

  it('shows a reviewer that returned in round 2 as returned and the report as done once all decided', () => {
    const logs = Object.fromEntries(ANGLES.map((angle) => [`code-review-${angle}`, finished('ok')]));
    logs['code-review-quality'] = finished('return');
    const shown = chips({ ...logs, 'code-review-report': finished('ok') });
    expect(shown['code-review-quality']).toBe('returned');
    expect(shown['code-review-requirements']).toBe('done');
    expect(shown['code-review']).toBe('done');
  });
});

describe('sentence of a stop with its own next step', () => {
  const retryAt = '2026-11-12T14:05:00.000Z';
  const run = (status: string, step: string, code: string, extra: object = {}): RunEntity =>
    withState({
      status,
      currentStep: step,
      stateReason: JSON.stringify({ code, message: 'm', ...extra }),
    } as RunEntity);
  const say = (entity: RunEntity): string => sentence(entity, [], [], [], 3);

  it.each([
    ['HOST_UNAVAILABLE', 'A host did not answer.'],
    ['DOCKER_UNAVAILABLE', 'Docker did not answer.'],
  ])('says %s is tried again by itself at the stored time, also on a loop step', (code, start) => {
    expect(say(run('waiting', 'pipeline', code, { retryAt }))).toBe(
      `${start} The step is tried again by itself at ${retryAt}. Resume tries now.`,
    );
  });

  it('says the message of a stalled run as it is', () => {
    const stalled = run('waiting', 'implement', 'STALLED', {
      message: 'Stalled 4 times with no reason; Resume to try again',
    });
    expect(say(stalled)).toBe('Stalled 4 times with no reason; Resume to try again');
    expect(resumeState(stalled, [])).toBe('ready');
  });

  it('says what a loop limit block does on any step', () => {
    expect(say(run('blocked', 'plan', 'LOOP_LIMIT'))).toBe(
      'Automatic retries stopped after 3 attempts. Resume starts another.',
    );
  });

  it('tells that Resume runs past the spend limit and a higher MAX_RUN_USD goes on by itself', () => {
    expect(say(run('blocked', 'implement', 'SPEND_LIMIT'))).toBe(
      'The run spent as much as MAX_RUN_USD allows. Resume runs the step past the limit; a higher MAX_RUN_USD lets the run go on by itself.',
    );
  });

  it('shows the generic blocked sentence for a block an old run stored for the retired call budget', () => {
    const sentence = say(run('blocked', 'implement', 'DID_NOT_FIT'));
    expect(sentence).not.toContain('agent-call budget');
    expect(sentence).toBe('This run is blocked. Another return is not available.');
  });

  it('says who to look at when a pipeline failure stays unfixed', () => {
    expect(say(run('blocked', 'pipeline', 'PIPELINE_UNFIXED'))).toContain(
      'failed twice on the same commit and the agent changed nothing',
    );
  });

  it('says the stored reason of a skipped run, with no older error beside it', () => {
    const skipped = run('blocked', 'commit', 'SKIPPED', { message: 'skipped by its epic: nothing left to do' });
    const documents = [{ stepStatId: 1, kind: 'error', body: 'nothing to commit' }] as DocumentEntity[];
    expect(say(skipped)).toBe('skipped by its epic: nothing left to do');
    expect(actionsFor(storedState(skipped).state)).toEqual([]);
    expect(reason(skipped, documents, [{ id: 1, step: 'commit', killReason: null }] as StepStatEntity[])).toBeNull();
  });

  it('keeps the sentence of a docker block stored before this change', () => {
    expect(say(run('blocked', 'prepare', 'DOCKER_UNAVAILABLE'))).toBe(
      'This run is blocked. Another return is not available.',
    );
  });

  describe('a REBASE_CONFLICT block', () => {
    const blocked = { ...run('blocked', 'implement', 'REBASE_CONFLICT'), generation: 2 };
    const journalOf = (checkpoint: string) =>
      JSON.stringify({ app: { path: '/w', branch: 'b', checkpoint, generation: 2 } });
    const stored = (marker: string | null, checkpoint: string): DocumentEntity[] =>
      [
        ...(marker ? [{ kind: 'rebase_conflict', body: marker }] : []),
        { kind: 'rebase_journal', body: journalOf(checkpoint) },
      ] as DocumentEntity[];
    const said = (documents: DocumentEntity[]) => sentence(blocked, [], documents, [], 3);

    it('offers Resume and says what it does when the rebase is parked for implement', () => {
      const documents = stored('pending-implement\n', 'conflict');
      const parked = parkedConflictIn(documents, blocked);
      expect(parked).toBe(true);
      expect(actionsFor('blocked', 'REBASE_CONFLICT', { parkedConflict: parked })).toEqual(['resume', 'replay']);
      expect(resumeState(blocked, [], { parkedConflict: parked })).toBe('ready');
      expect(said(documents)).toBe(
        'The rebase stopped at a conflict with the base branch. Resume has the implement agent resolve it; checks and code review judge the resolution, then the open tasks move onto the resolved branch.',
      );
    });

    it('keeps Replay only and the old sentence for a recreated worktree', () => {
      const documents = stored(null, 'applying');
      expect(parkedConflictIn(documents, blocked)).toBe(false);
      expect(resumeState(blocked, [], { parkedConflict: false })).toBe('blocked');
      expect(said(documents)).toBe('This run is blocked. Another return is not available.');
    });
  });
});

describe('sentence of a run that waits for its subtasks', () => {
  const waiting = (code: string): RunEntity =>
    withState({
      status: 'waiting',
      currentStep: 'implement',
      stateReason: JSON.stringify({ code, message: 'm' }),
    } as RunEntity);
  const tasks = [...Array(6).keys()].map((index) => ({
    id: `t${index}`,
    title: `Task ${index}`,
    depends: [],
    status: index < 3 ? 'running' : 'waiting',
  }));
  const documents = [{ kind: 'subtasks', body: JSON.stringify(tasks) }] as DocumentEntity[];

  it('names the counts of a split run that waits for its subtasks', () => {
    expect(sentence(waiting('SUBTASKS_RUNNING'), [], documents, [], 3)).toBe(
      'Waiting for subtasks: 0/6 merged · 3 running · 3 waiting',
    );
    expect(sentence(waiting('SUBTASK_WAITING'), [], [], [], 3)).toBe(
      'The next continuation implements the approved plan.',
    );
  });
});

describe('implement-improve of a split parent', () => {
  const run = { key: 'K-1', status: 'waiting', currentStep: 'checks', activeAttempt: null } as RunEntity;
  const chip = (stats: Partial<StepStatEntity>[], name: string) =>
    phases(run, stats as StepStatEntity[], [], tmpdir())
      .flatMap((phase) => phase.steps)
      .find((step) => step.name === name);

  it('is listed as skipped with the reason', () => {
    const step = chip([{ id: 1, step: 'implement-improve', status: 'skipped', attempt: 1 }], 'implement-improve');
    expect(step).toMatchObject({ status: 'skipped', note: 'each task checked its own work' });
  });

  it.each(['running', 'failed', 'blocked', 'waiting'])(
    'shows the live state when a returned parent is at implement-improve and %s',
    (status) => {
      const live = { ...run, status, currentStep: 'implement-improve' };
      const stats = [{ id: 1, step: 'implement-improve', status: 'skipped', attempt: 1 }] as StepStatEntity[];
      const step = phases(live, stats, [], tmpdir())
        .flatMap((phase) => phase.steps)
        .find((item) => item.name === 'implement-improve');
      expect(step?.status).toBe(status);
      expect(step?.note).toBeUndefined();
    },
  );

  it('gives a skipped pipeline chip no note', () => {
    const step = chip([{ id: 1, step: 'pipeline', status: 'skipped', attempt: 1 }], 'pipeline');
    expect(step).toMatchObject({ status: 'skipped' });
    expect(step?.note).toBeUndefined();
  });

  it('has no note when it is not skipped', () => {
    const step = chip([{ id: 1, step: 'implement-improve', status: 'ok', attempt: 1 }], 'implement-improve');
    expect(step?.note).toBeUndefined();
  });
});

describe('a stored spend note on a waiting run', () => {
  const run = { key: 'r', currentStep: 'research', status: 'waiting' } as RunEntity;
  const note = [{ kind: 'spend', body: 'r is over the spend limit. research was not started\n' }] as DocumentEntity[];
  const asked = [{ kind: 'question', answer: '' }] as never[];

  it('holds a run whose step did not start since', () => {
    expect(sentence(run, [], note, [], 3)).toBe('r is over the spend limit. research was not started');
  });

  it('gives way to the normal sentence once the step waited after a resume', () => {
    const stats = [{ id: 1, step: 'research', status: 'waiting' }] as StepStatEntity[];
    expect(sentence(run, asked, note, stats, 3)).toBe('Answer the open questions before the run continues.');
  });
});

describe('sentence of a run whose open questions the backlog planner holds', () => {
  const run = { key: 'r', currentStep: 'research', status: 'waiting' } as RunEntity;
  const item = { kind: 'question', id: 'q', label: 'q', answer: '' } as const;

  it('says the planner has them and the person can still answer', () => {
    expect(sentence(run, [{ ...item, holder: 'planner' }], [], [], 3)).toBe(
      "The backlog's planner has the open questions. You can still answer them here.",
    );
  });

  it('asks for answers once one open question is for the person', () => {
    expect(
      sentence(
        run,
        [
          { ...item, holder: 'planner' },
          { ...item, id: 'p', passedOn: 'Yours.' },
        ],
        [],
        [],
        3,
      ),
    ).toBe('Answer the open questions before the run continues.');
  });
});
