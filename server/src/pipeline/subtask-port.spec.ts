import { mkdirSync, mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { AppConfig } from '../config/env';
import { testEnv } from '../config/env.spec-helpers';
import { FakeClock } from '../core/fake-clock.spec-helpers';
import type { RunEntity } from '../history/entities';
import { sessionFileName, sessionHome } from '../history/session-group';
import type { VisitDraft } from '../history/visit';
import { agentStateDir } from '../sandbox/sandbox-launch';
import { ARTIFACTS } from '../steps/contract/artifacts';
import { git } from '../testing/git-fixture';
import { renderMergeRequest } from '../steps/merge-request/merge-request-record';
import { renderQuestions } from '../steps/research/research-record';
import { ReportRefresh } from '../steps/shared/report-refresh';
import { RunReport } from '../steps/shared/run-report';
import { SubtaskPort } from './subtask-port';

const answered = {
  responseText: 'use the shared helper',
  resultValue: { answer: 'use the shared helper' },
  chatId: 'chat-1',
  tokensIn: 0,
  tokensOut: 0,
  usd: 0,
  killReason: null,
  exitCode: 0,
  resumed: true,
  calls: 1,
  samples: [],
  durationMs: 0,
  startedAt: '',
  finishedAt: '',
};

async function asked(env: Parameters<typeof testEnv>[0], epic: boolean, stored: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'swarmloop-subtask-port-'));
  mkdirSync(join(dir, 'data'), { recursive: true });
  mkdirSync(agentStateDir(dir, 'parent', sessionHome('plan')), { recursive: true });
  const receive = (resultName: string): void => {
    writeFileSync(
      join(dir, 'data', sessionFileName('parent', 'plan')),
      JSON.stringify({ runtime: 'claude', chatId: 'chat-1', usd: 0, resultName }),
    );
  };
  receive('plan');
  const parent = {
    key: 'parent',
    targetPath: dir,
    agentCalls: 0,
    spentUsd: 0,
    epicAt: epic ? '2026-01-01T00:00:00.000Z' : null,
  } as unknown as RunEntity;
  const launch = jest.fn((input: { result: { name: string } }) => {
    receive(input.result.name);
    return Promise.resolve(answered);
  });
  const submit = jest.fn().mockResolvedValue(undefined);
  const finished: VisitDraft[] = [];
  const createPort = () =>
    new SubtaskPort(
      {} as never,
      {
        latestBody: async (_key: string, kind: string) =>
          stored[kind] ?? (['research_result', 'plan_result', 'implementation_result'].includes(kind) ? null : 'app\n'),
        putDocument: async () => undefined,
      } as never,
      { submit } as never,
      { launch } as never,
      {
        finishVisit: async (_run: unknown, visit: VisitDraft) => {
          finished.push(visit);
        },
      } as never,
      new AppConfig(testEnv({ SWARMLOOP_ROOT: dir, AGENTS_PLAN: 'claude:m-plan', ...env })),
      new FakeClock(),
    );
  let port = createPort();
  const opened = { run: parent, startedAt: '2026-01-01T00:00:00.000Z' } as never;
  await port.answer(opened, { key: 'child' } as RunEntity, { id: 't1' } as never, 'contract');
  const again = (): Promise<string | null> =>
    port.answer(opened, { key: 'child-2' } as RunEntity, { id: 't2' } as never, 'contract');
  return {
    input: launch.mock.calls[0][0],
    visit: finished[0],
    submit,
    launch,
    again,
    receive,
    restart: () => {
      port = createPort();
    },
  };
}

describe('SubtaskPort planner answer', () => {
  it('answers at the epic effort and records it on the visit', async () => {
    const { input, visit } = await asked({ EPIC_EFFORT: 'xhigh' }, true);

    expect(input).toMatchObject({ effort: 'xhigh', effortNote: 'epic' });
    expect(visit).toMatchObject({ effort: 'xhigh', effortNote: 'epic' });
  });

  it('shows no effort for a parent whose agent has none and with the epic setting off', async () => {
    const { input, visit } = await asked({ EPIC_EFFORT: '' }, true);

    expect('effort' in input).toBe(false);
    expect('effort' in visit).toBe(false);
  });
});

