import { mkdirSync, mkdtempSync, writeFileSync } from 'fs';
import { RunNames } from '../steps/shared/run-names';
import { tmpdir } from 'os';
import { join } from 'path';
import { AppConfig } from '../config/env';
import { testEnv } from '../config/env.spec-helpers';
import { FakeClock } from '../core/fake-clock.spec-helpers';
import type { PlanChatEntry } from '../contract/plan-chat';
import type { RunEntity } from '../history/entities';
import { sessionFileName, sessionHome } from '../history/session-group';
import type { VisitDraft } from '../history/visit';
import { agentStateDir } from '../sandbox/sandbox-launch';
import { ARTIFACTS } from '../steps/contract/artifacts';
import { git } from '../testing/git-fixture';
import { renderMergeRequest } from '../steps/merge-request/merge-request-record';
import { renderQuestions } from '../steps/research/research-record';
import { planChangesOf } from '../steps/shared/plan-changes';
import { ReportRefresh } from '../steps/shared/report-refresh';
import { RunReport } from '../steps/shared/run-report';
import { StartGate } from './start-gate';
import { SubtaskPlannerAnswer } from './subtask-planner-answer';
import { SubtaskPort } from './subtask-port';

const answered = {
  responseText: 'use the shared helper',
  resultValue: { decision: 'use the shared helper' },
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

async function asked(
  env: Parameters<typeof testEnv>[0],
  epic: boolean,
  stored: Record<string, string> = {},
  value: Record<string, unknown> = answered.resultValue,
) {
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
    return Promise.resolve({ ...answered, resultValue: value });
  });
  const submit = jest.fn().mockResolvedValue(undefined);
  const finished: VisitDraft[] = [];
  const written: Record<string, string> = {};
  const createPort = () =>
    new SubtaskPort(
      { findRun: async (key: string) => ({ key }) } as never,
      {
        latestBody: async (_key: string, kind: string) =>
          stored[kind] ?? (['research_result', 'plan_result', 'implementation_result'].includes(kind) ? null : 'app\n'),
        putDocument: async (_run: unknown, kind: string, body: string) => void (written[kind] = body),
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
      {} as never,
    );
  let port = createPort();
  const opened = { run: parent, startedAt: '2026-01-01T00:00:00.000Z' } as never;
  await port.answer(opened, { key: 'child' } as RunEntity, { id: 't1' } as never, 'contract');
  const again = (): Promise<unknown> =>
    port.answer(opened, { key: 'child-2' } as RunEntity, { id: 't2' } as never, 'contract');
  return {
    input: launch.mock.calls[0][0],
    visit: finished[0],
    submit,
    written,
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
    expect(first).toContain('- decision (string, required)');
    expect(second).not.toContain('- decision (string, required)');
    expect(second).toContain('End with the result block as before.');
  });

  it('asks in full again once the parent has made a new plan visit', async () => {
    const { launch, again, receive } = await asked({}, false, { questions: '- one?\n' });
    receive('plan');
    await again();

    expect(prompts(launch)[1]).toContain('- decision (string, required)');
  });

  it('asks in full after plan-improve changed the shared chat definition', async () => {
    const { launch, again, receive } = await asked({}, false, { questions: '- one?\n' });
    receive('plan_improve');
    await again();

    expect(prompts(launch)[1]).toContain('- decision (string, required)');
    expect(prompts(launch)[1]).not.toContain('End with the result block as before.');
  });

  it('keeps the one-line reminder after the server restarts with the same chat definition', async () => {
    const { launch, again, restart } = await asked({}, false, { questions: '- one?\n' });
    restart();
    await again();

    expect(prompts(launch)[1]).toContain('End with the result block as before.');
    expect(prompts(launch)[1]).not.toContain('- decision (string, required)');
  });

  it('answers with the whole decision field', async () => {
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
      {} as never,
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
      {} as never,
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
        : new ReportRefresh(
            runs as never,
            docs as never,
            report,
            { hostFor: async () => host } as never,
            new RunNames({ documents: docs } as never),
          );
      const port = new SubtaskPort(
        runs as never,
        docs as never,
        {} as never,
        {} as never,
        {} as never,
        new AppConfig(testEnv({ SWARMLOOP_ROOT: dir })),
        clock,
        {} as never,
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

describe('the parent finds what a subtask asks at plan and implement', () => {
  const escalation = {
    key: 'escalate-ask-1',
    role: 'planner',
    kind: 'escalation',
    from: 'implement',
    text: 'Which pagination?',
    at: '2026-01-01T00:00:00.000Z',
    state: 'pending',
  } as PlanChatEntry;

  function answerer(stored: Record<string, string>, entries: PlanChatEntry[]) {
    const appended: PlanChatEntry[] = [];
    const taken: string[] = [];
    const chat = {
      read: async () => ({ entries: [...entries, ...appended], revisions: [] }),
      answerFor: async () => null,
      appendEntry: async (_key: string, entry: PlanChatEntry) => void appended.push(entry),
      markTaken: async (_key: string, keys: string[]) => void taken.push(...keys),
    };
    const resume = jest.fn().mockResolvedValue('accepted');
    const documents = {
      latestBody: async (_key: string, kind: string) => stored[kind] ?? null,
      putDocument: async () => undefined,
    };
    const planner = new SubtaskPlannerAnswer(
      documents as never,
      {} as never,
      { resume } as never,
      { chat, clock: new FakeClock() } as never,
      { listStats: async () => [] } as never,
    );
    return { planner, appended, taken, resume };
  }

  it("finds a plan's question in the questions of the run", async () => {
    const stored = {
      questions: renderQuestions(['Which column?']),
      plan_result: ARTIFACTS.planResult.format({
        summary: [],
        plan: [],
        questions: [],
        question: 'Which column?',
        contract: [],
        tasks: [],
        keep: [],
      }),
    };
    const run = { key: 'child', status: 'waiting', currentStep: 'plan' } as RunEntity;
    expect(await answerer(stored, []).planner.asking(run)).toBe(true);
    const answers = `question: Which column?\nanswer: int\n`;
    expect(await answerer({ ...stored, answers }, []).planner.asking(run)).toBe(false);
  });

  it("finds an implement escalation, and closes it when the parent's answer is delivered", async () => {
    const run = { key: 'child', status: 'waiting', currentStep: 'implement' } as RunEntity;
    const { planner, appended, taken, resume } = answerer({}, [escalation]);
    expect(await planner.asking(run)).toBe(true);

    await planner.deliver(run, 'Use a cursor.');

    expect(appended).toMatchObject([{ kind: 'answer', from: 'implement', text: 'Use a cursor.' }]);
    expect(taken).toEqual(['escalate-ask-1']);
    expect(resume).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'child' }),
      expect.objectContaining({ by: 'planner', level: 0 }),
    );
  });

  it('keeps the answer recorded when the gate holds the start back for a stopped task', async () => {
    const run = { key: 'child', status: 'waiting', currentStep: 'implement' } as RunEntity;
    const { planner, appended, resume } = answerer({}, [escalation]);
    resume.mockResolvedValue('stopped');

    await planner.deliver(run, 'Use a cursor.');

    expect(appended).toMatchObject([{ kind: 'answer', text: 'Use a cursor.' }]);
  });

  it('does not find a question that waits for the own planner of the subtask', async () => {
    const run = { key: 'child', status: 'waiting', currentStep: 'implement' } as RunEntity;
    const question = { ...escalation, key: 'ask-1', kind: 'question' } as PlanChatEntry;
    expect(await answerer({}, [question]).planner.asking(run)).toBe(false);
  });
});

