import 'reflect-metadata';
import { resultAnswer } from '../../testing/result-answer';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { AGENT_RUNNER, type AgentRunInput, type AgentRunResult } from '../../agent/agent-runner';
import { agentFor } from '../../config/agents';
import { AppConfig } from '../../config/env';
import { VisitRepository } from '../../history/visit.repository';
import { agentStateDir } from '../../sandbox/sandbox-launch';
import { RunQueriesService } from '../../api/run-queries.service';
import { DocumentRepository } from '../../history/document.repository';
import { RunRepository } from '../../history/run.repository';
import { deriveState, writeRunState } from '../../history/run-state';
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
  async function questionWorld(replies: (prompt: string) => { text: string; exitCode?: number }) {
    const built = await world();
    app = built.app;
    const documents = app.app.get(DocumentRepository);
    const parent = await seedParent(app, [task('a'), task('b')]);
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
        const { text, exitCode = 0 } = replies(input.prompt);
        return Promise.resolve({
          responseText: text ? resultAnswer('Done.', { answer: text }) : text,
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
    await app.app.get(RunRepository).saveRun(run);
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
      '- names are camelCase\n\ndecisions:\n- subtask a: Use a column.\n',
    );
    expect(await tasksOf(app)).toEqual(before);
    const visits = await app.app.get(VisitRepository).listStats(parent.id);
    expect(visits.filter((visit) => visit.step === 'plan').map((visit) => visit.status)).toEqual(['done']);
    expect((await app.app.get(RunRepository).findRun(KEY))?.spentUsd).toBe(0.5);
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
    expect(await documents.latestBody(KEY, 'contract')).toContain('- subtask a: Use a column.');
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
    expect(await documents.latestBody(KEY, 'contract')).toContain('- subtask a: A.\n- subtask b: B.');
  });

  it('sends the planner reply again, and does not ask the planner again, when the delivery was refused', async () => {
    const { documents, parent } = await questionWorld(() => ({ text: 'Use a column.' }));
    await ask('a', '- which field?\n');
    const commands = app.app.get(CommandService);
    const submit = commands.submit.bind(commands);
    jest.spyOn(commands, 'submit').mockRejectedValueOnce(new Error('refused')).mockImplementation(submit);

    await pass(app);
    expect(await documents.latestBody(`${KEY}-a`, 'answers')).toBeNull();
    expect(await documents.latestBody(KEY, 'contract')).toBe('- names are camelCase\n');

    await pass(app);
    expect((await app.app.get(RunRepository).findRun(KEY))?.agentCalls).toBe(1);
    expect(await documents.latestBody(`${KEY}-a`, 'answers')).toBe('question: which field?\nanswer: Use a column.\n');
    expect(await documents.latestBody(KEY, 'contract')).toContain('- subtask a: Use a column.');
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
    expect(deriveState(after).reason).toEqual(deriveState(before).reason);
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
    expect(deriveState(parent).reason?.message).not.toMatch(/\d{4}-\d{2}-\d{2}T/);

    await pass(app);
    parent = (await runs.findRun(KEY))!;
    expect(await subtasks.subtasksChanged(parent)).toBe(false);

    await finish(app, 'a');
    expect(await subtasks.subtasksChanged(parent)).toBe(true);
  });
});