describe('the result prompt of the planner answer', () => {
  const prompts = (launch: jest.Mock): string[] =>
    launch.mock.calls.map((call) => (call[0] as { prompt: string }).prompt);

  it('asks for the result block in full once, and in one line for the next subtask of the same plan chat', async () => {
    const { launch, again } = await asked({}, false, { questions: '- one?\n' });
    await again();

    const [first, second] = prompts(launch);
    expect(first).toContain('- answer (string, required)');
    expect(second).not.toContain('- answer (string, required)');
    expect(second).toContain('End with the result block as before.');
  });

  it('asks in full again once the parent has made a new plan visit', async () => {
    const { launch, again, receive } = await asked({}, false, { questions: '- one?\n' });
    receive('plan');
    await again();

    expect(prompts(launch)[1]).toContain('- answer (string, required)');
  });

  it('asks in full after plan-improve changed the shared chat definition', async () => {
    const { launch, again, receive } = await asked({}, false, { questions: '- one?\n' });
    receive('plan_improve');
    await again();

    expect(prompts(launch)[1]).toContain('- answer (string, required)');
    expect(prompts(launch)[1]).not.toContain('End with the result block as before.');
  });

  it('keeps the one-line reminder after the server restarts with the same chat definition', async () => {
    const { launch, again, restart } = await asked({}, false, { questions: '- one?\n' });
    restart();
    await again();

    expect(prompts(launch)[1]).toContain('End with the result block as before.');
    expect(prompts(launch)[1]).not.toContain('- answer (string, required)');
  });

  it('answers with the whole answer field', async () => {
    const { submit } = await asked({}, false, { questions: '- one?\n' });

    expect(submit.mock.calls[0][2].answers[0].body).toBe('use the shared helper');
  });
});

describe("SubtaskPort answers a subtask's questions", () => {
  it('answers each question of the research result whole, with its own id', async () => {
    const questions = ['Is it ok?\n  - nested: yes\n1. first', 'second?'];
    const stored = {
      questions: renderQuestions(questions),
      research_result: ARTIFACTS.researchResult.format({ summary: [], questions, impact: [] }),
    };
    const { submit } = await asked({}, false, stored);

    const [, , { answers }] = submit.mock.calls[0];
    expect(answers.map((item: { id: string }) => item.id)).toEqual(questions);
  });

  it('answers each question of the plan result whole when the plan wrote the questions', async () => {
    const questions = ['Is it ok?\n  - nested: yes\n1. first', 'second?'];
    const stored = {
      questions: renderQuestions(questions),
      research_result: ARTIFACTS.researchResult.format({ summary: [], questions: ['from research'], impact: [] }),
      plan_result: ARTIFACTS.planResult.format({ summary: [], plan: [], questions, contract: [], tasks: [], keep: [] }),
    };
    const { submit } = await asked({}, false, stored);

    expect(submit.mock.calls[0][2].answers.map((item: { id: string }) => item.id)).toEqual(questions);
  });

  it('reads the questions of a run that has no research result', async () => {
    const { submit } = await asked({}, false, { questions: '- one?\n- two?\n' });

    expect(submit.mock.calls[0][2].answers.map((item: { id: string }) => item.id)).toEqual(['one?', 'two?']);
  });
});

describe('SubtaskPort asking', () => {
  const question = 'Is it ok?\n  - nested: yes\n1. first';
  const port = (stored: Record<string, string>) =>
    new SubtaskPort(
      {} as never,
      { latestBody: async (_key: string, kind: string) => stored[kind] ?? null } as never,
      {} as never,
      {} as never,
      {} as never,
      new AppConfig(testEnv({})),
      new FakeClock(),
    );
  const run = { key: 'child', status: 'waiting', currentStep: 'research' } as RunEntity;
  const questions = {
    questions: renderQuestions([question]),
    research_result: ARTIFACTS.researchResult.format({ summary: [], questions: [question], impact: [] }),
  };

  it('asks while a multi-line question has no answer, and stops once it is answered whole', async () => {
    expect(await port(questions).asking(run)).toBe(true);
    expect(await port({ ...questions, answers: `question: ${question}\nanswer: yes\n` }).asking(run)).toBe(false);
  });
});

