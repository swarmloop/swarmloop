import { existsSync } from 'fs';
import type { FlowView, RunsView, RunRef, StepView } from '../../src/contract/api';
import { FAKE_MODEL_KEY } from '../../src/testing/env.spec-helpers';
import { createTestApp, ScriptedFakeAgentRunner } from '../../src/testing/test-app';
import { featureWorktree } from '../../src/testing/runs.spec-helpers';
import { RunRepository } from '../../src/history/run.repository';
import { VisitRepository } from '../../src/history/visit.repository';

describe('HTTP API golden path', () => {
  it('creates a run and reads its completed state', async () => {
    const runner = new ScriptedFakeAgentRunner();
    const testApp = await createTestApp({ runner, env: FAKE_MODEL_KEY });
    const root = testApp.root;
    try {
      featureWorktree(root, 'TEST-1');
      const createdResponse = await fetch(`${testApp.url}/runs`, {
        method: 'POST',
        headers: { ...testApp.auth, 'content-type': 'application/json' },
        body: JSON.stringify({ key: 'TEST-1', prompt: 'Ship the field', projects: ['demo'] }),
      });
      const created: RunRef = await createdResponse.json();
      expect(createdResponse.status).toBe(202);
      expect(created).toEqual({
        key: 'TEST-1',
        status: 'started',
        commandId: expect.any(String),
        revision: 1,
        state: 'idle',
      });
      await testApp.pipeline.whenIdle(created.key);
      const run = await testApp.app.get(RunRepository).findRun(created.key);
      if (!run) {
        throw new Error('the created run is missing');
      }
      const visits = await testApp.app.get(VisitRepository).listStats(run.id);
      expect(visits.filter((visit) => !visit.step.startsWith('code-review-')).map((visit) => visit.step)).toEqual([
        'requirements',
        'prepare',
        'research',
        'plan',
        'plan-improve',
        'branch',
        'implement',
        'implement-improve',
        'checks',
        'code-review',
        'commit',
        'merge-request',
        'pipeline',
      ]);

      const runs: RunsView = await (await fetch(`${testApp.url}/runs`, { headers: testApp.auth })).json();
      expect(runs.runs[0]).toMatchObject({ key: 'TEST-1', status: 'done', currentStep: 'done' });
      const flow: FlowView = await (await fetch(`${testApp.url}/runs/TEST-1`, { headers: testApp.auth })).json();
      expect(flow).toMatchObject({ key: 'TEST-1', status: 'done', currentStep: 'done', resume: 'done' });
      const implement: StepView = await (
        await fetch(`${testApp.url}/runs/TEST-1/steps/implement`, { headers: testApp.auth })
      ).json();
      expect(implement.step).toBe('implement');
      expect(implement.visits).toHaveLength(1);
      expect(implement.visits[0].status).toBe('done');
    } finally {
      await testApp.close();
    }
    expect(testApp.runner.steps.at(-1)).toBe('pipeline');
    expect(existsSync(root)).toBe(false);
  });
});
