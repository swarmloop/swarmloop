import { Logger } from '@nestjs/common';
import { HostUnavailable } from '../../../core/swarmloop-error';
import { backlogMessageKey } from '../../../history/backlog-message-key';
import { plannerChatKey } from './planner-chat-key';
import { plannerTurnsHarness } from './planner-turns.spec-helpers';
import { turnResult } from './planner-scenarios.spec-helpers';
import { readerPrompt } from '../../../steps/shared/skill-prompt';

type Harness = Awaited<ReturnType<typeof plannerTurnsHarness>>;

async function withTurn(
  body: (harness: Harness, id: number) => Promise<void>,
  env: Record<string, string | number> = {},
) {
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
  tasks: [{ id: 'other', title: 'other', description: 'Do other', repositories: ['elsewhere'], files: ['other.ts'] }],
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

  it("writes the turn's cost and tokens from the sums of its log rows, and ties the row to what its events and actions name", () =>
    withTurn(async (h, id) => {
      await h.seedTask(id, 'a', { status: 'waiting' });
      await h.seedTask(id, 'b', { status: 'waiting' });
      await h.backlogs.recordEvent(id, 'merged-b', 'task-merged', { slug: 'b' });
      await h.chat.takeInto(id, 'turn-a');
      h.agent.script = [turnResult('Done.', { action: 'deleteTask', task: 'a', revision: 0 })];
      await h.runner.run('one', 'turn-a');

      const rows = await h.logOf('turn-a');
      expect(rows).toHaveLength(1);
      expect(JSON.parse(rows[0].ties ?? '[]')).toEqual([
        { task: 'b', general: false },
        { task: 'a', general: false },
      ]);
      expect(await h.chat.findTurn('turn-a')).toMatchObject({
        usd: await h.calls.spendOfTurn('turn-a'),
        ...(await h.calls.turnTokens('turn-a')),
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

  it('refuses a change that read an older revision with the task as it is now, and applies the corrected answer', () =>
    withTurn(async (h, id) => {
      await h.seedTask(id, 'a', { status: 'waiting' });
      await h.actions.changeTask('ada', 'one', 'a', { title: 'By a person' });
      h.agent.script = [
        turnResult('First try.', { action: 'changeTask', task: 'a', revision: 0, description: 'Planner text' }),
        turnResult('Second try.', { action: 'changeTask', task: 'a', revision: 1, description: 'Planner text' }),
      ];
      await h.runner.run('one', 'turn-a');

      expect(h.agent.launches).toHaveLength(2);
      expect(h.agent.launches[1].prompt).toContain(
        'a changed since it was read: it is now revision 1; title: By a person',
      );
      expect(await h.backlogs.tasks(id)).toMatchObject([
        { slug: 'a', title: 'By a person', description: 'Planner text', revision: 2 },
      ]);
    }));

  it('refuses the answer of the follow-up that changes a task with the revision a person moved while the turn worked', () =>
    withTurn(async (h, id) => {
      await h.seedTask(id, 'a', { status: 'waiting' });
      const stale = { action: 'changeTask' as const, task: 'a', revision: 0, description: 'Planner text' };
      h.agent.script = [turnResult('First.'), turnResult('Second.', stale), turnResult('Third.', stale)];
      h.agent.started = async () => {
        if (h.agent.launches.length !== 1) return;
        await h.actions.changeTask('ada', 'one', 'a', { title: 'By a person' });
        await h.chat.addPersonMessage(id, 'one more thing', 'm2', []);
        await h.chat.takeInto(id, 'turn-a');
      };
      await h.runner.run('one', 'turn-a');

      expect(h.agent.launches[2].prompt).toContain('a changed since it was read: it is now revision 1');
      expect(await h.backlogs.tasks(id)).toMatchObject([{ title: 'By a person', description: 'Do a', revision: 1 }]);
      const { messages } = await h.chat.lastMessages(id, 10);
      expect(messages.map((message) => message.kind)).toContain('refused');
    }));

  it('closes the worktrees and throws when the agent fails', () =>
    withTurn(async (h) => {
      h.agent.script = ['crash'];
      await expect(h.runner.run('one', 'turn-a')).rejects.toThrow("The planner's agent did not finish");
      expect(h.workspace.closed).toEqual(['turn-a']);
      expect(await h.chat.findTurn('turn-a')).toMatchObject({ tokensIn: 10, usd: 0.1 });
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
      expect((await h.chat.findTurn('turn-a'))?.tokensIn).toBe(10);
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

  it("ties each row of a turn that every agent's usage limit stopped to what its events name, or to the general tie", () =>
    withTurn(
      async (h, id) => {
        await h.seedTask(id, 'a', { status: 'waiting' });
        await h.seedTask(id, 'going', { runKey: 'going-1', status: 'running' });
        h.agent.script = ['limit', 'limit'];
        await h.runner.run('one', 'turn-a');
        const rows = await h.logOf('turn-a');
        expect(rows.map((row) => row.endKind)).toEqual(['limit', 'limit']);
        for (const row of rows) {
          expect(JSON.parse(row.ties ?? '[]')).toEqual([{ task: 'going', run: 'going-1', general: true }]);
        }

        await h.openTurn(id, 'turn-b');
        await h.backlogs.recordEvent(id, 'merged-a', 'task-merged', { slug: 'a' });
        await h.chat.takeInto(id, 'turn-b');
        h.agent.script = ['limit', 'limit'];
        await h.runner.run('one', 'turn-b');
        for (const row of await h.logOf('turn-b')) {
          expect(JSON.parse(row.ties ?? '[]')).toEqual([{ task: 'a', general: false }]);
        }
      },
      { AGENTS_BACKLOG_PLAN: 'claude:m-claude,codex:m-codex' },
    ));

  it('gives the turn the first helper of the runtime that runs it', () =>
    withTurn(
      async (h) => {
        h.agent.script = [turnResult('Hi.')];
        await h.runner.run('one', 'turn-a');
        expect(h.agent.launches[0].helper).toEqual({ model: 'h-claude', effort: 'low', prompt: readerPrompt() });
      },
      { AGENTS_BACKLOG_PLAN: 'claude:m-claude', AGENTS_READ: 'codex:h-codex,claude:h-claude:low' },
    ));

  it('gives the agent a failover moves to its own helper, or none', () =>
    withTurn(
      async (h) => {
        h.agent.script = ['limit', turnResult('Hi.')];
        await h.runner.run('one', 'turn-a');
        expect(h.agent.launches.map((launch) => launch.runtime)).toEqual(['claude', 'codex']);
        expect(h.agent.launches[0].helper).toEqual({ model: 'h-claude', effort: 'medium', prompt: readerPrompt() });
        expect(h.agent.launches[1].helper).toBeUndefined();
      },
      {
        AGENTS_BACKLOG_PLAN: 'claude:m-claude,codex:m-codex',
        AGENTS_READ: 'claude:h-claude',
      },
    ));

  it('keeps the reader on the follow-up of a turn that a limit moved to another agent', () =>
    withTurn(
      async (h, id) => {
        h.agent.script = ['limit', turnResult('First.'), turnResult('Second.')];
        h.agent.started = async () => {
          if (h.agent.launches.length !== 1) return;
          await h.chat.addPersonMessage(id, 'more', 'm2', []);
          await h.chat.takeInto(id, 'turn-a');
        };
        await h.runner.run('one', 'turn-a');

        expect(h.agent.launches.map((launch) => launch.runtime)).toEqual(['codex', 'claude', 'claude']);
        expect(h.agent.launches.map((launch) => launch.helper)).toEqual([
          undefined,
          { model: 'h-claude', effort: 'low', prompt: readerPrompt() },
          { model: 'h-claude', effort: 'low', prompt: readerPrompt() },
        ]);
      },
      { AGENTS_BACKLOG_PLAN: 'codex:m-codex,claude:m-claude', AGENTS_READ: 'claude:h-claude:low' },
    ));

  it('gives the reader its skill on a result follow-up and on a Resume', () =>
    withTurn(
      async (h) => {
        h.agent.script = [turnResult('First try.', outside), turnResult('Second try.'), turnResult('Again.')];
        await h.runner.run('one', 'turn-a');
        await h.runner.run('one', 'turn-a');
        expect(h.agent.launches.length).toBeGreaterThanOrEqual(3);
        expect(h.agent.launches.map((launch) => launch.helper?.prompt)).toEqual(
          h.agent.launches.map(() => readerPrompt()),
        );
      },
      { AGENTS_BACKLOG_PLAN: 'claude:m-claude', AGENTS_READ: 'claude:h-claude' },
    ));

  it('gives a turn with an empty helper list no helper', () =>
    withTurn(
      async (h) => {
        h.agent.script = [turnResult('Hi.')];
        await h.runner.run('one', 'turn-a');
        expect(h.agent.launches[0].helper).toBeUndefined();
      },
      { AGENTS_BACKLOG_PLAN: 'claude:m-claude', AGENTS_READ: '' },
    ));

  it('gives a turn no helper when READ_ROLES leaves the backlog out', () =>
    withTurn(
      async (h) => {
        h.agent.script = [turnResult('Hi.')];
        await h.runner.run('one', 'turn-a');
        expect(h.agent.launches[0].helper).toBeUndefined();
      },
      { AGENTS_BACKLOG_PLAN: 'claude:m-claude', AGENTS_READ: 'claude:h-claude', READ_ROLES: 'plan,research' },
    ));

  it('gives a turn on a runtime without a helper entry none', () =>
    withTurn(
      async (h) => {
        h.agent.script = [turnResult('Hi.')];
        await h.runner.run('one', 'turn-a');
        expect(h.agent.launches[0].runtime).toBe('cursor');
        expect(h.agent.launches[0].helper).toBeUndefined();
      },
      { AGENTS_READ: 'claude:h-claude' },
    ));

  it('sends what the turn took while the agent worked in one follow-up and applies the answer to it', () =>
    withTurn(async (h, id) => {
      h.agent.script = [turnResult('First.'), turnResult('Second, with it.')];
      h.agent.started = async () => {
        if (h.agent.launches.length !== 1) return;
        await h.chat.addPersonMessage(id, 'one more thing', 'm2', []);
        await h.chat.takeInto(id, 'turn-a');
      };
      expect(await h.runner.run('one', 'turn-a')).toEqual({ status: 'done' });

      expect(h.agent.launches).toHaveLength(2);
      expect(h.agent.launches[1].prompt).toContain('one more thing');
      expect(h.agent.launches[1].prompt).toContain('Give your whole answer again');
      expect(h.agent.launches[1].prompt).not.toContain('plan it');
      expect(await h.lines(id)).toEqual(['person: plan it', 'person: one more thing', 'planner: Second, with it.']);
    }));

  it('sends an event that came mid-turn with its facts', () =>
    withTurn(async (h, id) => {
      h.agent.script = [turnResult('First.'), turnResult('Second.')];
      h.agent.started = async () => {
        if (h.agent.launches.length !== 1) return;
        await h.backlogs.recordEvent(id, 'main-red:web:abc', 'main-red', { repository: 'web', head: 'abc' });
        await h.chat.takeInto(id, 'turn-a');
      };
      await h.runner.run('one', 'turn-a');

      expect(h.agent.launches).toHaveLength(2);
      expect(h.agent.launches[1].prompt).toContain('- main red at ');
      expect(h.agent.launches[1].prompt).toContain('repository: web');
    }));

  it('carries the helper of the turn on the follow-up too', () =>
    withTurn(
      async (h, id) => {
        h.agent.script = [turnResult('First.'), turnResult('Second.')];
        h.agent.started = async () => {
          if (h.agent.launches.length !== 1) return;
          await h.chat.addPersonMessage(id, 'more', 'm2', []);
          await h.chat.takeInto(id, 'turn-a');
        };
        await h.runner.run('one', 'turn-a');

        expect(h.agent.launches.map((launch) => launch.helper)).toEqual([
          { model: 'h-claude', effort: 'low', prompt: readerPrompt() },
          { model: 'h-claude', effort: 'low', prompt: readerPrompt() },
        ]);
      },
      { AGENTS_BACKLOG_PLAN: 'claude:m-claude', AGENTS_READ: 'claude:h-claude:low' },
    ));

  it('launches once and applies the answer when the turn took nothing while it worked', () =>
    withTurn(async (h, id) => {
      h.agent.script = [turnResult('Only.')];
      await h.runner.run('one', 'turn-a');
      expect(h.agent.launches).toHaveLength(1);
      expect(await h.lines(id)).toEqual(['person: plan it', 'planner: Only.']);
    }));

  it("records the follow-up as a row of the turn's log, tied as the first one is, and counts its cost", () =>
    withTurn(async (h, id) => {
      await h.seedTask(id, 'going', { runKey: 'going-1', status: 'running' });
      h.agent.script = [turnResult('First.'), turnResult('Second.')];
      h.agent.started = async () => {
        if (h.agent.launches.length !== 1) return;
        await h.chat.addPersonMessage(id, 'more', 'm2', []);
        await h.chat.takeInto(id, 'turn-a');
      };
      await h.runner.run('one', 'turn-a');

      const rows = await h.logOf('turn-a');
      expect(rows).toHaveLength(2);
      expect(rows.map((row) => row.ties)).toEqual([rows[0].ties, rows[0].ties]);
      expect(JSON.parse(rows[1].ties ?? '[]')).toEqual([{ task: 'going', run: 'going-1', general: true }]);
      expect(await h.chat.findTurn('turn-a')).toMatchObject({ usd: 1, tokensIn: 20 });
    }));

  describe('the planner chat of the backlog', () => {
    const CLAUDE = { AGENTS_BACKLOG_PLAN: 'claude:claude-opus-5-5:high' };

    /** Runs turn-a, then opens turn-b with a new message and runs it. */
    async function secondTurn(h: Harness, id: number, answers: Parameters<typeof turnResult>[0][] = []) {
      await h.runner.run('one', 'turn-a');
      await h.chat.addPersonMessage(id, 'and this', 'm2', []);
      await h.openTurn(id, 'turn-b');
      h.agent.script = answers.map((text) => turnResult(text));
      await h.runner.run('one', 'turn-b');
    }

    it('starts the chat from the whole brief, and the next turn resumes it with the changes and stores what it has seen', () =>
      withTurn(async (h, id) => {
        await secondTurn(h, id);

        const [first, second] = h.agent.launches;
        expect(first).toMatchObject({
          chatKey: plannerChatKey(id),
          resumeChatId: null,
          prompt: expect.stringMatching(/plan one in turn-a$/),
        });
        expect(second).toMatchObject({
          chatKey: plannerChatKey(id),
          prompt: expect.stringMatching(/changes for one in turn-b$/),
          freshPrompt: expect.stringMatching(/plan one in turn-b$/),
        });
        expect(second.resumeChatId).not.toBeNull();
        expect((await h.chat.findTurn('turn-b'))?.seenState).toBe('seen by turn-b');
      }, CLAUDE));

    it('renews a chat past its share of the context from the whole brief, says why in the log only, and resumes the new chat in its follow-up', () =>
      withTurn(
        async (h, id) => {
          const logged = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
          try {
            await h.runner.run('one', 'turn-a');
            await h.chat.addPersonMessage(id, 'and this', 'm2', []);
            await h.openTurn(id, 'turn-b');
            h.agent.started = async () => {
              if (h.agent.launches.length !== 2) return;
              await h.chat.addPersonMessage(id, 'one more', 'm3', []);
              await h.chat.takeInto(id, 'turn-b');
            };
            await h.runner.run('one', 'turn-b');

            const [, renewed, followUp] = h.agent.launches;
            expect(renewed.prompt).toMatch(/plan one in turn-b$/);
            expect(renewed.resumeChatId).toBeNull();
            expect(followUp.resumeChatId).not.toBeNull();
            expect(followUp.prompt).toContain('one more');
            expect(followUp.freshPrompt).toContain('plan one in turn-b\n\n');
            expect(followUp.freshPrompt).toContain('one more');
            expect(logged).toHaveBeenCalledWith('turn turn-b: new planner chat: chat past its size limit');
          } finally {
            logged.mockRestore();
          }
        },
        { ...CLAUDE, BACKLOG_CHAT_CONTEXT_SHARE: 0.000001 },
      ));

    it('sends the whole brief to the next agent when a usage limit moves a resumed turn', () =>
      withTurn(
        async (h, id) => {
          await h.runner.run('one', 'turn-a');
          await h.chat.addPersonMessage(id, 'and this', 'm2', []);
          await h.openTurn(id, 'turn-b');
          h.agent.script = ['limit', turnResult('Moved.')];
          await h.runner.run('one', 'turn-b');

          const [, resumed, moved] = h.agent.launches;
          expect(resumed.prompt).toMatch(/changes for one in turn-b$/);
          expect(moved).toMatchObject({ runtime: 'codex', prompt: expect.stringMatching(/plan one in turn-b$/) });
        },
        { AGENTS_BACKLOG_PLAN: 'claude:claude-opus-5-5:high,codex:m-codex' },
      ));

    it('sends the whole brief to the next agent when a turn starts on a runtime that is cooling', () =>
      withTurn(
        async (h, id) => {
          await h.runner.run('one', 'turn-a');
          await h.chat.addPersonMessage(id, 'and this', 'm2', []);
          await h.openTurn(id, 'turn-b');
          await h.cool('claude');
          await h.runner.run('one', 'turn-b');

          const [, started] = h.agent.launches;
          expect(started).toMatchObject({ runtime: 'codex', prompt: expect.stringMatching(/plan one in turn-b$/) });
        },
        { AGENTS_BACKLOG_PLAN: 'claude:claude-opus-5-5:high,codex:m-codex' },
      ));

    it('stores no seen state on a turn that fails', () =>
      withTurn(async (h) => {
        h.agent.script = ['crash'];
        await expect(h.runner.run('one', 'turn-a')).rejects.toThrow();
        expect((await h.chat.findTurn('turn-a'))?.seenState).toBeNull();
      }));
  });

  describe('the time limit of a turn', () => {
    it('is BACKLOG_PLAN_TIMEOUT_MS with no continue message', () =>
      withTurn(
        async (h) => {
          await h.runner.run('one', 'turn-a');
          expect(h.agent.launches[0]).toMatchObject({ timeLimitMs: 120_000, continuePrompt: null });
        },
        { BACKLOG_PLAN_TIMEOUT_MS: 120_000, PLAN_TIMEOUT_MS: 999_000 },
      ));

    it('fails with the time limit as the reason and keeps the cost and tokens of the killed call', () =>
      withTurn(
        async (h) => {
          h.agent.script = ['timeout'];
          await expect(h.runner.run('one', 'turn-a')).rejects.toThrow(
            'The planner stopped at its time limit of 2 minutes.',
          );
          expect(await h.chat.findTurn('turn-a')).toMatchObject({
            usd: await h.calls.spendOfTurn('turn-a'),
            tokensIn: 10,
            tokensOut: 5,
          });
          expect(h.agent.launches).toHaveLength(1);
        },
        { BACKLOG_PLAN_TIMEOUT_MS: 120_000 },
      ));
  });
});
