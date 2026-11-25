import 'reflect-metadata';
import { storeRun } from '../../testing/store-run.spec-helpers';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { AGENT_RUNNER, type AgentRunInput, type AgentRunResult } from '../../agent/agent-runner';
import { agentFor } from '../../config/agents';
import { AppConfig } from '../../config/env';
import { DocumentRepository } from '../../history/document.repository';
import { RunRepository } from '../../history/run.repository';
import { writeRunState } from '../../history/run-state';
import { agentStateDir } from '../../sandbox/sandbox-launch';
import { resultAnswer } from '../../testing/result-answer';
import { type TestApp } from '../../testing/test-app';
import { skillSection } from '../shared/skill-prompt';
import { SubtaskOps } from '../shared/subtask-ops';
import { PlanChatStore } from '../../history/plan-chat.store';
import { AgentDoor } from '../shared/agent-door';
import { StartRefused } from '../shared/start-refused';
import { storedState } from '../../history/run-state';
import { mergeHandoff } from '../shared/handoff';
import { KEY, child, pass, seedParent, statuses, task, tasksOf, work, world } from './split-implement.spec-helpers';

type Reply = Record<string, unknown>;

/** The start of a pass that the machine makes on its own, which the door refuses on the same input. */
const MACHINE = { startBy: 'machine' } as const;

