import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import { mkdtemp } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { SwarmloopConfigModule } from '../config/config.module';
import { writeEnvOverrides } from '../testing/env.spec-helpers';
import { RunRepository } from '../history/run.repository';
import { DocumentRepository } from '../history/document.repository';
import { AGENT_RUNNER } from '../agent/agent-runner';
import { SandboxService } from '../sandbox/sandbox.service';
import { CodeReviewStep } from '../steps/code-review/code-review.step';
import { PipelineStep } from '../steps/pipeline/pipeline.step';
import { withPlan } from '../steps/plan/plan-record';
import { CodeHostRegistry } from '../integrations/code-host/code-host.registry';
import { FetchFailed } from '../core/swarmloop-error';
import { renderMergeRequest } from '../steps/merge-request/merge-request-record';
import { PipelineModule } from './pipeline.module';
import { PipelineService } from './pipeline.service';

describe('pipeline service', () => {
  it('continues Resume requested by the shared automatic rebase action without starting a second runner', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-pipeline-rebase-resume-'));
    const app = await boot(root);
    try {
      const runs = app.get(RunRepository);
      const run = await runs.begin('PROJ-79', 'pipeline');
      run.status = 'waiting';
      await runs.saveRun(run);
      const execute = jest
        .spyOn(app.get(PipelineStep), 'execute')
        .mockImplementationOnce(async () => ({
          exitCode: 0,
          message: 'rebase completed',
          resume: true,
        }))
        .mockImplementationOnce(async () => {
          const fresh = (await runs.findRun('PROJ-79'))!;
          fresh.currentStep = 'done';
          fresh.status = 'done';
          await runs.saveRun(fresh);
          return { exitCode: 0, message: 'CI passed' };
        });
      const result = await app.get(PipelineService).runThrough('PROJ-79');
      expect(result.message).toBe('CI passed');
      expect(execute).toHaveBeenCalledTimes(2);
    } finally {
      await app.close();
    }
  });

  it('rejects a path on a step that does not take one', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-pipeline-path-'));
    const app = await boot(root);
    try {
      const result = await app.get(PipelineService).step('plan', 'PROJ-60', { path: root });
      expect(result).toEqual({ exitCode: 1, message: 'path is only valid for code-review' });
    } finally {
      await app.close();
    }
  });

  it('rejects a prompt on a step that does not take one', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-pipeline-prompt-'));
    const app = await boot(root);
    try {
      const result = await app.get(PipelineService).step('plan', 'PROJ-61', { prompt: 'Use the other parser' });
      expect(result).toEqual({ exitCode: 1, message: 'prompt is only valid for requirements' });
    } finally {
      await app.close();
    }
  });

  it('revises the stored requirements when instructions go to prepare', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-pipeline-revise-'));
    const app = await boot(root);
    try {
      const pipeline = app.get(PipelineService);
      const runs = app.get(RunRepository);
      const documents = app.get(DocumentRepository);
      const seeded = await runs.begin('PROJ-62', 'prepare');
      seeded.status = 'waiting';
      seeded.currentStep = 'prepare';
      await runs.saveRun(seeded);
      await documents.putDocument(
        seeded,
        'requirements',
        withPlan('{"prompt":"ship the field"}\n', { name: '', overview: '', items: ['add the field'], decision: null }),
      );
      await pipeline.replay('PROJ-62', 'prepare', 'Narrow the scope');
      const body = await documents.latestBody('PROJ-62', 'requirements');
      expect((JSON.parse(body ?? '{}') as { plan: { decision: string } }).plan.decision).toBe('revise');
      await settle(pipeline, 'PROJ-62');
    } finally {
      await app.close();
    }
  });

  it('turns the merge requests of a done run back into drafts before a Replay starts its work', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-pipeline-replay-draft-'));
    const app = await boot(root);
    try {
      const pipeline = app.get(PipelineService);
      const runs = app.get(RunRepository);
      const documents = app.get(DocumentRepository);
      const seeded = await runs.begin('PROJ-65', 'prepare');
      seeded.status = 'done';
      seeded.currentStep = 'done';
      await runs.saveRun(seeded);
      await documents.putDocument(
        seeded,
        'requirements',
        withPlan('{"prompt":"ship the field"}\n', { name: '', overview: '', items: ['add the field'], decision: null }),
      );
      const url = 'https://gitlab.example/group/demo/-/merge_requests/3';
      await documents.putDocument(
        seeded,
        'merge_request',
        renderMergeRequest([{ project: 'group/demo', iid: 3, url, draft: false, summary: 'Ships it.' }]),
      );
      const setDraft = jest.fn().mockResolvedValue({ httpCalls: [] });
      jest.spyOn(app.get(CodeHostRegistry), 'byName').mockReturnValue({ setDraft } as never);
      await pipeline.replay('PROJ-65', 'prepare', 'Narrow the scope');
      expect(setDraft).toHaveBeenCalledWith('group/demo', 3, true);
      const body = (await documents.latestBody('PROJ-65', 'merge_request')) ?? '';
      expect(body).toContain('draft: true');
      expect(body).toContain('Ships it.');
      await settle(pipeline, 'PROJ-65');
    } finally {
      await app.close();
    }
  });

  it('does not start a Replay when its merge request cannot be turned back into a draft', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-pipeline-replay-draft-fail-'));
    const app = await boot(root);
    try {
      const runs = app.get(RunRepository);
      const documents = app.get(DocumentRepository);
      const seeded = await runs.begin('PROJ-66', 'prepare');
      seeded.status = 'done';
      seeded.currentStep = 'done';
      await runs.saveRun(seeded);
      await documents.putDocument(seeded, 'requirements', '{"prompt":"ship the field"}\n');
      const url = 'https://gitlab.example/group/demo/-/merge_requests/3';
      await documents.putDocument(
        seeded,
        'merge_request',
        renderMergeRequest([{ project: 'group/demo', iid: 3, url, draft: false, summary: '' }]),
      );
      const setDraft = jest.fn().mockRejectedValue(new FetchFailed('gitlab merge request failed', []));
      jest.spyOn(app.get(CodeHostRegistry), 'byName').mockReturnValue({ setDraft } as never);
      const result = await app.get(PipelineService).replay('PROJ-66', 'prepare', 'Narrow the scope');
      expect(result).toEqual({ exitCode: 1, message: 'gitlab merge request failed' });
      expect((await runs.findRun('PROJ-66'))?.status).toBe('done');
    } finally {
      await app.close();
    }
  });

  it('charges an abandoned code-review run through its step', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-pipeline-abandon-'));
    const app = await boot(root);
    try {
      const runs = app.get(RunRepository);
      const seeded = await runs.begin('PROJ-63', 'code-review');
      seeded.status = 'running';
      seeded.currentStep = 'code-review';
      await runs.saveRun(seeded);
      const charge = jest.spyOn(app.get(CodeReviewStep), 'charge').mockResolvedValue(null);
      await app.get(PipelineService).onApplicationBootstrap();
      expect(charge).toHaveBeenCalledWith('PROJ-63', expect.anything(), expect.anything(), expect.anything());
      expect((await runs.findRun('PROJ-63'))?.status).toBe('failed');
    } finally {
      await app.close();
    }
  }, 30_000);

  it('logs a run that fails outside its step', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-pipeline-drive-'));
    const app = await boot(root);
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    try {
      jest.spyOn(app.get(CodeReviewStep), 'execute').mockRejectedValue(new Error('boom'));
      const pipeline = app.get(PipelineService);
      const started = await pipeline.startDetached('PROJ-64', { path: root }, 'code-review');
      expect(started).toEqual({ exitCode: 0, message: 'PROJ-64 started' });
      await settle(pipeline, 'PROJ-64');
      expect(error).toHaveBeenCalledWith(expect.stringMatching(/^E-[0-9a-z]{8} PROJ-64 failed: \nError: boom/));
    } finally {
      error.mockRestore();
      await app.close();
    }
  });

  it('stores a redacted crash with its error id and logs the same id', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-pipeline-crash-'));
    const app = await boot(root);
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    try {
      const runs = app.get(RunRepository);
      jest.spyOn(app.get(CodeReviewStep), 'execute').mockImplementation(async () => {
        const run = await runs.begin('PROJ-66', 'code-review');
        run.status = 'running';
        run.currentStep = 'code-review';
        run.ownerPid = process.pid;
        await runs.saveRun(run);
        throw new Error('push to https://user:pass@host/x failed with ghp_abc123\nsecond line');
      });
      const pipeline = app.get(PipelineService);
      await pipeline.startDetached('PROJ-66', { path: root }, 'code-review');
      await settle(pipeline, 'PROJ-66');
      const run = await runs.findRun('PROJ-66');
      const documents = await app.get(DocumentRepository).listDocuments(run?.id ?? 0);
      const bodies = documents.filter((document) => document.kind === 'error').map((document) => document.body);
      expect(bodies).toHaveLength(1);
      const match = /^code-review failed: (.*) \((E-[0-9a-z]{8})\)\n$/.exec(bodies[0]);
      expect(match?.[1]).toBe('push to https://***@host/x failed with ***');
      const logged = String(error.mock.calls[0][0]);
      expect(logged.startsWith(`${match?.[2]} `)).toBe(true);
      expect(logged).not.toContain('ghp_abc123');
      expect(logged).not.toContain('user:pass');
    } finally {
      error.mockRestore();
      await app.close();
    }
  });

  it('settles when a detached run releases its key', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-pipeline-idle-'));
    const app = await boot(root);
    let finish!: () => void;
    let executing!: () => void;
    const executionStarted = new Promise<void>((resolve) => {
      executing = resolve;
    });
    try {
      jest.spyOn(app.get(CodeReviewStep), 'execute').mockImplementation(
        () =>
          new Promise((resolve) => {
            executing();
            finish = () => resolve({ exitCode: 0, message: 'done' });
          }),
      );
      const pipeline = app.get(PipelineService);
      await pipeline.startDetached('PROJ-65', { path: root }, 'code-review');
      await executionStarted;
      const idle = pipeline.whenIdle('PROJ-65');
      let settled = false;
      void idle.then(() => {
        settled = true;
      });
      await Promise.resolve();
      expect(settled).toBe(false);
      finish();
      await idle;
      expect(settled).toBe(true);
    } finally {
      await app.close();
    }
  });
});

/** A started step runs in the background. Wait for it to release the key before the app closes. */
async function settle(pipeline: PipelineService, key: string): Promise<void> {
  await pipeline.whenIdle(key);
}

async function boot(root: string): Promise<TestingModule> {
  await writeEnvOverrides(root, {
    REQUIREMENTS_VIA: 'direct',
    GITLAB_BASE_URL: '',
    GITHUB_BASE_URL: '',
    MAX_AGENT_CALLS: '20',
    MAX_RETURNS: '3',
    MAX_RUN_USD: '25',
    AGENTS_PLAN: 'cursor:opus-5.5-extra-high',
    AGENTS_IMPLEMENT: 'cursor:grok-4.7',
    AGENTS_REVIEW: 'cursor:opus-5.5-extra-high',
    SWARMLOOP_ROOT: root,
  });
  return Test.createTestingModule({
    imports: [SwarmloopConfigModule.forRoot(join(root, '.env')), PipelineModule],
  })
    .overrideProvider(AGENT_RUNNER)
    .useValue({ run: jest.fn() })
    .overrideProvider(SandboxService)
    .useValue({
      assertReady: jest.fn().mockResolvedValue(undefined),
      attemptRunning: jest.fn().mockResolvedValue(false),
    })
    .compile();
}