describe("the parent's actions on a subtask's question", () => {
  const AT = '2026-01-01T00:00:00.000Z';
  const parent = { key: 'parent', status: 'running', currentStep: 'implement' } as RunEntity;
  const child = { key: 'parent-a', status: 'waiting', currentStep: 'research' } as RunEntity;

  /** A port over documents kept in memory, for the runs `parent` and `parent-a`. */
  function memory() {
    const bodies = new Map<string, string>();
    const key = (run: string, kind: string): string => `${run}/${kind}`;
    const documents = {
      latestBody: async (run: string, kind: string) => bodies.get(key(run, kind)) ?? null,
      putDocument: async (run: RunEntity, kind: string, body: string) => void bodies.set(key(run.key, kind), body),
    };
    const runs = {
      findRun: async (name: string) => [parent, child].find((run) => run.key === name) ?? null,
      findSubtask: async (_run: RunEntity, id: string) => (id === 'a' ? child : null),
    };
    const port = new SubtaskPort(
      runs as never,
      documents as never,
      {} as never,
      {} as never,
      {} as never,
      new AppConfig(testEnv({ SWARMLOOP_ROOT: tmpdir() })),
      new FakeClock(),
      {} as never,
    );
    return { port, documents };
  }

  it("shows a change of the task list with its reason in the parent's chat and in the changed task's own chat", async () => {
    const { port, documents } = memory();
    const change = { taskId: 'a', reason: 'b hands its part over', before: ['old'], after: ['new'] };

    await port.recordRevisions(parent, [change], AT);
    await port.recordRevisions(parent, [change], AT);

    for (const run of ['parent', 'parent-a']) {
      const body = await documents.latestBody(run, 'plan_chat');
      const section = planChangesOf([{ kind: 'plan_chat', body: body ?? '' }]);
      expect(section?.body).toBe('Plan v2: b hands its part over\n  changed: new');
    }
  });

  it('writes a change of a task that has no run in the parent’s chat only', async () => {
    const { port, documents } = memory();

    await port.recordRevisions(parent, [{ taskId: 'new', reason: 'a needs it', before: [], after: ['added'] }], AT);

    expect(await documents.latestBody('parent', 'plan_chat')).toContain('a needs it');
    expect(await documents.latestBody('parent-a', 'plan_chat')).toBeNull();
  });
});