describe('SubtaskPort merge requests', () => {
  function portWith(dir: string, bodies: Record<string, string>): SubtaskPort {
    return new SubtaskPort(
      {} as never,
      { latestBody: async (_key: string, kind: string) => bodies[kind] ?? null } as never,
      {} as never,
      {} as never,
      {} as never,
      new AppConfig(testEnv({ SWARMLOOP_ROOT: dir })),
      new FakeClock(),
    );
  }

  it('names each merge request by the repository whose origin is its project when a repository has none', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'swarmloop-subtask-mrs-'));
    for (const repo of ['demo', 'web']) {
      const path = join(dir, 'worktrees', 'child', repo);
      mkdirSync(path, { recursive: true });
      git(path, ['init', '-q']);
      git(path, ['remote', 'add', 'origin', `git@gitlab.example:group/${repo}.git`]);
    }
    const port = portWith(dir, {
      [ARTIFACTS.mergeRequest.kind]: renderMergeRequest([
        {
          project: 'group/web',
          iid: 4,
          url: 'https://gitlab.example/group/web/-/merge_requests/4',
          draft: true,
          summary: '',
        },
      ]),
      [ARTIFACTS.repos.kind]: 'demo\nweb\n',
    });

    expect(await port.mergeRequests({ key: 'child' } as RunEntity)).toEqual([
      { repo: 'web', project: 'group/web', iid: 4 },
    ]);
  });

  it('names merge requests by position when every repository has one', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'swarmloop-subtask-mrs-'));
    const port = portWith(dir, {
      [ARTIFACTS.mergeRequest.kind]: renderMergeRequest([
        {
          project: 'group/one',
          iid: 1,
          url: 'https://gitlab.example/group/one/-/merge_requests/1',
          draft: true,
          summary: '',
        },
      ]),
      [ARTIFACTS.repos.kind]: 'demo\n',
    });

    expect(await port.mergeRequests({ key: 'child' } as RunEntity)).toEqual([
      { repo: 'demo', project: 'group/one', iid: 1 },
    ]);
  });

  describe('recordMerged', () => {
    const PARTS = {
      line: 'The field ships.',
      done: ['x'],
      worthALook: [],
      notes: { requirements: 'a', quality: 'b', regressions: 'c', security: 'd', performance: 'e' },
      risk: 'low',
      riskReason: 'small',
    };
    const MR_URL = 'https://gitlab.example/mr/9';

    function mergeSetup(refreshThrows = false) {
      const dir = mkdtempSync(join(tmpdir(), 'swarmloop-subtask-merged-'));
      const parent = {
        id: 1,
        key: 'parent',
        createdAt: '2026-11-16T10:00:00.000Z',
        updatedAt: '2026-11-16T10:30:00.000Z',
        doneAt: null,
        status: 'waiting',
        spentUsd: 0,
        targetPath: dir,
        codeHost: 'gitlab',
      } as unknown as RunEntity;
      const child = {
        id: 2,
        key: 'child',
        parentRunId: 1,
        taskId: 't1',
        status: 'done',
        doneAt: '2026-11-16T10:20:00.000Z',
        updatedAt: '2026-11-16T10:20:00.000Z',
        spentUsd: 0,
        mergeOutcome: null,
      } as unknown as RunEntity;
      const documents: Record<string, string> = {
        requirements: JSON.stringify({ prompt: 'Ship the field\n', tickets: [] }),
        subtasks: JSON.stringify([{ id: 't1', title: 'Add the field', status: 'running' }]),
        review_report_result: JSON.stringify(PARTS),
        merge_request: renderMergeRequest([
          {
            project: 'group/demo',
            iid: 9,
            url: MR_URL,
            draft: true,
            summary: '<!-- swarmloop:report -->\nold\n<!-- /swarmloop:report -->',
          },
        ]),
      };
      const runs = {
        findById: async () => child,
        findRun: async () => parent,
        children: async () => [child],
        release: async (_run: RunEntity, change: { merge: unknown }) => {
          child.mergeOutcome = JSON.stringify(change.merge);
        },
      };
      const docs = {
        latestBody: async (_key: string, kind: string) => documents[kind] ?? null,
        listDocuments: async () => [{ stepStatId: 0, kind: 'subtasks', body: documents.subtasks }],
        putDocument: async (_run: RunEntity, kind: string, body: string) => {
          documents[kind] = body;
        },
      };
      const none = { listStats: async () => [], activePhases: async () => ['ci'], list: async () => [] };
      const clock = new FakeClock();
      const report = new RunReport(docs as never, none as never, none as never, none as never, runs as never, clock);
      const update = jest.fn(async () => ({ httpCalls: [] }));
      const host = {
        findMergeRequest: async () => ({
          record: {
            project: 'group/demo',
            iid: 9,
            url: MR_URL,
            summary: '<!-- swarmloop:report -->\nold\n<!-- /swarmloop:report -->',
            draft: true,
          },
          httpCalls: [],
        }),
        updateMergeRequest: update,
      };
      const refresh = refreshThrows
        ? ({ refresh: () => Promise.reject(new Error('host down')) } as unknown as ReportRefresh)
        : new ReportRefresh(runs as never, docs as never, report, { hostFor: async () => host } as never);
      const port = new SubtaskPort(
        runs as never,
        docs as never,
        {} as never,
        {} as never,
        {} as never,
        new AppConfig(testEnv({ SWARMLOOP_ROOT: dir })),
        clock,
        undefined,
        undefined,
        refresh,
      );
      return { port, parent, child, update };
    }

    it("re-renders the parent's merge request body with the new Tasks count when a task merges", async () => {
      const { port, parent, child, update } = mergeSetup();
      await port.recordMerged(parent, child, { demo: 'abc123' });
      const body = (update.mock.calls[0] as unknown as [string, number, string])[2];
      expect(body).toContain('| Tasks |');
      expect(body).toContain('1/1 merged');
      expect(body).toContain('- Add the field: merged, 0');
    });

    it('finishes when the refresh fails', async () => {
      const { port, parent, child } = mergeSetup(true);
      await expect(port.recordMerged(parent, child, { demo: 'abc123' })).resolves.toBeUndefined();
    });
  });
});
