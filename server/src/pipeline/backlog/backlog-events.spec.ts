import type { BacklogEventKind } from '../../contract/backlog';
import { join } from 'path';
import { DocumentRepository } from '../../history/document.repository';
import { PlanChatStore } from '../../history/plan-chat.store';
import { RunRepository } from '../../history/run.repository';
import { copyMainWithOrigin, git } from '../../testing/git-fixture';
import { readStoredQuestions } from '../../steps/shared/question-parts';
import type { PlanConversation } from '../../steps/shared/plan-conversation';
import { PlannerChain } from '../planner-chain';
import { SubtaskPlannerAnswer } from '../subtask-planner-answer';
import { backlogHarness } from './backlog.spec-helpers';

type Harness = Awaited<ReturnType<typeof backlogHarness>>;

async function withHarness(body: (harness: Harness) => Promise<void>): Promise<void> {
  const harness = await backlogHarness();
  try {
    await body(harness);
  } finally {
    await harness.scheduler().onModuleDestroy();
    await harness.db.close();
  }
}

async function events(h: Harness, id: number, kind: BacklogEventKind) {
  return (await h.backlogs.events(id, 100)).filter((event) => event.kind === kind);
}

const waitingRun = { status: 'waiting', reason: { code: 'GIT_AUTH', message: 'the git login was refused' } };

