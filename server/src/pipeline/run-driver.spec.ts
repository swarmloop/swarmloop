import { RunRepository } from '../history/run.repository';
import { DocumentRepository } from '../history/document.repository';
import { RunRebase } from '../steps/run-rebase';
import { deriveState, writeRunState } from '../history/run-state';
import {
  child,
  KEY as PARENT,
  pass,
  seedParent,
  settle,
  task,
  world,
} from '../steps/implement/split-implement.spec-helpers';
import { CommandService } from './command.service';
import { drive, installScripts } from './run-driver.spec-helpers';

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

describe('run driver jumps to the step that just finished', () => {
  it('runs plan-improve again when it jumps to itself, and goes on past it', async () => {
    let visits = 0;
    const { state } = await drive(
      {
        'plan-improve': () => {
          visits += 1;
          return visits === 1 ? { outcome: 'ok', exitCode: 0, moveTo: 'plan-improve' } : { outcome: 'ok', exitCode: 0 };
        },
      },
      { auto: true },
    );
    expect(visits).toBe(2);
    expect(state).toBe('done');
  });

  it('stops for a person when a step waits on itself', async () => {
    let visits = 0;
    const { state } = await drive(
      {
        research: () => {
          visits += 1;
          return { outcome: 'waiting', exitCode: 0 };
        },
      },
      { auto: true },
    );
    expect(visits).toBe(1);
    expect(state).toBe('idle');
  });
});

describe('run driver and the parent of a subtask', () => {
  it('Resume of a blocked subtask runs a parent pass at once, while the subtask still works', async () => {
    const { app } = await world();
    try {
      await seedParent(app, [task('a'), task('b', ['a'])]);
      await pass(app);
      const blocked = await child(app, 'a');
      writeRunState(blocked, {
        status: 'blocked',
        currentStep: 'research',
        reason: { code: 'LOOP_LIMIT', message: 'research ran 3 times (MAX_RETURNS); Resume starts another round' },
      });
      await app.app.get(RunRepository).saveRun(blocked);
      await pass(app);
      expect(deriveState((await app.app.get(RunRepository).findRun(PARENT))!).state).toBe('blocked');

      let parentDuringVisit: string | null = null;
      installScripts(
        app,
        {
          research: async () => {
            await app.app.get(CommandService).idle();
            await app.pipeline.whenIdle(PARENT);
            parentDuringVisit = deriveState((await app.app.get(RunRepository).findRun(PARENT))!).state;
            return { outcome: 'waiting', exitCode: 0 };
          },
        },
        ['research'],
      );
      await app.pipeline.runThrough(`${PARENT}-a`);
      await settle(app);

      expect(parentDuringVisit).toBe('waiting');
    } finally {
      await app.close();
    }
  });

  it('takes the rebase a working subtask was sent before its next step, and goes on at the step the rebase chose', async () => {
    const { app } = await world();
    try {
      await seedParent(app, [task('a')]);
      await pass(app);
      const run = await child(app, 'a');
      writeRunState(run, { status: 'waiting', currentStep: 'research' });
      await app.app.get(RunRepository).saveRun(run);
      await app.app.get(DocumentRepository).putDocument(run, 'pending_rebase', 'rebased onto the epic after b merged');
      jest.spyOn(app.app.get(RunRebase), 'rebase').mockImplementation(async (key) => {
        const moved = (await app.app.get(RunRepository).findRun(key))!;
        writeRunState(moved, { status: 'waiting', currentStep: 'implement' });
        await app.app.get(RunRepository).saveRun(moved);
        return 'start';
      });
      const ran: string[] = [];
      const visit = (name: string) => () => {
        ran.push(name);
        return { outcome: 'waiting' as const, exitCode: 0 };
      };
      installScripts(app, { research: visit('research'), implement: visit('implement') }, ['research', 'implement']);

      await app.pipeline.runThrough(`${PARENT}-a`);
      await settle(app);

      expect(ran[0]).toBe('implement');
      expect(ran).not.toContain('research');
      expect(await app.app.get(DocumentRepository).latestBody(`${PARENT}-a`, 'pending_rebase')).toBe('');
    } finally {
      await app.close();
    }
  });
});
