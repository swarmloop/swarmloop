import 'reflect-metadata';

import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { StepStopped } from '../../agent/step-stopped';
import type { AgentRunInput, AgentRunResult } from '../../agent/agent-runner';
import { RunRepository } from '../../history/run.repository';
import { PipelineService } from '../../pipeline/pipeline.service';
import { SandboxService } from '../../sandbox/sandbox.service';
import { gitWorktree } from '../../testing/git-worktree.spec-helpers';
import { putStamped } from '../shared/gate.spec-helpers';
import { OpenReviewRounds, type OpenReviewRound } from '../shared/open-review-rounds';
import { answerFor, boot, result, seed, writeEnv } from './code-review.step.spec-helpers';

describe('open round of the code-review visit', () => {
  let root: string;
  let app: Awaited<ReturnType<typeof boot>>;
  let current: (input: AgentRunInput) => Promise<AgentRunResult>;
  /** The open round of the run as each launch saw it, with the step that launched. */
  let seen: { step: string; round: OpenReviewRound | undefined }[];
  const rounds = (): OpenReviewRounds => app.get(OpenReviewRounds);

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'swarmloop-open-round-'));
    await writeEnv(root);
    app = await boot(
      root,
      jest.fn((input: AgentRunInput) => {
        seen.push({ step: input.step, round: rounds().of(input.runKey) });
        return current(input);
      }),
    );
  });

  afterAll(async () => {
    await app.close();
    await rm(root, { recursive: true, force: true });
  });

  beforeEach(() => {
    seen = [];
    current = async (input) => result(answerFor(input.step), input.step);
  });

  async function start(key: string): Promise<void> {
    gitWorktree(join(root, 'worktrees', key, 'billing-api'));
    await seed(app, key);
  }

  it('holds only the reviewer of a Run again, with no report due while another reviewer is open', async () => {
    await start('OPEN-1');
    const run = await app.get(RunRepository).findRun('OPEN-1');
    for (const name of ['requirements', 'security', 'performance']) {
      await putStamped(app, run!, `review_${name}`, 'notes\ndecision: ok\n', ['billing-api']);
    }
    await putStamped(app, run!, 'review_regressions', 'notes\ndecision: return\n', ['billing-api']);
    await app.get(PipelineService).step('code-review', 'OPEN-1', { reviewer: 'quality' });
    expect(seen.map((item) => item.step)).toEqual(['code-review-quality']);
    expect(seen[0]?.round).toEqual({ reviewers: ['quality'], reportDue: false, reportStarted: false });
    expect(rounds().of('OPEN-1')).toBeUndefined();
  });

  it('holds all five reviewers and a due report, and marks the report started when its agent launches', async () => {
    await start('OPEN-2');
    await app.get(PipelineService).step('code-review', 'OPEN-2');
    const reviewers = seen.filter((item) => item.step !== 'code-review-report');
    expect(reviewers).toHaveLength(5);
    for (const item of reviewers) {
      expect(item.round).toMatchObject({ reportDue: true, reportStarted: false });
      expect(item.round?.reviewers).toHaveLength(5);
    }
    expect(seen.find((item) => item.step === 'code-review-report')?.round).toMatchObject({ reportStarted: true });
    expect(rounds().of('OPEN-2')).toBeUndefined();
  });

  describe('clears the round whatever the end', () => {
    async function ended(key: string, options?: { reviewer: string }): Promise<void> {
      await start(key);
      await app.get(PipelineService).step('code-review', key, options);
      expect(seen.length).toBeGreaterThan(0);
      expect(seen[0]?.round).toBeDefined();
      expect(rounds().of(key)).toBeUndefined();
    }

    it('on a failure', async () => {
      current = async (input) => ({ ...result('crashed', input.step), exitCode: 1 });
      await ended('OPEN-3');
      expect((await app.get(RunRepository).findRun('OPEN-3'))?.status).toBe('failed');
    });

    it('on a provider limit', async () => {
      current = async (input) => ({
        ...result("You've hit your 5-hour limit", input.step),
        limit: { window: '5-hour', resetsAt: '2099-01-01T00:00:00.000Z' },
      });
      await ended('OPEN-4');
    });

    it('on a stop', async () => {
      await start('OPEN-5');
      let setDuring: OpenReviewRound | undefined;
      jest.spyOn(app.get(SandboxService), 'assertReady').mockImplementationOnce(async () => {
        setDuring = rounds().of('OPEN-5');
        throw new StepStopped();
      });
      await app.get(PipelineService).step('code-review', 'OPEN-5', { reviewer: 'quality' });
      expect(setDuring?.reviewers).toEqual(['quality']);
      expect((await app.get(RunRepository).findRun('OPEN-5'))?.status).toBe('blocked');
      expect(rounds().of('OPEN-5')).toBeUndefined();
    });

    it('on a crash after the round was set', async () => {
      await start('OPEN-6');
      let setDuring: OpenReviewRound | undefined;
      jest.spyOn(app.get(SandboxService), 'assertReady').mockImplementationOnce(async () => {
        setDuring = rounds().of('OPEN-6');
        throw new Error('docker is gone');
      });
      await app.get(PipelineService).step('code-review', 'OPEN-6', { reviewer: 'quality' });
      expect(setDuring?.reviewers).toEqual(['quality']);
      expect(rounds().of('OPEN-6')).toBeUndefined();
    });
  });
});