describe('BacklogEvents', () => {
  it('makes no host call and writes nothing without a backlog', () =>
    withHarness(async (h) => {
      h.setMain('web');
      h.fake.calls.length = 0;
      await h.tick();
      expect(h.fake.calls).toEqual([]);
    }));

  it('writes run-needs-person once, naming the run key and the tasks it holds back', () =>
    withHarness(async (h) => {
      h.setMain('web');
      const id = (await h.seedBacklog('one')).id as number;
      await h.seedTask(id, 'a', { runKey: 'a-1' });
      await h.seedTask(id, 'b', { depends: ['a'] });
      await h.seedTask(id, 'c', { depends: ['b'] });
      await h.seedTask(id, 'd');
      await h.seedDoneRun('a-1', []);
      await h.moveRun('a-1', waitingRun);

      await h.tick();
      await h.tick();

      expect(await events(h, id, 'run-needs-person')).toMatchObject([
        { facts: { slug: 'a', runKey: 'a-1', state: 'waiting', reason: 'the git login was refused', holds: 'b, c' } },
      ]);
    }));

  it('writes run-asks-planner once for each open question of a run the planner holds, with its id', () =>
    withHarness(async (h) => {
      h.setMain('web');
      const id = (await h.seedBacklog('one')).id as number;
      await h.seedTask(id, 'a', { runKey: 'a-1' });
      await h.seedDoneRun('a-1', []);
      await h.moveRun('a-1', { status: 'waiting', currentStep: 'research' });
      const run = (await h.runs.findRun('a-1')) as NonNullable<Awaited<ReturnType<typeof h.runs.findRun>>>;
      await h.db.app.get(DocumentRepository).putDocument(run, 'questions', '- Which store?\n- Which queue?\n');

      await h.tick();
      await h.tick();

      const asked = await events(h, id, 'run-asks-planner');
      expect(asked.map((event) => event.facts).sort((a, b) => a.questionId.localeCompare(b.questionId))).toEqual([
        { slug: 'a', runKey: 'a-1', questionId: 'Which queue?', question: 'Which queue?' },
        { slug: 'a', runKey: 'a-1', questionId: 'Which store?', question: 'Which store?' },
      ]);
    }));

  it('writes no run-asks-planner for a question the planner passed on', () =>
    withHarness(async (h) => {
      h.setMain('web');
      const id = (await h.seedBacklog('one')).id as number;
      await h.seedTask(id, 'a', { runKey: 'a-1' });
      await h.seedDoneRun('a-1', []);
      await h.moveRun('a-1', { status: 'waiting', currentStep: 'research' });
      const run = (await h.runs.findRun('a-1')) as NonNullable<Awaited<ReturnType<typeof h.runs.findRun>>>;
      const documents = h.db.app.get(DocumentRepository);
      await documents.putDocument(run, 'questions', '- Which store?\n');
      await documents.putDocument(
        run,
        'passed_on',
        JSON.stringify([{ question: 'Which store?', line: 'Yours.', at: 'now' }]),
      );

      await h.tick();

      expect(await events(h, id, 'run-asks-planner')).toEqual([]);
    }));

  it('writes run-needs-person once for a blocked run', () =>
    withHarness(async (h) => {
      h.setMain('web');
      const id = (await h.seedBacklog('one')).id as number;
      await h.seedTask(id, 'a', { runKey: 'a-1' });
      await h.seedDoneRun('a-1', []);
      await h.moveRun('a-1', {
        status: 'blocked',
        reason: { code: 'GIT_RULES', message: 'the branch name was refused' },
      });

      await h.tick();
      await h.tick();

      expect(await events(h, id, 'run-needs-person')).toMatchObject([
        { facts: { slug: 'a', runKey: 'a-1', state: 'blocked', reason: 'the branch name was refused' } },
      ]);
    }));

  describe('the end a run-needs-person event reports', () => {
    async function seedEnded(h: Harness, key: string, change: Parameters<Harness['moveRun']>[1]) {
      await h.seedDoneRun(key, []);
      await h.moveRun(key, change);
      const { clone } = copyMainWithOrigin(join(h.db.root, 'worktrees', key), 'web');
      return `web=${git(clone, ['rev-parse', 'HEAD'])}`;
    }

    it('names a failed run, its step, no code and the heads of its work trees, and reads them only for a new key', () =>
      withHarness(async (h) => {
        h.setMain('web');
        const id = (await h.seedBacklog('one')).id as number;
        await h.seedTask(id, 'a', { runKey: 'a-1' });
        const heads = await seedEnded(h, 'a-1', { status: 'failed', currentStep: 'implement' });

        await h.tick();
        await h.tick();

        expect(await events(h, id, 'run-needs-person')).toMatchObject([
          {
            facts: {
              runKey: 'a-1',
              state: 'failed',
              endRun: 'a-1',
              endStep: 'implement',
              endCode: '',
              endHeads: heads,
            },
          },
        ]);
      }));

    it('names the first part that needs a person for an epic blocked by its parts', () =>
      withHarness(async (h) => {
        h.setMain('web');
        const id = (await h.seedBacklog('one')).id as number;
        await h.seedTask(id, 'a', { runKey: 'a-1' });
        await seedEnded(h, 'a-1', {
          status: 'blocked',
          currentStep: 'implement',
          reason: { code: 'SUBTASK_BLOCKED', message: 'a part is blocked' },
        });
        const epic = (await h.runs.findRun('a-1')) as NonNullable<Awaited<ReturnType<typeof h.runs.findRun>>>;
        await h.seedDoneRun('p-1', []);
        const heads = await seedEnded(h, 'p-2', {
          status: 'blocked',
          currentStep: 'code-review',
          reason: { code: 'GIT_RULES', message: 'refused' },
        });
        for (const key of ['p-1', 'p-2']) {
          const part = (await h.runs.findRun(key)) as NonNullable<Awaited<ReturnType<typeof h.runs.findRun>>>;
          part.parentRunId = epic.id;
          await h.runs.saveRun(part);
        }

        await h.tick();

        expect(await events(h, id, 'run-needs-person')).toMatchObject([
          {
            facts: {
              runKey: 'a-1',
              endRun: 'p-2',
              endStep: 'code-review',
              endCode: 'GIT_RULES',
              endHeads: heads,
            },
          },
        ]);
      }));

    it('names the epic itself when it is blocked in its own step', () =>
      withHarness(async (h) => {
        h.setMain('web');
        const id = (await h.seedBacklog('one')).id as number;
        await h.seedTask(id, 'a', { runKey: 'a-1' });
        await seedEnded(h, 'a-1', {
          status: 'blocked',
          currentStep: 'plan',
          reason: { code: 'GIT_RULES', message: 'refused' },
        });

        await h.tick();

        expect(await events(h, id, 'run-needs-person')).toMatchObject([
          { facts: { endRun: 'a-1', endStep: 'plan', endCode: 'GIT_RULES' } },
        ]);
      }));
  });

  it('writes run-done-without-request once for a done run with no merge request', () =>
    withHarness(async (h) => {
      h.setMain('web');
      const id = (await h.seedBacklog('one')).id as number;
      await h.seedTask(id, 'a', { runKey: 'a-1' });
      await h.seedDoneRun('a-1', []);

      await h.tick();
      await h.tick();

      expect(await events(h, id, 'run-done-without-request')).toMatchObject([{ facts: { slug: 'a', runKey: 'a-1' } }]);
    }));

  it('writes task-merged once when the layer merges a task', () =>
    withHarness(async (h) => {
      h.setMain('web');
      const id = (await h.seedBacklog('one')).id as number;
      await h.seedTask(id, 'a', { runKey: 'a-1' });
      await h.seedDoneRun('a-1', [{ repo: 'web', iid: 5 }]);

      await h.tick();
      await h.tick();

      expect(await events(h, id, 'task-merged')).toMatchObject([{ facts: { slug: 'a' } }]);
    }));

  it('writes main-red once per head and main-green only after a main-red', () =>
    withHarness(async (h) => {
      const id = (await h.seedBacklog('one')).id as number;
      await h.seedTask(id, 'a');
      h.setMain('web', 'green');
      await h.tick();
      expect(await events(h, id, 'main-green')).toEqual([]);

      h.setMain('web', 'red');
      await h.tick();
      await h.tick();
      expect(await events(h, id, 'main-red')).toMatchObject([
        { facts: { repository: 'web', head: 'acme/web-head-0' } },
      ]);

      h.setMain('web', 'pending');
      await h.tick();
      expect(await events(h, id, 'main-green')).toEqual([]);

      h.fake.setHead('acme/web', 'head-1');
      h.setMain('web', 'green');
      await h.tick();
      await h.tick();
      h.fake.setHead('acme/web', 'head-2');
      h.setMain('web', 'green');
      await h.tick();
      expect(await events(h, id, 'main-green')).toMatchObject([{ facts: { repository: 'web', head: 'head-1' } }]);

      h.fake.setHead('acme/web', 'head-3');
      h.setMain('web', 'red');
      await h.tick();
      h.fake.setHead('acme/web', 'head-4');
      h.setMain('web', 'green');
      await h.tick();
      expect(await events(h, id, 'main-green')).toHaveLength(2);
    }));

  it('closes a requirement when its last covering task merges, and readies the milestone once its last requirement closes', () =>
    withHarness(async (h) => {
      h.setMain('web');
      const id = (await h.seedBacklog('one')).id as number;
      const milestone = (await h.seedMilestone(id, 1)).id as number;
      await h.seedRequirement(milestone, 'M1.R1');
      await h.seedRequirement(milestone, 'M1.R2');
      await h.seedTask(id, 'a', { milestoneId: milestone, covers: ['M1.R1'], runKey: 'a-1' });
      await h.seedTask(id, 'b', { milestoneId: milestone, covers: ['M1.R1', 'M1.R2'], runKey: 'b-1' });
      await h.seedDoneRun('a-1', [{ repo: 'web', iid: 5 }]);
      await h.seedDoneRun('b-1', [{ repo: 'web', iid: 6 }]);
      h.fake.refuseMerge('acme/web', 6, 'branch protected');
      await h.tick();
      expect(await events(h, id, 'requirement-ready')).toEqual([]);

      h.fake.refuseMerge('acme/web', 6, null);
      h.setMain('web');
      await h.tick();
      await h.tick();
      await h.tick();

      const statuses = (await h.backlogs.requirements(id)).map((requirement) => requirement.status);
      expect(statuses).toEqual(['closed', 'closed']);
      expect(await events(h, id, 'requirement-ready')).toHaveLength(2);
      expect(await events(h, id, 'milestone-ready')).toMatchObject([{ facts: { milestone: '1' } }]);
      expect((await h.backlogs.milestones(id))[0].status).toBe('active');
    }));

  it('closes a requirement for a task MergeWatch saw merged, in a paused backlog and a milestone that is not active', () =>
    withHarness(async (h) => {
      h.setMain('web');
      const id = (await h.seedBacklog('one', { paused: true })).id as number;
      const milestone = (await h.seedMilestone(id, 2, 'proposed')).id as number;
      await h.seedRequirement(milestone, 'M2.R1');
      await h.seedTask(id, 'a', { milestoneId: milestone, covers: ['M2.R1'], runKey: 'a-1' });
      const at = '2026-11-12T10:00:00Z';
      await h.seedDoneRun('a-1', [{ repo: 'web', iid: 5 }], {
        merged: { 'acme/web': { sha: 'abc', by: 'bob', at, url: null } },
      });
      await h.backlogs.saveTask({ ...(await h.task(id, 'a')), status: 'merged' });

      await h.tick();

      expect((await h.backlogs.requirements(id))[0].status).toBe('closed');
      expect(await events(h, id, 'requirement-ready')).toHaveLength(1);
      expect(await events(h, id, 'milestone-ready')).toEqual([]);
    }));

  it('leaves a requirement no task covers open, and its milestone not ready', () =>
    withHarness(async (h) => {
      h.setMain('web');
      const id = (await h.seedBacklog('one')).id as number;
      const milestone = (await h.seedMilestone(id, 1)).id as number;
      await h.seedRequirement(milestone, 'M1.R1');
      await h.seedTask(id, 'a', { milestoneId: milestone, runKey: 'a-1' });
      await h.seedDoneRun('a-1', [{ repo: 'web', iid: 5 }]);

      await h.tick();
      await h.tick();

      expect((await h.backlogs.requirements(id))[0].status).toBe('open');
      expect(await events(h, id, 'requirement-ready')).toEqual([]);
      expect(await events(h, id, 'milestone-ready')).toEqual([]);
    }));

  it('writes the refusal events through the same writer, once per head', () =>
    withHarness(async (h) => {
      h.setMain('web');
      const id = (await h.seedBacklog('one')).id as number;
      await h.seedTask(id, 'a', { runKey: 'a-1' });
      await h.seedDoneRun('a-1', [{ repo: 'web', iid: 5 }]);
      h.fake.refuseMerge('acme/web', 5, 'branch protected');

      await h.tick();
      await h.tick();

      expect(await events(h, id, 'merge-refused')).toMatchObject([
        { facts: { task: 'a', repository: 'web', message: 'branch protected' } },
      ]);
    }));

  it('writes run-chat once per planner reply, with the person messages since the last reply (newest first)', () =>
    withHarness(async (h) => {
      h.setMain('web');
      const id = (await h.seedBacklog('one')).id as number;
      await h.seedTask(id, 'a', { runKey: 'a-1' });
      await h.seedDoneRun('a-1', []);
      const chat = h.db.app.get(PlanChatStore);
      const entry = (key: string, role: 'person' | 'planner', text: string) =>
        ({ key, role, text, at: '2026-01-01T00:00:00.000Z', state: 'taken' }) as const;

      await chat.appendEntry('a-1', entry('m1', 'person', 'use the small one'));
      await h.tick();
      expect(await events(h, id, 'run-chat')).toEqual([]);

      await chat.appendEntry('a-1', entry('r1', 'planner', 'done, small one'));
      await h.tick();
      await h.tick();
      await chat.appendEntry('a-1', entry('m2', 'person', 'and rename it'));
      await chat.appendEntry('a-1', entry('r2', 'planner', 'renamed'));
      await h.tick();

      expect((await events(h, id, 'run-chat')).map((event) => event.facts)).toEqual([
        { slug: 'a', runKey: 'a-1', message: 'and rename it', reply: 'renamed' },
        { slug: 'a', runKey: 'a-1', message: 'use the small one', reply: 'done, small one' },
      ]);
    }));

  it('writes a message to a subtask of a started epic and its reply as one run-chat event of the parent run, once', () =>
    withHarness(async (h) => {
      h.setMain('web');
      const id = (await h.seedBacklog('one')).id as number;
      await h.seedTask(id, 'a', { runKey: 'a-1' });
      await h.seedDoneRun('a-1', []);
      await h.db.app.get(PlanChatStore).appendEntry('a-1', {
        key: 'exchange-a-1-b-t1',
        role: 'planner',
        kind: 'info',
        text: 'Maksym → b: use a cursor',
        reply: 'Done, a cursor.',
        link: 'a-1-b',
        at: '2026-01-01T00:00:00.000Z',
        state: 'taken',
      });
      await h.tick();
      await h.tick();

      expect((await events(h, id, 'run-chat')).map((event) => event.facts)).toEqual([
        { slug: 'a', runKey: 'a-1', message: 'Maksym → b: use a cursor', reply: 'Done, a cursor.' },
      ]);
    }));

  it('writes run-needs-person on the epic, with the question, when a subtask question reaches the starter', () =>
    withHarness(async (h) => {
      h.setMain('web');
      const id = (await h.seedBacklog('one')).id as number;
      await h.seedTask(id, 'a', { runKey: 'a-1' });
      await h.seedDoneRun('a-1', []);
      await h.moveRun('a-1', { status: 'waiting', reason: { code: 'SUBTASK_WAITING', message: 'waiting' } });
      const runs = h.db.app.get(RunRepository);
      const documents = h.db.app.get(DocumentRepository);
      const epic = (await runs.findRun('a-1'))!;
      const child = await runs.openSubtask('a-1-b', epic.id, 'b');
      const conversation = { chat: h.db.app.get(PlanChatStore), clock: h.db.clock } as unknown as PlanConversation;
      const planner = new SubtaskPlannerAnswer(
        documents,
        undefined as never,
        undefined as never,
        conversation,
        undefined as never,
      );
      const chain = new PlannerChain(
        {
          askAbout: () => Promise.resolve(null),
          handUp: (parent, taskId, text) => planner.handUp(parent, taskId, text),
        },
        conversation,
        documents,
        runs,
      );

      const asked = await chain.askUp(child, { from: 'implement', text: 'b needs c: which retry policy wins' }, 1);
      await h.tick();
      await h.tick();

      expect(asked.asked).toBe('starter');
      const stored = readStoredQuestions((await documents.latestBody('a-1', 'question_parts')) ?? '');
      expect(stored.map(({ parts }) => parts.decide)).toEqual(['b needs c: which retry policy wins']);
      expect(await events(h, id, 'run-needs-person')).toMatchObject([
        { facts: { slug: 'a', runKey: 'a-1', state: 'waiting', reason: 'waiting for a person' } },
      ]);
    }));
});
