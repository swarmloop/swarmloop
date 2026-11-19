import { plannerTurnsHarness } from './planner-turns.spec-helpers';
import { turnResult } from './planner-scenarios.spec-helpers';

type Harness = Awaited<ReturnType<typeof plannerTurnsHarness>>;

async function withTurn(body: (harness: Harness, id: number) => Promise<void>, env: Record<string, string> = {}) {
  const harness = await plannerTurnsHarness(env);
  try {
    harness.setMain('web');
    const id = (await harness.seedBacklog('one')).id as number;
    await harness.chat.addPersonMessage(id, 'plan it', 'm1');
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
      expect(turn).toMatchObject({ status: 'done', runtime: 'cursor', tokensIn: 10, tokensOut: 5, usd: 0.5 });
      expect(turn?.model).not.toBe('');
      expect(turn?.transcript).toMatch(/turn-a-backlog-plan-output\.txt$/);
      expect(h.workspace.opened).toEqual(['turn-a']);
      expect(h.workspace.closed).toEqual(['turn-a']);
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
      expect((await h.chat.findTurn('turn-a'))?.tokensIn).toBe(10);
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
});
