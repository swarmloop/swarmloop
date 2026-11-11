import 'reflect-metadata';
import { SwarmloopError } from '../../core/swarmloop-error';
import { EnvironmentService } from '../../environment/environment.service';
import { RunRepository } from '../../history/run.repository';
import { goldenRun } from './implement.golden.spec-helpers';
import { result } from './implement.step.spec-helpers';

const improved = ['implementation:', '- fixed the empty case', '', 'summary:', '- fixed the empty case'].join('\n');
const agent = () => jest.fn().mockResolvedValue(result(improved));

describe('implement-improve step golden traces', () => {
  it('ok', async () => {
    const done = await goldenRun({ step: 'implement-improve', key: 'PROJ-310', scenario: 'ok', agent: agent() });
    expect(done.exitCode).toBe(0);
  });

  it('a thrown SwarmloopError', async () => {
    const done = await goldenRun({
      step: 'implement-improve',
      key: 'PROJ-311',
      scenario: 'swarmloop-error',
      agent: agent(),
      prepare: async ({ app }) => {
        jest
          .spyOn(app.get(EnvironmentService), 'prepare')
          .mockRejectedValue(new SwarmloopError('environment setup failed'));
      },
    });
    expect(done.message).toContain('environment setup failed');
  });

  it('a plain Error from a stubbed dependency', async () => {
    const done = await goldenRun({
      step: 'implement-improve',
      key: 'PROJ-312',
      scenario: 'plain-error',
      agent: agent(),
      prepare: async ({ app }) => {
        jest.spyOn(app.get(EnvironmentService), 'prepare').mockRejectedValue(new Error('boom'));
      },
    });
    expect(done.message).toContain('implement-improve failed');
  });

  it('blocks in auto when MAX_AGENT_CALLS is reached', async () => {
    const done = await goldenRun({
      step: 'implement-improve',
      key: 'PROJ-313',
      scenario: 'max-agent-calls-blocked',
      agent: agent(),
      options: { auto: true },
      prepare: async ({ app }) => {
        const runs = app.get(RunRepository);
        const run = (await runs.findRun('PROJ-313'))!;
        run.agentCalls = 20;
        await runs.saveRun(run);
      },
    });
    expect(done.message).toContain('implement-improve does not fit');
  });
});
