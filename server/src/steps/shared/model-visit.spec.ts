import type { AgentRunResult } from '../../agent/agent-runner';
import type { OpenedStep } from '../step-run';
import { modelVisit } from './model-visit';

describe('modelVisit', () => {
  it('keeps the samples of the step next to the ones of its agent, with their sources', () => {
    const setup = { sampledAt: 't1', cpuPercent: 1, rssBytes: 10, source: 'setup' };
    const agent = { sampledAt: 't2', cpuPercent: 2, rssBytes: 20, source: 'agent' };
    const visit = modelVisit({
      opened: { run: { stepStartedAt: null }, startedAt: '2026-01-01T00:00:00.000Z' } as unknown as OpenedStep,
      now: 0,
      step: 'implement',
      mode: 'agent',
      runtime: 'codex',
      model: 'm',
      agent: { samples: [agent], calls: 1 } as unknown as AgentRunResult,
      samples: [setup],
      prompt: '',
      status: 'done',
      exitCode: 0,
    });
    expect(visit.samples).toEqual([setup, agent]);
  });
});
