import type { DocumentEntity, RunEntity, StepStatEntity } from '../../history/entities';
import { reviewLog } from '../../testing/result-answer';
import fs, { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { LoopEventEntity } from '../../history/entities';
import { actionsFor } from '../../contract/run-state';
import { storedState } from '../../history/run-state';
import { phases, returns } from './flow';
import { reason, resumeState, sentence } from './flow-waiting';

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
    expect(noteOf(loops)).toEqual(['lint']);
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
    ({ status, currentStep: step, stateReason: JSON.stringify({ code, message: 'm', ...extra }) }) as RunEntity;
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

  it('tells to raise MAX_RUN_USD after the spend limit', () => {
    expect(say(run('blocked', 'implement', 'SPEND_LIMIT'))).toBe(
      'The run spent as much as MAX_RUN_USD allows. Raise MAX_RUN_USD, then Resume.',
    );
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
});

describe('sentence of a run that waits for its subtasks', () => {
  const waiting = (code: string): RunEntity =>
    ({
      status: 'waiting',
      currentStep: 'implement',
      stateReason: JSON.stringify({ code, message: 'm' }),
    }) as RunEntity;
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
