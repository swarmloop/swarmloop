import { existsSync } from 'fs';
import type { FlowView, RunsView, RunRef, StepView } from '../../src/contract/api';
import { createTestApp, ScriptedFakeAgentRunner } from '../../src/testing/test-app';

describe('HTTP API golden path', () => {
  it('creates a run and reads its completed state', async () => {
    const runner = new ScriptedFakeAgentRunner();
    const testApp = await createTestApp({ runner });
    const root = testApp.root;
    try {
      const createdResponse = await fetch(`${testApp.url}/runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key: 'TEST-1', prompt: 'Ship the field', projects: ['demo'] }),
      });
      const created: RunRef = await createdResponse.json();
      expect(createdResponse.status).toBe(202);
      expect(created).toEqual({ key: 'TEST-1', status: 'started' });
      await testApp.pipeline.whenIdle(created.key);
      expect(runner.steps).toEqual([
        'requirements',
        'prepare',
        'research',
        'plan',
        'plan-improve',
        'branch',
        'implement',
        'implement-improve',
        'code-review',
        'commit',
        'merge-request',
        'pipeline',
      ]);

      const runs: RunsView = await (await fetch(`${testApp.url}/runs`)).json();
      expect(runs.runs[0]).toMatchObject({ key: 'TEST-1', status: 'done', currentStep: 'done' });
      const flow: FlowView = await (await fetch(`${testApp.url}/runs/TEST-1`)).json();
      expect(flow).toMatchObject({ key: 'TEST-1', status: 'done', currentStep: 'done', resume: 'done' });
      const implement: StepView = await (await fetch(`${testApp.url}/runs/TEST-1/steps/implement`)).json();
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
