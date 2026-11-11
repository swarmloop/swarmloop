import type { DocumentEntity, RunEntity, StepStatEntity } from '../../history/entities';
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { phases, reason } from './flow';

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

describe('reviewer chip in a later round', () => {
  const finished = `${JSON.stringify({ type: 'result', result: 'notes\ndecision: ok\n' })}\nprocess exited 0\n`;

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
    expect(chips['code-review-requirements']).toBe('idle');
  });

  it('keeps a card idle when the run is not in code-review', () => {
    expect(reviewChips({ currentStep: 'implement' })['code-review-quality']).toBe('idle');
  });
});
