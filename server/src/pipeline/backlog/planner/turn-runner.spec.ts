import { HostUnavailable } from '../../../core/swarmloop-error';
import { backlogMessageKey } from '../../../history/backlog-message-key';
import { plannerTurnsHarness } from './planner-turns.spec-helpers';
import { turnResult } from './planner-scenarios.spec-helpers';

type Harness = Awaited<ReturnType<typeof plannerTurnsHarness>>;

async function withTurn(body: (harness: Harness, id: number) => Promise<void>, env: Record<string, string> = {}) {
  const harness = await plannerTurnsHarness(env);
  try {
    harness.setMain('web');
    const id = (await harness.seedBacklog('one')).id as number;
    await harness.chat.addPersonMessage(id, 'plan it', 'm1', []);
    await harness.openTurn(id, 'turn-a');
    await body(harness, id);
  } finally {
    await harness.close();
  }
}

const outside = {
  action: 'addTasks' as const,
  tasks: [{ id: 'other', title: 'other', description: 'Do other', repositories: ['elsewhere'] }],
};

describe('BacklogTurnRunner', () => {
  it('runs a turn, applies its result and records the visit on the turn', () =>
    withTurn(async (h, id) => {
      h.agent.script = [turnResult('Here is the plan.')];
      expect(await h.runner.run('one', 'turn-a')).toEqual({ status: 'done' });

      expect(h.agent.launches).toHaveLength(1);
      expect(h.agent.launches[0].mounts.every((mount) => mount.readonly)).toBe(true);
      expect(await h.lines(id)).toEqual(['person: plan it', 'planner: Here is the plan.']);
      const turn = await h.chat.findTurn('turn-a');
      expect(turn).toMatchObject({ status: 'done', runtime: 'cursor', tokensIn: 15, tokensOut: 0, usd: 0.5 });
      expect(turn?.model).not.toBe('');
      expect(turn?.transcript).toMatch(/turn-a-backlog-plan-output\.txt$/);
      expect(h.workspace.opened).toEqual(['turn-a']);
      expect(h.workspace.closed).toEqual(['turn-a']);
    }));

  it("writes the turn's cost and tokens from the sums of its log rows, and ties the row to what its events and actions name", () =>
    withTurn(async (h, id) => {
      await h.seedTask(id, 'a', { status: 'waiting' });
      await h.seedTask(id, 'b', { status: 'waiting' });
      await h.backlogs.recordEvent(id, 'merged-b', 'task-merged', { slug: 'b' });
      await h.chat.takeInto(id, 'turn-a');
      h.agent.script = [turnResult('Done.', { action: 'deleteTask', task: 'a' })];
      await h.runner.run('one', 'turn-a');

      const rows = await h.logOf('turn-a');
      expect(rows).toHaveLength(1);
      expect(JSON.parse(rows[0].ties ?? '[]')).toEqual([
        { task: 'b', general: false },
        { task: 'a', general: false },
      ]);
      expect(await h.chat.findTurn('turn-a')).toMatchObject({
        usd: await h.calls.spendOfTurn('turn-a'),
        tokensIn: await h.calls.tokensOfTurn('turn-a'),
      });
    }));

  it('ties a turn that names nothing to the first running task, marked general', () =>
    withTurn(async (h, id) => {
      await h.seedTask(id, 'going', { runKey: 'going-1', status: 'running' });
      await h.runner.run('one', 'turn-a');
      const [row] = await h.logOf('turn-a');
      expect(JSON.parse(row.ties ?? '[]')).toEqual([{ task: 'going', run: 'going-1', general: true }]);
    }));

  it('stores what the start of a running turn waits for on its row, shows it, and clears it when the wait ends', () =>
    withTurn(async (h) => {
      const place = 'Waiting for a free agent place (4 of 4 busy)';
      const seen: string[] = [];
      h.agent.started = async (told) => {
        h.startWait.now = { code: 'AGENT_PLACE', message: place };
        await told?.();
        seen.push((await h.chat.findTurn('turn-a'))?.reason ?? 'no turn');
        h.startWait.now = null;
        await told?.();
        seen.push((await h.chat.findTurn('turn-a'))?.reason ?? 'no turn');
      };
      await h.runner.run('one', 'turn-a');
      expect(seen).toEqual([place, '']);
      expect(h.shown.map((entry) => entry.turn?.reason)).toEqual([place, '']);
    }));

  it('launches a turn whose messages have no files with no attachments', () =>
    withTurn(async (h) => {
      await h.runner.run('one', 'turn-a');
      expect(h.attachments.names('turn-a')).toEqual([]);
    }));

  it('copies the files of the turn messages into the turn folder before the launch', () =>
    withTurn(async (h, id) => {
      const file = await h.attachments.stage('shot.png', Buffer.from('png'));
      const refs = await h.attachments.claim(backlogMessageKey(id), [file.id]);
      await h.chat.addPersonMessage(id, 'see', 'm2', refs);
      await h.chat.takeInto(id, 'turn-a');
      await h.runner.run('one', 'turn-a');
      expect(h.attachments.names('turn-a')).toEqual(['shot.png']);
    }));

  it('names a refused action once in a follow-up and applies the corrected answer', () =>
    withTurn(async (h, id) => {
      h.agent.script = [turnResult('First try.', outside), turnResult('Second try.')];
      await h.runner.run('one', 'turn-a');

      expect(h.agent.launches).toHaveLength(2);
      expect(h.agent.launches[1].prompt).toContain('is not a repository of this backlog');
      expect(await h.lines(id)).toEqual(['person: plan it', 'planner: Second try.']);
      expect(await h.backlogs.tasks(id)).toEqual([]);
    }));

  it('names a refused action once, then drops it with a line in the chat when the answer keeps it', () =>
    withTurn(async (h, id) => {
      h.agent.script = [turnResult('First try.', outside), turnResult('Second try.', outside)];
      expect(await h.runner.run('one', 'turn-a')).toEqual({ status: 'done' });

      expect(h.agent.launches).toHaveLength(2);
      expect(await h.backlogs.tasks(id)).toEqual([]);
      const { messages } = await h.chat.lastMessages(id, 10);
      expect(messages.map((message) => [message.kind, message.text])).toEqual([
        ['message', 'plan it'],
        ['message', 'Second try.'],
        ['refused', expect.stringContaining('is not a repository of this backlog')],
      ]);
      expect((await h.chat.findTurn('turn-a'))?.status).toBe('done');
    }));

  it('closes the worktrees and throws when the agent fails', () =>
    withTurn(async (h) => {
      h.agent.script = ['crash'];
      await expect(h.runner.run('one', 'turn-a')).rejects.toThrow("The planner's agent did not finish");
      expect(h.workspace.closed).toEqual(['turn-a']);
      expect(await h.chat.findTurn('turn-a')).toMatchObject({ tokensIn: 15, usd: 0.1 });
    }));

  it('ends with the next try of the host when the worktrees of a turn cannot be fetched', () =>
    withTurn(async (h, id) => {
      const retryAt = new Date(h.db.clock.now() + 5 * 60_000).toISOString();
      const error = new HostUnavailable('github.com', 'Could not resolve host: github.com', retryAt);
      h.failNextOpen(error);
      await expect(h.runner.run('one', 'turn-a')).resolves.toEqual({
        status: 'waiting',
        reason: error.message,
        resumesAt: retryAt,
      });
      expect(h.agent.launches).toEqual([]);
      expect(h.workspace.closed).toEqual(['turn-a']);
      expect(await h.lines(id)).toEqual(['person: plan it']);
    }));

  it("ends with the next try of the model host and records the try's cost on the turn", () =>
    withTurn(async (h) => {
      h.agent.script = ['outage'];
      const outcome = await h.runner.run('one', 'turn-a');

      expect(outcome).toMatchObject({ status: 'waiting', reason: expect.stringContaining('api.anthropic.com') });
      expect(h.agent.launches).toHaveLength(1);
      expect((await h.chat.findTurn('turn-a'))?.tokensIn).toBe(15);
    }));

  it('runs again on Resume after a launch halted its key', () =>
    withTurn(async (h) => {
      h.runStop.halt('turn-a');
      h.agent.script = [turnResult('Back.')];
      await expect(h.runner.run('one', 'turn-a')).resolves.toEqual({ status: 'done' });
      expect(h.runStop.halted('turn-a')).toBe(false);
    }));

  it('ends with the time of the next try when every agent of its list is at a usage limit', () =>
    withTurn(
      async (h) => {
        h.agent.script = ['limit', 'limit'];
        const outcome = await h.runner.run('one', 'turn-a');

        expect(outcome).toEqual({
          status: 'waiting',
          reason: expect.stringContaining('usage limit'),
          resumesAt: new Date(h.db.clock.now() + 60 * 60_000).toISOString(),
        });
        expect(h.agent.launches.map((launch) => launch.runtime)).toEqual(['claude', 'codex']);
        expect(h.workspace.closed).toEqual(['turn-a']);
        expect(await h.lines(1)).toEqual(['person: plan it']);
      },
      { AGENTS_BACKLOG_PLAN: 'claude:m-claude,codex:m-codex' },
    ));

  it('gives the turn the first helper of the runtime that runs it', () =>
    withTurn(
      async (h) => {
        h.agent.script = [turnResult('Hi.')];
        await h.runner.run('one', 'turn-a');
        expect(h.agent.launches[0].helper).toEqual({ model: 'h-claude', effort: 'low', codeOnlyByHelper: true });
      },
      { AGENTS_BACKLOG_PLAN: 'claude:m-claude', AGENTS_BACKLOG_READ: 'codex:h-codex,claude:h-claude:low' },
    ));

  it('gives the agent a failover moves to its own helper, or none', () =>
    withTurn(
      async (h) => {
        h.agent.script = ['limit', turnResult('Hi.')];
        await h.runner.run('one', 'turn-a');
        expect(h.agent.launches.map((launch) => launch.runtime)).toEqual(['claude', 'codex']);
        expect(h.agent.launches[0].helper).toEqual({ model: 'h-claude', effort: 'medium', codeOnlyByHelper: true });
        expect(h.agent.launches[1].helper).toBeUndefined();
      },
      {
        AGENTS_BACKLOG_PLAN: 'claude:m-claude,codex:m-codex',
        AGENTS_BACKLOG_READ: 'claude:h-claude',
      },
    ));

  it('asks for the code-only-by-helper rights on a result follow-up and on a Resume', () =>
    withTurn(
      async (h) => {
        h.agent.script = [turnResult('First try.', outside), turnResult('Second try.'), turnResult('Again.')];
        await h.runner.run('one', 'turn-a');
        await h.runner.run('one', 'turn-a');
        expect(h.agent.launches.length).toBeGreaterThanOrEqual(3);
        expect(h.agent.launches.map((launch) => launch.helper?.codeOnlyByHelper)).toEqual(
          h.agent.launches.map(() => true),
        );
      },
      { AGENTS_BACKLOG_PLAN: 'claude:m-claude', AGENTS_BACKLOG_READ: 'claude:h-claude' },
    ));

  it('gives a turn with an empty helper list no helper and no rights', () =>
    withTurn(
      async (h) => {
        h.agent.script = [turnResult('Hi.')];
        await h.runner.run('one', 'turn-a');
        expect(h.agent.launches[0].helper).toBeUndefined();
      },
      { AGENTS_BACKLOG_PLAN: 'claude:m-claude', AGENTS_BACKLOG_READ: '' },
    ));

  it('gives a turn on a runtime without a helper entry none', () =>
    withTurn(
      async (h) => {
        h.agent.script = [turnResult('Hi.')];
        await h.runner.run('one', 'turn-a');
        expect(h.agent.launches[0].runtime).toBe('cursor');
        expect(h.agent.launches[0].helper).toBeUndefined();
      },
      { AGENTS_BACKLOG_READ: 'claude:h-claude' },
    ));
});