describe('an answer of the planner that names tasks to wait for', () => {
  it('stores them as the needs of the subtask and closes its question instead of sending the decision', async () => {
    const decision = { decision: 'Take b.', waitFor: [{ id: 'b', what: 'the helper' }] };

    const { submit, written } = await asked({}, false, { questions: '- one?\n' }, decision);

    expect(written.needs).toBe('needs:\n- b: the helper\n');
    expect(written.questions).toBe('');
    expect(submit).not.toHaveBeenCalled();
  });
});

describe('SubtaskPort rerun', () => {
  const needs = '- state-source: Decide how the code is read';
  const lines = ['state-source merged: done'];

  function rerunning(stopped: boolean) {
    const bodies: Record<string, string> = { needs, handoff: 'earlier note' };
    const accepted: unknown[][] = [];
    const submitted: unknown[][] = [];
    const run = {
      key: 'child',
      status: stopped ? 'blocked' : 'waiting',
      currentStep: 'implement',
      state: stopped ? 'stopped' : 'waiting',
      stateReason: stopped ? JSON.stringify({ code: 'STOPPED', message: 'Stopped.' }) : null,
    } as RunEntity;
    let reads = 0;
    const stoppedRun = {
      ...run,
      status: 'blocked',
      state: 'stopped',
      stateReason: JSON.stringify({ code: 'STOPPED', message: 'Stopped.' }),
    };
    /** The first read, before the documents are written, sees the run going; every later read sees it stopped. */
    let stopAfter = Infinity;
    const runs = { findRun: async () => (reads++ >= stopAfter ? stoppedRun : run), children: async () => [run] };
    const commands = {
      accept: async (...call: unknown[]) => {
        accepted.push(call);
        return { replayed: false };
      },
      submit: async (...call: unknown[]) => void submitted.push(call),
    };
    const documents = {
      latestBody: async (_key: string, kind: string) => bodies[kind] ?? null,
      latestDocument: async (_key: string, kind: string) => (kind in bodies ? { id: 7, body: bodies[kind] } : null),
      putDocument: async (_run: unknown, kind: string, body: string) => void (bodies[kind] = body),
    };
    const port = new SubtaskPort(
      runs as never,
      documents as never,
      commands as never,
      {} as never,
      {} as never,
      new AppConfig(testEnv({ SWARMLOOP_ROOT: tmpdir() })),
      new FakeClock(),
      new StartGate(commands as never, runs as never),
    );
    return {
      port,
      run,
      bodies,
      accepted,
      submitted,
      stopBeforeResume: () => void (stopAfter = 1),
    };
  }

  it('leaves the needs and the handoff and stores no resume for a run a person stopped', async () => {
    const { port, run, bodies, accepted } = rerunning(true);

    await port.rerun(run, lines);

    expect(bodies).toEqual({ needs, handoff: 'earlier note' });
    expect(accepted).toEqual([]);
  });

  it('puts the needs and the handoff back when a person stops the run while the resume is asked', async () => {
    const { port, run, bodies, accepted, stopBeforeResume } = rerunning(false);
    stopBeforeResume();

    await port.rerun(run, lines);

    expect(bodies).toEqual({ needs, handoff: 'earlier note' });
    expect(accepted).toEqual([]);
  });

  it('does not resume a stopped task or parent for the machine, and resumes the recorded stopped tasks for a person', async () => {
    const { port, run, bodies, accepted } = rerunning(true);
    bodies.epic_stopped_tasks = 'child';

    await port.resume(run);
    await port.resumeParent(run, 'subtasks-1');
    expect(accepted).toEqual([]);

    await port.resumeStopped(run);
    expect(accepted.map((call) => call[2])).toEqual([{ by: 'person', level: null }]);
  });

  it('names the resume of a recorded task by the task and the record, and clears the record', async () => {
    const { port, run, bodies, accepted } = rerunning(true);
    bodies.epic_stopped_tasks = 'child';

    await port.resumeStopped(run);

    const key = (accepted[0][3] as { idempotencyKey: string }).idempotencyKey;
    expect(key).toBe('epic-resume-child-7');
    expect(bodies.epic_stopped_tasks).toBe('');
  });

  it('resumes nothing without a record, for a task not recorded, or for a recorded task no longer stopped', async () => {
    const without = rerunning(true);
    await without.port.resumeStopped(without.run);
    const other = rerunning(true);
    other.bodies.epic_stopped_tasks = 'someone-else';
    await other.port.resumeStopped(other.run);
    const moved = rerunning(false);
    moved.bodies.epic_stopped_tasks = 'child';
    await moved.port.resumeStopped(moved.run);

    expect([without.accepted, other.accepted, moved.accepted]).toEqual([[], [], []]);
  });

  it('records only the tasks a Stop reaches, and keeps what an earlier Stop recorded', async () => {
    const going = rerunning(false);
    going.run.state = 'running';
    await going.port.stopAll(going.run);
    expect(going.bodies.epic_stopped_tasks).toBe('child');
    expect(going.submitted.map((call) => call[0])).toEqual(['stop']);

    const outage = rerunning(false);
    outage.run.stateReason = JSON.stringify({ code: 'HOST_UNAVAILABLE', message: 'Host is down.' });
    await outage.port.stopAll(outage.run);
    expect(outage.bodies.epic_stopped_tasks).toBe('child');

    const plain = rerunning(false);
    await plain.port.stopAll(plain.run);
    expect(plain.bodies.epic_stopped_tasks).toBeUndefined();

    const stopped = rerunning(true);
    await stopped.port.stopAll(stopped.run);
    expect(stopped.bodies.epic_stopped_tasks).toBeUndefined();

    const again = rerunning(true);
    again.bodies.epic_stopped_tasks = 'first';
    await again.port.stopAll(again.run);
    expect(again.bodies.epic_stopped_tasks).toBe('first');
  });

  it('names the event by the needs and the lines, not by the visits, and resumes as the machine unless told', async () => {
    const first = rerunning(false);
    await first.port.rerun(first.run, lines);
    const again = rerunning(false);
    await again.port.rerun(again.run, lines);
    const other = rerunning(false);
    await other.port.rerun(other.run, ['state-source merged: another'], { by: 'planner', level: 1 });

    const key = (call: unknown[][]) => (call[0][3] as { idempotencyKey: string }).idempotencyKey;
    expect(key(first.accepted)).toMatch(/^subtask-needs-child-[0-9a-f]{64}$/);
    expect(key(again.accepted)).toBe(key(first.accepted));
    expect(key(other.accepted)).not.toBe(key(first.accepted));
    expect(first.accepted[0][2]).toEqual({ by: 'machine', level: null });
    expect(other.accepted[0][2]).toEqual({ by: 'planner', level: 1 });
  });
});
