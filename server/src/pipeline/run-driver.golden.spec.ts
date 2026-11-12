import { drive } from './run-driver.spec-helpers';
import { expectGolden } from '../testing/step-trace.spec-helpers';

describe('run driver golden traces', () => {
  it('runs a full auto pass through all phases', async () => {
    const { trace } = await drive({}, { auto: true });
    expectGolden('run-driver.full-auto-pass', trace);
  });

  it('stops a review return loop at MAX_RETURNS', async () => {
    const { trace } = await drive(
      { 'code-review': () => ({ outcome: 'waiting', exitCode: 0, moveTo: 'implement' }) },
      { auto: true },
    );
    expectGolden('run-driver.review-returns', trace);
  });

  it('relaunches a failed step up to MAX_LAUNCHES', async () => {
    const { trace } = await drive({ research: () => ({ outcome: 'failed', exitCode: 1 }) }, { auto: true });
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
    );
    expectGolden('run-driver.spend-stop', trace);
  });
});
