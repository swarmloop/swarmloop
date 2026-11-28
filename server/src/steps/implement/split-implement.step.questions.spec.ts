import 'reflect-metadata';
import { storeRun } from '../../testing/store-run.spec-helpers';
import { resultAnswer } from '../../testing/result-answer';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { AGENT_RUNNER, type AgentRunInput, type AgentRunResult } from '../../agent/agent-runner';
import { agentFor } from '../../config/agents';
import { AppConfig } from '../../config/env';
import { conflict } from '../../history/command.repository';
import { VisitRepository } from '../../history/visit.repository';
import { agentStateDir } from '../../sandbox/sandbox-launch';
import { RunQueriesService } from '../../api/run-queries.service';
import { DocumentRepository } from '../../history/document.repository';
import { RunRepository } from '../../history/run.repository';
import { storedState, writeRunState } from '../../history/run-state';
import { CommandService } from '../../pipeline/command.service';
import { SubtaskPort } from '../../pipeline/subtask-port';
import { type TestApp } from '../../testing/test-app';

import { KEY, child, finish, pass, seedParent, task, tasksOf, work, world } from './split-implement.spec-helpers';

describe('subtask questions', () => {
  let app: TestApp;

  afterEach(async () => {
    jest.restoreAllMocks();
    await app.close();
  });

  /** A parent with a plan chat and subtasks that have run once; the planner's replies are scripted. */
  async function questionWorld(
    replies: (prompt: string) => { text: string; value?: Record<string, unknown>; exitCode?: number },
    seeded = [task('a'), task('b')],
  ) {
    const built = await world();
    app = built.app;
    const documents = app.app.get(DocumentRepository);
    const parent = await seedParent(app, seeded);
    await documents.putDocument(parent, 'contract', '- names are camelCase\n');
    await documents.putDocument(parent, 'repos', 'demo\n');
    const runtime = agentFor(app.app.get(AppConfig).env, parent, 'plan').runtime;
    mkdirSync(join(app.root, 'data'), { recursive: true });
    mkdirSync(agentStateDir(app.root, KEY, 'plan'), { recursive: true });
    writeFileSync(join(app.root, 'data', `${KEY}-plan-session.json`), JSON.stringify({ chatId: 'chat-1', runtime }));
    mkdirSync(join(app.root, 'worktrees', KEY, 'demo'), { recursive: true });
    const prompts: string[] = [];
    jest
      .spyOn(app.app.get<{ run: (input: AgentRunInput) => Promise<AgentRunResult> }>(AGENT_RUNNER), 'run')
      .mockImplementation((input) => {
        prompts.push(input.prompt);
        const { text, value, exitCode = 0 } = replies(input.prompt);
        return Promise.resolve({
          responseText: text || value ? resultAnswer('Done.', value ?? { decision: text }) : text,
          chatId: 'chat-1',
          tokensIn: 10,
          tokensOut: 5,
          usd: 0.5,
          killReason: null,
          exitCode,
          resumed: true,
          calls: 1,
          samples: [],
          durationMs: 1,
          startedAt: new Date(0).toISOString(),
          finishedAt: new Date(1).toISOString(),
        });
      });
    await pass(app);
    return { parent, prompts, documents };
  }

  /** The subtask run waits in research for its questions. */
  async function ask(id: string, questions: string, step = 'research'): Promise<void> {
    const run = await child(app, id);
    writeRunState(run, { status: 'waiting', currentStep: step });
    await storeRun(app.app.get(RunRepository), run);
    await app.app.get(DocumentRepository).putDocument(run, 'questions', questions);
  }

  it('answers a question from the plan chat of the parent, as a plan visit, and records it under decisions', async () => {
    const { prompts, documents, parent } = await questionWorld(() => ({ text: 'Use a column.' }));
    await ask('a', '- which field?\n');
    const before = await tasksOf(app);

    await pass(app);

    expect((await app.app.get(RunRepository).findRun(KEY))?.agentCalls).toBe(1);
    expect(prompts[0]).toContain('Subtask a asks:\n- which field?');
    expect(prompts[0]).toContain('names are camelCase');
    expect(await documents.latestBody(`${KEY}-a`, 'answers')).toBe('question: which field?\nanswer: Use a column.\n');
    expect(await documents.latestBody(KEY, 'contract')).toBe(
      '- names are camelCase\n\ndecisions:\n- subtask a at 2026-01-01T00:00:00.000Z: Use a column.\n',
    );
    expect(await tasksOf(app)).toEqual(before);
    const visits = await app.app.get(VisitRepository).listStats(parent.id);
    expect(visits.filter((visit) => visit.step === 'plan').map((visit) => visit.status)).toEqual(['done']);
    expect((await app.app.get(RunRepository).findRun(KEY))?.spentUsd).toBe(0.5);
  });

  it("answers a question again on a person's start of the parent's implement, and the door does not refuse it", async () => {
    const { prompts, documents } = await questionWorld(() => ({ text: 'Use a column.' }));
    await ask('a', '- which field?\n');
    await pass(app);
    expect(prompts).toHaveLength(1);
    await documents.putDocument(await child(app, 'a'), 'answers', '');
    await ask('a', '- which field?\n');

    await pass(app, { startBy: 'person' });

    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain('Subtask a asks:\n- which field?');
  });

  it('applies the actions of the answer: a task that has not started is changed with its reason, and the asking task goes on', async () => {
    const { prompts, documents } = await questionWorld(
      () => ({
        text: '',
        value: {
          decision: 'b takes the docs.',
          changeTask: [{ id: 'b', reason: 'a hands the docs over', description: 'Does b and the docs' }],
        },
      }),
      [task('a'), task('b', ['a'])],
    );
    await ask('a', '- who writes the docs?\n');

    await pass(app);

    expect(prompts[0]).toContain('- b (waiting): ');
    expect((await tasksOf(app)).find((item) => item.id === 'b')?.description).toBe('Does b and the docs');
    expect(await documents.latestBody(`${KEY}-a`, 'answers')).toBe(
      'question: who writes the docs?\nanswer: b takes the docs.\n',
    );
    expect(await documents.latestBody(KEY, 'contract')).toContain('b takes the docs.');
    for (const key of [KEY, `${KEY}-b`]) {
      expect(await documents.latestBody(key, 'plan_chat')).toContain('a hands the docs over');
    }
    const chat = JSON.parse((await documents.latestBody(KEY, 'plan_chat')) ?? '{}') as {
      entries: { kind: string; text: string }[];
    };
    expect(chat.entries.map((entry) => [entry.kind, entry.text])).toEqual([
      ['question', 'Subtask a asks: - who writes the docs?'],
      ['answer', 'b takes the docs.'],
    ]);
  });

  it('does not apply the change of a task that has started, and asks whoever started the run when the planner keeps it', async () => {
    let calls = 0;
    const { documents } = await questionWorld(() => {
      calls += 1;
      return { text: '', value: { decision: 'Use ids.', changeTask: [{ id: 'b', reason: 'x', title: 'New' }] } };
    });
    await ask('a', '- which?\n');

    await pass(app);

    expect(calls).toBeGreaterThan(1);
    expect(await documents.latestBody(KEY, 'subtask_questions')).toContain('Subtask a asks: - which?');
    expect(await documents.latestBody(`${KEY}-a`, 'answers')).toBeNull();
    expect((await tasksOf(app)).find((item) => item.id === 'b')?.title).not.toBe('New');
  });

  it('tells the subtask to decide itself, and leaves the contract alone, when the planner fails', async () => {
    const { documents, parent } = await questionWorld(() => ({ text: '', exitCode: 1 }));
    await ask('a', '- which field?\n');

    await pass(app);

    expect(await documents.latestBody(`${KEY}-a`, 'answers')).toBeNull();
    expect(await documents.latestBody(KEY, 'contract')).toBe('- names are camelCase\n');
    const visits = await app.app.get(VisitRepository).listStats(parent.id);
    expect(visits.filter((visit) => visit.step === 'plan').map((visit) => visit.status)).toEqual(['failed']);
    const view = await app.app.get(RunQueriesService).flow(KEY);
    expect(view.items).toHaveLength(1);
    expect(view.items[0].label).toMatch(/^Subtask a asks: - which field\?/);
    expect(view.state).toBe('waiting');
    expect(view.stateReason?.code).toBe('NEEDS_ANSWERS');
  });

  it('sends the answer of the person to a subtask waiting in research and records it under decisions', async () => {
    const { documents, parent } = await questionWorld(() => ({ text: '', exitCode: 1 }));
    await ask('a', '- which field?\n');
    await pass(app);
    const [question] = (await app.app.get(RunQueriesService).flow(KEY)).items;
    await documents.putDocument(parent, 'answers', `question: ${question.id}\nanswer: Use a column.\n`);

    await pass(app);

    expect(await documents.latestBody(`${KEY}-a`, 'answers')).toBe('question: which field?\nanswer: Use a column.\n');
    expect(await documents.latestBody(KEY, 'contract')).toContain(
      '- subtask a at 2026-01-01T00:00:00.000Z: Use a column.',
    );
    expect((await app.app.get(RunRepository).findRun(KEY))?.agentCalls).toBe(1);
    expect((await documents.latestBody(KEY, 'subtask_questions'))?.trim()).toBe('');
  });

  it('asks no one again while the question for the person is open', async () => {
    const { documents } = await questionWorld(() => ({ text: '', exitCode: 1 }));
    await ask('a', '- which field?\n');
    await pass(app);
    const asked = await documents.latestBody(KEY, 'subtask_questions');

    await pass(app);

    expect((await app.app.get(RunRepository).findRun(KEY))?.agentCalls).toBe(1);
    expect(await documents.latestBody(KEY, 'subtask_questions')).toBe(asked);
  });

  it('asks two questions that wait at once one after the other, in task order', async () => {
    const { prompts, documents } = await questionWorld((prompt) => ({
      text: prompt.includes('Subtask a') ? 'A.' : 'B.',
    }));
    await ask('b', '- second?\n');
    await ask('a', '- first?\n');

    await pass(app);
    expect((await app.app.get(RunRepository).findRun(KEY))?.agentCalls).toBe(1);
    expect(await documents.latestBody(`${KEY}-b`, 'answers')).toBeNull();

    await pass(app);
    expect((await app.app.get(RunRepository).findRun(KEY))?.agentCalls).toBe(2);
    expect(prompts[1]).toContain('Subtask b asks:');
    expect(await documents.latestBody(KEY, 'contract')).toContain(
      '- subtask a at 2026-01-01T00:00:00.000Z: A.\n- subtask b at 2026-01-01T00:00:00.000Z: B.',
    );
  });

  it('keeps the planner reply on the part, sends it again, and does not ask the planner again, when the part was held', async () => {
    const { documents, parent } = await questionWorld(() => ({ text: 'Use a column.' }));
    await ask('a', '- which field?\n');
    const commands = app.app.get(CommandService);
    const submit = commands.submit.bind(commands);
    const busy = conflict(
      'RUN_BUSY',
      `${KEY}-a is already running`,
      (await app.app.get(RunRepository).findRun(`${KEY}-a`))!,
    );
    jest.spyOn(commands, 'submit').mockRejectedValueOnce(busy).mockImplementation(submit);

    await pass(app);
    expect(await documents.latestBody(`${KEY}-a`, 'answers')).toBeNull();
    expect(await documents.latestBody(`${KEY}-a`, 'part_start')).toContain('"type":"answer"');

    await pass(app);
    expect(await documents.latestBody(`${KEY}-a`, 'part_start')).toBe('');
    expect((await app.app.get(RunRepository).findRun(KEY))?.agentCalls).toBe(1);
    expect(await documents.latestBody(`${KEY}-a`, 'answers')).toBe('question: which field?\nanswer: Use a column.\n');
    expect(await documents.latestBody(KEY, 'contract')).toContain(
      '- subtask a at 2026-01-01T00:00:00.000Z: Use a column.',
    );
    const visits = await app.app.get(VisitRepository).listStats(parent.id);
    expect(visits.filter((visit) => visit.step === 'plan')).toHaveLength(1);
  });

  it('does not touch a subtask that is already past plan', async () => {
    const { documents } = await questionWorld(() => ({ text: 'late' }));
    await ask('a', '- which field?\n', 'plan-improve');

    await pass(app);

    expect((await app.app.get(RunRepository).findRun(KEY))?.agentCalls).toBe(0);
    expect(await documents.latestBody(`${KEY}-a`, 'answers')).toBeNull();
    expect(await documents.latestBody(KEY, 'contract')).toBe('- names are camelCase\n');
  });

  it('leaves the parent as it was for a pass that finds nothing new, and records the fingerprint', async () => {
    const built = await world();
    app = built.app;
    await seedParent(app, [task('a')]);
    await pass(app);
    await work(app, 'a');
    const runs = app.app.get(RunRepository);
    const before = (await runs.findRun(KEY))!;
    const visits = (await app.app.get(VisitRepository).listStats(before.id)).length;

    await pass(app);

    const after = (await runs.findRun(KEY))!;
    expect(after.revision).toBe(before.revision);
    expect(storedState(after).reason).toEqual(storedState(before).reason);
    expect(await app.app.get(VisitRepository).listStats(after.id)).toHaveLength(visits);
    expect(after.subtaskFingerprint).toBe(await runs.subtaskFingerprint(after));
  });

  it('records what a pass saw, so a pass that starts a subtask is followed by one that sees the start', async () => {
    const built = await world();
    app = built.app;
    await seedParent(app, [task('a'), task('b', ['a'])]);
    const runs = app.app.get(RunRepository);
    const subtasks = app.app.get(SubtaskPort);

    await pass(app);
    let parent = (await runs.findRun(KEY))!;
    expect(parent.subtaskFingerprint).not.toBeNull();
    expect(await subtasks.subtasksChanged(parent)).toBe(true);
    expect(storedState(parent).reason?.message).not.toMatch(/\d{4}-\d{2}-\d{2}T/);

    await pass(app);
    parent = (await runs.findRun(KEY))!;
    expect(await subtasks.subtasksChanged(parent)).toBe(false);

    await finish(app, 'a');
    expect(await subtasks.subtasksChanged(parent)).toBe(true);
  });
});
