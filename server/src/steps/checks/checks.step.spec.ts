import 'reflect-metadata';
import { mkdtemp } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { returns } from '../../api/run-view/flow';
import { EnvironmentService } from '../../environment/environment.service';
import { RequiredCheckFailed, RequiredCheckRepeated } from '../../environment/project-environments';
import { DocumentRepository } from '../../history/document.repository';
import { EventRepository } from '../../history/event.repository';
import { readLoopDetail } from '../../history/loop-detail';
import { VisitRepository } from '../../history/visit.repository';
import type { RunEntity } from '../../history/entities';
import { RunRepository } from '../../history/run.repository';
import { PipelineService } from '../../pipeline/pipeline.service';
import { issueOf } from '../shared/handoff';
import { boot, featureTree, reply, result, seed, writeEnv } from '../implement/implement.step.spec-helpers';

const failure =
  'billing-api: required check failed (exit 1):\n$ npm run lint\nerror: no-unused-vars\n\n' +
  'billing-api: required check failed (exit 2):\n$ npm run typecheck\nCannot find module ../shared/repo-names';

async function booted(key: string) {
  const root = await mkdtemp(join(tmpdir(), 'swarmloop-checks-'));
  await writeEnv(root);
  featureTree(root, key, 'billing-api');
  const agent = jest.fn().mockResolvedValue(result(reply));
  const app = await boot(root, agent);
  await seed(app, key, 'approve');
  const runs = app.get(RunRepository);
  const run = (await runs.findRun(key))!;
  run.currentStep = 'checks';
  await runs.saveRun(run);
  return { app, runs, agent };
}

describe('checks step', () => {
  it('moves on with the checks line when every command passes', async () => {
    const { app, runs } = await booted('PROJ-200');
    try {
      jest.spyOn(app.get(EnvironmentService), 'check').mockResolvedValue({ passed: 8, total: 8 });
      const done = await app.get(PipelineService).step('checks', 'PROJ-200');
      expect(done.exitCode).toBe(0);
      const run = await runs.findRun('PROJ-200');
      expect(run?.currentStep).toBe('code-review');
      expect(run?.status).toBe('waiting');
      expect(run?.attemptsChecks).toBe(0);
      expect(await app.get(VisitRepository).latestChecked(run!.id)).toEqual({});
    } finally {
      await app.close();
    }
  });

  it('passes the commands of the returned issues to the checks', async () => {
    const { app, runs } = await booted('PROJ-205');
    try {
      const failed = { repo: 'billing-api', command: 'npm test --prefix server', tail: 'red' };
      await app
        .get(DocumentRepository)
        .putDocument(
          (await runs.findRun('PROJ-205'))!,
          'issues',
          JSON.stringify([issueOf('checks', 'failed', 'x', [failed])]),
        );
      const check = jest.spyOn(app.get(EnvironmentService), 'check').mockResolvedValue({ passed: 1, total: 1 });
      await app.get(PipelineService).step('checks', 'PROJ-205');
      expect(check).toHaveBeenCalledWith(expect.anything(), [failed]);
    } finally {
      await app.close();
    }
  });

  it('returns to implement with every failed command and counts the return', async () => {
    const { app, runs } = await booted('PROJ-201');
    try {
      jest.spyOn(app.get(EnvironmentService), 'check').mockImplementation(async (input) => {
        await app.get(DocumentRepository).putDocument(input.run, 'return', `## checks\n${failure}\n`);
        throw new RequiredCheckFailed(failure, [
          { repo: 'billing-api', command: 'npm run lint', tail: '$ npm run lint\nerror: no-unused-vars' },
        ]);
      });
      const done = await app.get(PipelineService).step('checks', 'PROJ-201');
      expect(done.exitCode).toBe(0);
      const run = (await runs.findRun('PROJ-201'))!;
      expect(run.currentStep).toBe('implement');
      expect(run.status).toBe('waiting');
      expect(run.attemptsChecks).toBe(1);
      expect(returns(run)).toEqual([{ counter: 'checks', count: 1, from: 'checks', to: 'implement' }]);
      const [loop] = await app.get(EventRepository).listLoops(run.id);
      expect(readLoopDetail(loop.detail)).toEqual({ commands: ['npm run lint'] });
      expect(await app.get(VisitRepository).latestChecked(run.id)).toBeNull();
      const issues = JSON.parse((await app.get(DocumentRepository).latestBody('PROJ-201', 'issues')) ?? '[]');
      expect(issues).toHaveLength(1);
      expect(issues[0].body).toContain('$ npm run lint');
      expect(issues[0].body).toContain('$ npm run typecheck');
      expect(issues[0].failed).toEqual([
        { repo: 'billing-api', command: 'npm run lint', tail: '$ npm run lint\nerror: no-unused-vars' },
      ]);
    } finally {
      await app.close();
    }
  });

  it('returns the same way as a review does: implement continues with the failures in its prompt', async () => {
    const { app, agent } = await booted('PROJ-202');
    try {
      jest.spyOn(app.get(EnvironmentService), 'check').mockImplementation(async (input) => {
        await app.get(DocumentRepository).putDocument(input.run, 'return', `## checks\n${failure}\n`);
        throw new RequiredCheckFailed(failure);
      });
      await app.get(PipelineService).step('checks', 'PROJ-202');
      await app.get(PipelineService).step('implement', 'PROJ-202');
      const prompt = (agent.mock.calls[0]?.[0] as { prompt: string }).prompt;
      expect(prompt).toContain('$ npm run lint');
      expect(prompt).toContain('$ npm run typecheck');
    } finally {
      await app.close();
    }
  });

  it('blocks the run when its own check gate repeats a failure', async () => {
    const { app, runs } = await booted('PROJ-96');
    try {
      const reason = 'billing-api: npm test failed again on unchanged files after a relaunch';
      jest.spyOn(app.get(EnvironmentService), 'check').mockRejectedValue(new RequiredCheckRepeated(reason));
      await app.get(PipelineService).step('checks', 'PROJ-96');
      const run = await runs.findRun('PROJ-96');
      expect(run?.status).toBe('blocked');
      expect(run?.currentStep).toBe('checks');
      expect(run?.attemptsChecks).toBe(0);
    } finally {
      await app.close();
    }
  });

  it('fails the step on an infrastructure error and retries it', async () => {
    const { app, runs } = await booted('PROJ-203');
    try {
      jest.spyOn(app.get(EnvironmentService), 'check').mockRejectedValue(new Error('sandbox unavailable'));
      const done = await app.get(PipelineService).step('checks', 'PROJ-203');
      expect(done.exitCode).toBe(1);
      expect(done.message).toContain('sandbox unavailable');
      const run = (await runs.findRun('PROJ-203')) as RunEntity;
      expect([run.status, run.currentStep]).toEqual(['failed', 'checks']);
    } finally {
      await app.close();
    }
  });

  it('is the only step that runs the checks: implement and implement-improve start no check container', async () => {
    const { app, runs } = await booted('PROJ-204');
    try {
      const check = jest.spyOn(app.get(EnvironmentService), 'check');
      const run = (await runs.findRun('PROJ-204'))!;
      run.currentStep = 'implement';
      await runs.saveRun(run);
      await app.get(PipelineService).step('implement', 'PROJ-204');
      await app.get(PipelineService).step('implement-improve', 'PROJ-204');
      expect(check).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});