describe('merge look', () => {
  let app: TestApp;

  afterEach(async () => {
    jest.restoreAllMocks();
    await app.close();
  });

  /** A parent with a plan chat and tasks a, b (after a) and c, whose first pass has started a and c. The planner's replies are scripted. */
  async function lookWorld(reply: Reply, env: Record<string, string> = {}) {
    const built = await world(env);
    app = built.app;
    jest.spyOn(app.app.get(SubtaskOps), 'fastForward').mockResolvedValue(null);
    const documents = app.app.get(DocumentRepository);
    const parent = await seedParent(app, [task('a'), task('b', ['a']), task('c')]);
    await documents.putDocument(parent, 'contract', '- names are camelCase\n');
    await documents.putDocument(parent, 'repos', 'demo\n');
    const runtime = agentFor(app.app.get(AppConfig).env, parent, 'plan').runtime;
    mkdirSync(join(app.root, 'data'), { recursive: true });
    mkdirSync(agentStateDir(app.root, KEY, 'plan'), { recursive: true });
    writeFileSync(join(app.root, 'data', `${KEY}-plan-session.json`), JSON.stringify({ chatId: 'chat-1', runtime }));
    mkdirSync(join(app.root, 'worktrees', KEY, 'demo'), { recursive: true });
    const prompts: string[] = [];
    const startedAtVisit: string[][] = [];
    jest
      .spyOn(app.app.get<{ run: (input: AgentRunInput) => Promise<AgentRunResult> }>(AGENT_RUNNER), 'run')
      .mockImplementation((input) => {
        prompts.push(input.prompt);
        startedAtVisit.push([...built.launched]);
        return Promise.resolve({
          responseText: resultAnswer('Done.', reply),
          chatId: 'chat-1',
          tokensIn: 10,
          tokensOut: 5,
          usd: 0.5,
          killReason: null,
          exitCode: 0,
          resumed: true,
          calls: 1,
          samples: [],
          durationMs: 1,
          startedAt: new Date(0).toISOString(),
          finishedAt: new Date(1).toISOString(),
        });
      });
    await pass(app);
    return { documents, prompts, startedAtVisit, launched: built.launched };
  }

  /** The run of a task is done and its merge is recorded, as a pass that merged it leaves it. */
  async function merge(id: string, files?: string[], handoff?: string, sha = 'abc'): Promise<void> {
    const run = await child(app, id);
    writeRunState(run, {
      status: 'done',
      currentStep: 'done',
      merge: { merged: { demo: { sha, by: null, at: '2026-11-19T00:07:10.000Z', url: null } } },
    });
    await storeRun(app.app.get(RunRepository), run);
    const documents = app.app.get(DocumentRepository);
    if (files) await documents.putDocument(run, 'merged_files', files.join('\n'));
    if (handoff) await documents.putDocument(run, 'handoff', mergeHandoff(null, 'implement', handoff));
  }

  const looks = async (documents: DocumentRepository) =>
    JSON.parse((await documents.latestBody(KEY, 'merge_look')) ?? '[]') as { task: string; marks: string[] }[];

  it('wakes the parent for every merge by default, and the dependent starts only after the visit while running tasks go on', async () => {
    const { documents, prompts, startedAtVisit, launched } = await lookWorld({ decision: 'Nothing changes.' });
    await merge('a');
    await work(app, 'c');

    await pass(app);

    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('Task a merged: Task a');
    expect(prompts[0]).toContain('It differs from its plan in nothing the server can see.');
    expect(prompts[0]).toContain('- b (waiting): ');
    expect(prompts[0]).not.toContain('- c (');
    expect(startedAtVisit[0]).not.toContain(`${KEY}-b`);
    expect(launched).toContain(`${KEY}-b`);
    expect(await statuses(app)).toEqual({ a: 'merged', b: 'running', c: 'running' });
    expect(await looks(documents)).toEqual([{ task: 'a', marks: [], at: expect.any(String) }]);
  });

  it('changes a dependent that has not started after a not built line, with the difference marked and the reason in its plan changes', async () => {
    const { documents, prompts } = await lookWorld({
      decision: 'b takes the docs.',
      changeTask: [{ id: 'b', reason: 'a left the docs out', description: 'Does b and the docs' }],
    });
    await merge('a', undefined, '- not built: docs - out of time');

    await pass(app);

    expect(prompts[0]).toContain('- not built: docs - out of time');
    expect((await tasksOf(app)).find((item) => item.id === 'b')?.description).toBe('Does b and the docs');
    expect(await documents.latestBody(KEY, 'contract')).toContain('b takes the docs.');
    for (const key of [KEY, `${KEY}-b`]) {
      expect(await documents.latestBody(key, 'plan_chat')).toContain('a left the docs out');
    }
    expect((await looks(documents))[0].marks).toEqual(['not built: docs - out of time']);
  });

  it('does not mark a task that says not built: nothing, and marks a merge that touched a file outside its plan', async () => {
    const { documents } = await lookWorld({ decision: 'Nothing changes.' });
    await merge('a', ['src/a.ts', 'src/other.ts'], '- not built: nothing');

    await pass(app);

    expect((await looks(documents))[0].marks).toEqual([
      'its merge request changed files outside its plan: src/other.ts',
    ]);
  });

  it('wakes nothing for a task merged as planned when the setting is false, and still records the look', async () => {
    const { documents, prompts } = await lookWorld(
      { decision: 'Nothing changes.' },
      { EPIC_REPLAN_EVERY_MERGE: 'false' },
    );
    await merge('a', ['src/a.ts']);

    await pass(app);

    expect(prompts).toHaveLength(0);
    expect(await looks(documents)).toEqual([{ task: 'a', marks: [], at: expect.any(String) }]);
    expect((await statuses(app)).b).toBe('running');
  });

  it('visits with the setting false when the task differs from its plan', async () => {
    const { prompts } = await lookWorld({ decision: 'Nothing changes.' }, { EPIC_REPLAN_EVERY_MERGE: 'false' });
    await merge('a', ['src/a.ts', 'src/other.ts']);

    await pass(app);

    expect(prompts).toHaveLength(1);
  });

  it('refuses to drop a task that has started and records the look with no change', async () => {
    const { documents } = await lookWorld({
      decision: 'c is not needed.',
      dropTask: [{ id: 'c', reason: 'a made it unnecessary' }],
    });
    await merge('a');
    await work(app, 'c');

    await pass(app);

    expect((await tasksOf(app)).map((item) => item.id)).toEqual(['a', 'b', 'c']);
    expect((await looks(documents)).map((look) => look.task)).toEqual(['a']);
    expect((await statuses(app)).b).toBe('running');
  });

  it('asks the look for a decision only: its prompt offers no escalation', async () => {
    const { prompts } = await lookWorld({ decision: 'Nothing changes.' });
    await merge('a');

    await pass(app);

    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('decision');
    const rules = skillSection('plan', 'The look after a merge');
    expect(rules).not.toBe('');
    expect(prompts[0]).toContain(rules);
    expect(prompts[0]).toContain('The server computes the marks, so you do not search the code for them');
    expect(prompts[0]).toContain('Tell a started or merged task what it must know in `decision`.');
    expect(prompts[0]).toContain('Do not use `waitFor`');
    expect(prompts[0]).not.toContain('escalate');
    expect(prompts[0]).not.toContain('finding');
  });

  it('does not visit twice for a task it looked at', async () => {
    const { prompts } = await lookWorld({ decision: 'Nothing changes.' });
    await merge('a');

    await pass(app);
    await pass(app);

    expect(prompts).toHaveLength(1);
  });

  describe('with the real door', () => {
    const runState = async () => storedState((await app.app.get(RunRepository).findRun(KEY))!);
    const dropLook = async (documents: DocumentRepository, id: string) => {
      const kept = (await looks(documents)).filter((look) => look.task !== id);
      await documents.putDocument((await app.app.get(RunRepository).findRun(KEY))!, 'merge_look', JSON.stringify(kept));
    };

    /** a is looked at, c merges and is looked at, then c's entry is dropped as a pass that ended before writing it leaves it. */
    async function refusedLook() {
      const built = await lookWorld({ decision: 'Nothing changes.' });
      await merge('a', undefined, undefined, 'sha-a');
      await pass(app, MACHINE);
      await merge('c', undefined, undefined, 'sha-c');
      await pass(app, MACHINE);
      await dropLook(built.documents, 'c');
      await pass(app, MACHINE);
      return built;
    }

    it('gives each of two tasks merged as planned its own look', async () => {
      const { documents, prompts } = await lookWorld({ decision: 'Nothing changes.' });
      await merge('a', undefined, undefined, 'sha-a');
      await pass(app, MACHINE);
      await merge('c', undefined, undefined, 'sha-c');
      await pass(app, MACHINE);

      expect(prompts).toHaveLength(2);
      expect((await looks(documents)).map((look) => look.task)).toEqual(['a', 'c']);
    });

    it("goes on with a refused look after a person's Resume", async () => {
      const { documents, prompts } = await refusedLook();
      expect(prompts).toHaveLength(2);
      expect((await runState()).reason?.code).toBe('SAME_INPUT');
      expect((await looks(documents)).map((look) => look.task)).toEqual(['a']);

      await pass(app, { startBy: 'person' });

      expect(prompts).toHaveLength(3);
      expect((await looks(documents)).map((look) => look.task)).toEqual(['a', 'c']);
    });

    it("goes on with a refused look after the chain's answer", async () => {
      const { documents, prompts } = await refusedLook();
      expect((await runState()).reason?.code).toBe('SAME_INPUT');
      await app.app.get(PlanChatStore).appendEntry(KEY, {
        key: 'chain-answer',
        role: 'planner',
        kind: 'answer',
        state: 'taken',
        text: 'Go on with the merge as it is.',
        at: '2026-01-01T00:00:00.000Z',
      });

      await pass(app, { startBy: 'planner', level: 1 });

      expect(prompts).toHaveLength(3);
      expect((await looks(documents)).map((look) => look.task)).toEqual(['a', 'c']);
    });
  });

  describe('when the door refuses the look', () => {
    const refuseWith = (error: StartRefused) => jest.spyOn(app.app.get(AgentDoor), 'outside').mockRejectedValue(error);
    const same = () =>
      StartRefused.sameInput({
        message: 'Same input as the last start.',
        question: { from: 'plan', text: 'What now?' },
        startLevel: 1,
      });
    const runState = async () => storedState((await app.app.get(RunRepository).findRun(KEY))!);

    it('waits with SAME_INPUT, records no look for the refused task and launches no planner', async () => {
      const { documents, prompts } = await lookWorld({ decision: 'Nothing changes.' });
      refuseWith(same());
      await merge('a');

      await pass(app);

      expect(prompts).toHaveLength(0);
      expect(await looks(documents)).toEqual([]);
      expect((await tasksOf(app)).map((item) => item.id)).toEqual(['a', 'b', 'c']);
      expect((await statuses(app)).b).toBe('waiting');
      const state = await runState();
      expect(state.state).toBe('waiting');
      expect(state.reason?.code).toBe('SAME_INPUT');
      expect(state.reason?.message).toContain('Same input as the last start.');
    });

    it('blocks the run on a limit and records no look', async () => {
      const { documents } = await lookWorld({ decision: 'Nothing changes.' });
      refuseWith(StartRefused.limit('The spend limit is reached.'));
      await merge('a');

      await pass(app);

      expect(await looks(documents)).toEqual([]);
      const state = await runState();
      expect(state.state).toBe('blocked');
      expect(state.reason?.code).toBe('SPEND_LIMIT');
    });

    it('makes the look on the next pass once the refusal clears', async () => {
      const { documents, prompts } = await lookWorld({ decision: 'Nothing changes.' });
      const refusing = refuseWith(same());
      await merge('a');
      await pass(app);

      refusing.mockRestore();
      await pass(app);

      expect(prompts).toHaveLength(1);
      expect((await looks(documents)).map((look) => look.task)).toEqual(['a']);
    });
  });
});
