import { drive } from './run-driver.spec-helpers';

describe('run driver blocks', () => {
  it('blocks a review return loop at MAX_RETURNS with LOOP_LIMIT and offers Resume', async () => {
    const { state, reason, actions } = await drive(
      { 'code-review': () => ({ outcome: 'waiting', exitCode: 0, moveTo: 'implement' }) },
      { auto: true },
    );
    expect(state).toBe('blocked');
    expect(reason?.code).toBe('LOOP_LIMIT');
    expect(reason?.message).toBe('checks ran 3 times (MAX_RETURNS); Resume starts another round');
    expect(actions).toContain('resume');
  });

  it('blocks a run over the spend limit with SPEND_LIMIT and offers Resume', async () => {
    const { state, reason, actions, result } = await drive(
      {
        requirements: (_visit, ctx) => {
          ctx.opened.run.spentUsd = 30;
          return { outcome: 'ok', exitCode: 0, visit: { usd: 30 } };
        },
      },
      { auto: true },
    );
    expect(state).toBe('blocked');
    expect(reason?.code).toBe('SPEND_LIMIT');
    expect(reason?.message).toBe('spent $30.00 of MAX_RUN_USD $25.00; raise MAX_RUN_USD, then Resume');
    expect(result.message).toContain('is over the spend limit');
    expect(actions).toContain('resume');
  });

  it('relaunches a failed step at once and ends failed, not blocked', async () => {
    let launches = 0;
    const { state } = await drive(
      {
        research: () => {
          launches += 1;
          return { outcome: 'failed', exitCode: 1 };
        },
      },
      { auto: true },
    );
    expect(state).toBe('failed');
    expect(launches).toBe(3);
  });
});
