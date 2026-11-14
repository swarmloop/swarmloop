import { drive } from './run-driver.spec-helpers';
import { expectGolden } from '../testing/step-trace.spec-helpers';

/** The runtime of a run is its first implement agent. */
const IMPLEMENT_AGENT = { AGENTS_IMPLEMENT: 'cursor:grok-4.7' };

describe('run driver golden traces', () => {
  it('runs a full auto pass through all phases', async () => {
    const { trace } = await drive({}, { auto: true }, undefined, IMPLEMENT_AGENT);
    expectGolden('run-driver.full-auto-pass', trace);
  });

  it('stops a review return loop at MAX_RETURNS', async () => {
    const { trace } = await drive(
      { 'code-review': () => ({ outcome: 'waiting', exitCode: 0, moveTo: 'implement' }) },
      { auto: true },
      undefined,
      { ...IMPLEMENT_AGENT, MAX_RETURNS: '3' },
    );
    expectGolden('run-driver.review-returns', trace);
  });

  it('relaunches a failed step up to MAX_LAUNCHES', async () => {
    const { trace } = await drive({ research: () => ({ outcome: 'failed', exitCode: 1 }) }, { auto: true }, undefined, {
      ...IMPLEMENT_AGENT,
      MAX_LAUNCHES: '3',
    });
    expectGolden('run-driver.failed-relaunch', trace);
  });

  it('stops before the next step once the run is over the spend limit', async () => {
    const { trace } = await drive(
      {
        requirements: (_visit, ctx) => {
          ctx.opened.run.spentUsd = 30;
          return { outcome: 'ok', exitCode: 0, visit: { usd: 30 } };
        },
      },
      { auto: true },
      undefined,
      { ...IMPLEMENT_AGENT, MAX_RUN_USD: '25' },
    );
    expectGolden('run-driver.spend-stop', trace);
  });
});
