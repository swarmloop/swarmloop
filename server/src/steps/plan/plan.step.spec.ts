import { handoffText } from '../shared/handoff';
import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { EventEmitter } from 'events';
import { getRepositoryToken } from '@nestjs/typeorm';
import { mkdirSync, writeFileSync } from 'fs';
import { mkdtemp } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { PassThrough } from 'stream';
import type { Repository } from 'typeorm';
import { DocumentEntity } from '../../history/entities';
import { RunRepository } from '../../history/run.repository';
import { DocumentRepository } from '../../history/document.repository';
import { VisitRepository } from '../../history/visit.repository';
import type { AgentRunInput, AgentRunResult } from '../../agent/agent-runner';
import { PipelineService } from '../../pipeline/pipeline.service';
import { SwarmloopConfigModule } from '../../config/config.module';
import { PipelineModule } from '../../pipeline/pipeline.module';
import { SandboxService } from '../../sandbox/sandbox.service';
import { planContinue } from './plan.prompts';
import { RULES, runSplit, writeChat, type SplitOptions } from './plan.step.spec-helpers';
import { boot, planBlock, questionsBlock, result, seed, writeEnv } from './plan.step.spec-helpers';
import { SwarmloopError } from '../../core/swarmloop-error';
import { imageMissing, imageName } from '../../sandbox/image-resolver';

const REFUSED_WRITE = JSON.stringify({
  type: 'system',
  subtype: 'permission_denied',
  tool_name: 'Write',
  message: 'Cannot write to /work/billing-api/a.php while in plan mode.',
});

describe('plan step', () => {
  it('stores the checklist and advances to plan improve', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-plan-'));
    await writeEnv(root);
    mkdirSync(join(root, 'worktrees', 'PROJ-40', 'billing-api'), { recursive: true });
    mkdirSync(join(root, 'worktrees', 'PROJ-40', 'other'), { recursive: true });
    const agent = jest.fn().mockResolvedValue(result(planBlock(['add the field', 'cover the empty case'])));
    const app = await boot(root, agent);
    try {
      await seed(app, 'PROJ-40', '');
      const done = await app.get(PipelineService).step('plan', 'PROJ-40');
      expect(done.exitCode).toBe(0);
      const input = agent.mock.calls[0]?.[0] as AgentRunInput;
      expect(input.mode).toBe('plan');
      expect(input.prompt).toContain('Do not copy these stage-local limits into the implementation checklist');
      expect(input.prompt).not.toContain('Tests run only in the GitLab or GitHub pipeline');
      expect(input.model).toBe('opus-5.5-extra-high');
      expect(input.timeLimitMs).toBe(20 * 60 * 1000);
      expect(input.mounts.map((mount) => mount.containerPath)).toEqual(['/work/billing-api']);
      expect(input.prompt).toContain('The only working directory is /work/billing-api (billing-api).');
      expect(input.prompt).toContain('Do not look outside it.');
      const documents = app.get<Repository<DocumentEntity>>(getRepositoryToken(DocumentEntity));
      const stored = await documents.find({ where: { kind: 'requirements' }, order: { id: 'DESC' } });
      expect(JSON.parse(stored[0]?.body ?? '{}').plan).toEqual({
        name: '',
        overview: '',
        items: ['add the field', 'cover the empty case'],
        decision: null,
      });
      const run = await app.get(RunRepository).findRun('PROJ-40');
      expect(run?.currentStep).toBe('plan-improve');
      expect(run?.status).toBe('waiting');
      await app.get(PipelineService).step('plan', 'PROJ-40');
      expect(await documents.find({ where: { kind: 'requirements' } })).toHaveLength(stored.length);
      expect((await app.get(RunRepository).findRun('PROJ-40'))?.currentStep).toBe('plan-improve');
    } finally {
      await app.close();
    }
  });

  it('adds the parent contract to the prompt of a subtask only', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-plan-contract-'));
    await writeEnv(root);
    mkdirSync(join(root, 'worktrees', 'PROJ-45-t1', 'billing-api'), { recursive: true });
    mkdirSync(join(root, 'worktrees', 'PROJ-46', 'billing-api'), { recursive: true });
    const agent = jest.fn().mockResolvedValue(result(planBlock(['add the field'])));
    const app = await boot(root, agent);
    try {
      const runs = app.get(RunRepository);
      const parent = await runs.openWaiting('PROJ-45', '/target');
      await app.get(DocumentRepository).putDocument(parent, 'contract', '- decided: the field is a column\n');
      await seed(app, 'PROJ-45-t1', '');
      const child = await runs.findRun('PROJ-45-t1');
      await runs.saveRun({ ...child!, parentRunId: parent.id, taskId: 't1' });
      await seed(app, 'PROJ-46', '');

      await app.get(PipelineService).step('plan', 'PROJ-45-t1');
      await app.get(PipelineService).step('plan', 'PROJ-46');

      expect((agent.mock.calls[0]?.[0] as AgentRunInput).prompt).toContain('the field is a column');
      expect((agent.mock.calls[1]?.[0] as AgentRunInput).prompt).not.toContain('Contract');
    } finally {
      await app.close();
    }
  });

  it('decides its own questions as assumptions when the run is a subtask, and still waits when it is not', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-plan-subtask-asks-'));
    await writeEnv(root);
    mkdirSync(join(root, 'worktrees', 'PROJ-47-t1', 'billing-api'), { recursive: true });
    mkdirSync(join(root, 'worktrees', 'PROJ-48', 'billing-api'), { recursive: true });
    const agent = jest
      .fn()
      .mockResolvedValueOnce(result(questionsBlock(['which column type?'])))
      .mockResolvedValueOnce(result(planBlock(['add the field'])))
      .mockResolvedValueOnce(result(questionsBlock(['which column type?'])));
    const app = await boot(root, agent);
    try {
      const runs = app.get(RunRepository);
      const parent = await runs.openWaiting('PROJ-47', '/target');
      await seed(app, 'PROJ-47-t1', '');
      await runs.saveRun({ ...(await runs.findRun('PROJ-47-t1'))!, parentRunId: parent.id, taskId: 't1' });
      await seed(app, 'PROJ-48', '');

      await app.get(PipelineService).step('plan', 'PROJ-47-t1');
      const child = await runs.findRun('PROJ-47-t1');
      expect(child?.currentStep).toBe('plan-improve');
      expect(await app.get(DocumentRepository).latestBody('PROJ-47-t1', 'questions')).toBeFalsy();
      expect(handoffText(await app.get(DocumentRepository).latestBody('PROJ-47-t1', 'handoff'))).toContain(
        '- assumed: which column type?',
      );

      await app.get(PipelineService).step('plan', 'PROJ-48');
      const other = await runs.findRun('PROJ-48');
      expect(other?.currentStep).toBe('plan');
      expect(other?.status).toBe('waiting');
      expect(await app.get(DocumentRepository).latestBody('PROJ-48', 'questions')).toContain('which column type?');
    } finally {
      await app.close();
    }
  });

  it('continues the plan chat with a short prompt', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-plan-resume-'));
    await writeEnv(root);
    mkdirSync(join(root, 'worktrees', 'PROJ-45', 'billing-api'), { recursive: true });
    mkdirSync(join(root, 'data'), { recursive: true });
    mkdirSync(join(root, 'data', 'agent-state', 'PROJ-45', 'plan'), { recursive: true });
    writeFileSync(
      join(root, 'data', 'PROJ-45-plan-session.json'),
      `${JSON.stringify({ runtime: 'cursor', chatId: 'chat-1', resumed: true, completed: true, killReason: null, usd: 2 })}\n`,
    );
    const agent = jest.fn().mockResolvedValue(result(planBlock(['add the field'])));
    const app = await boot(root, agent);
    try {
      await seed(app, 'PROJ-45', '');
      await storePlanVisit(app, 'PROJ-45');
      const done = await app.get(PipelineService).step('plan', 'PROJ-45');
      expect(done.exitCode).toBe(0);
      const input = agent.mock.calls[0]?.[0] as AgentRunInput;
      expect(input.resumeChatId).toBe('chat-1');
      expect(input.prompt).toContain('Do not copy these stage-local limits into the implementation checklist');
      expect(input.prompt).not.toContain('Tests run only in the GitLab or GitHub pipeline');
      expect(input.groupUsd).toBe(2);
      expect(input.prompt).toContain('The requirements in this message are the whole task');
      expect(input.prompt).not.toContain('# Plan');
      expect(input.prompt).not.toContain('ship the field');
      expect(input.prompt).not.toContain('What previous steps did');
    } finally {
      await app.close();
    }
  });

  describe('first visit in the research chat', () => {
    const stepFirst = async (key: string, options: SplitOptions = {}) =>
      (await runSplit(key, planBlock(['add the field']), { ...options, chat: true })).input;

    it('sends the plan skill with Split on the first visit in the research chat', async () => {
      const input = await stepFirst('PROJ-60');
      expect(input.resumeChatId).toBe('chat-1');
      expect(input.prompt).toContain('# Plan');
      expect(input.prompt).toContain('## Split');
      expect(input.prompt).not.toContain('The requirements in this message are the whole task');
    });

    it('sends the plan skill without Split on the first visit of a run that may not split', async () => {
      const input = await stepFirst('PROJ-61', { split: false });
      expect(input.resumeChatId).toBe('chat-1');
      expect(input.prompt).toContain('# Plan');
      expect(input.prompt).not.toContain('## Split');
    });

    it('asks a runtime without a plan tool for the checklist in the answer', async () => {
      const input = await stepFirst('PROJ-63', { runtime: 'claude' });
      expect(input.prompt).toContain('End your final message with exactly one result block');
      expect(input.prompt).not.toContain('plan tool');
    });

    it('adds no project rules to the research chat of the same runtime', async () => {
      const input = (await runSplit('PROJ-63', planBlock(['x']), { chat: true, rules: RULES('claude') })).input;
      expect(input.resumeChatId).toBe('chat-1');
      expect(input.prompt).not.toContain('Project rules');
    });

    it('opens a new chat with the project rules when the stored chat belongs to another runtime', async () => {
      const input = (await runSplit('PROJ-64', planBlock(['x']), { chat: true, rules: RULES('cursor') })).input;
      expect(input.resumeChatId).toBeNull();
      expect(input.prompt).toContain('Project rules (billing-api):\nKeep it small.\n\nRequirements:');
    });

    it('sends a subtask the plan skill without Split on its first visit', async () => {
      const input = await stepFirst('PROJ-62-t1', { subtask: true });
      expect(input.prompt).toContain('# Plan');
      expect(input.prompt).not.toContain('## Split');
    });
  });

  it('continues with the follow-up after answers', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-plan-answers-'));
    await writeEnv(root);
    mkdirSync(join(root, 'worktrees', 'PROJ-63', 'billing-api'), { recursive: true });
    writeChat(root, 'PROJ-63');
    const agent = jest
      .fn()
      .mockResolvedValueOnce(result(questionsBlock(['which column type?'])))
      .mockResolvedValue(result(planBlock(['add the field'])));
    const app = await boot(root, agent);
    try {
      await seed(app, 'PROJ-63', '');
      await app.get(PipelineService).step('plan', 'PROJ-63');
      const run = await app.get(RunRepository).findRun('PROJ-63');
      await app.get(DocumentRepository).putDocument(run!, 'answers', 'question: which column type?\nanswer: text\n');
      await app.get(PipelineService).step('plan', 'PROJ-63');
      const [first, second] = agent.mock.calls.map((call) => (call[0] as AgentRunInput).prompt);
      expect(first).toContain('# Plan');
      expect(second).toContain('The requirements in this message are the whole task');
      expect(second).toContain('answer: text');
      expect(second).not.toContain('# Plan');
    } finally {
      await app.close();
    }
  });

  it('continues with the follow-up when the plan step is replayed after a finished visit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-plan-replay-'));
    await writeEnv(root);
    mkdirSync(join(root, 'worktrees', 'PROJ-64', 'billing-api'), { recursive: true });
    writeChat(root, 'PROJ-64');
    const agent = jest.fn().mockResolvedValue(result(planBlock(['add the field'])));
    const app = await boot(root, agent);
    try {
      await seed(app, 'PROJ-64', '');
      await storePlanVisit(app, 'PROJ-64');
      await app.get(PipelineService).step('plan', 'PROJ-64');
      const { prompt } = agent.mock.calls[0]?.[0] as AgentRunInput;
      expect(prompt).toContain('The requirements in this message are the whole task');
      expect(prompt).not.toContain('# Plan');
    } finally {
      await app.close();
    }
  });

  it('mounts the stored project when the run is resumed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-plan-stored-'));
    await writeEnv(root);
    mkdirSync(join(root, 'worktrees', 'PROJ-44', 'app'), { recursive: true });
    const agent = jest.fn().mockResolvedValue(result(planBlock(['add the field'])));
    const app = await boot(root, agent);
    try {
      await seed(app, 'PROJ-44', '');
      const runs = app.get(RunRepository);
      const documents = app.get(DocumentRepository);
      const run = await runs.findRun('PROJ-44');
      if (!run) {
        throw new Error('run is missing');
      }
      run.projects = 'app\n';
      await runs.saveRun(run);
      await documents.putDocument(run, 'repos', 'app\n');
      const done = await app.get(PipelineService).step('plan', 'PROJ-44');
      expect(done.exitCode).toBe(0);
      const input = agent.mock.calls[0]?.[0] as AgentRunInput;
      expect(input.mounts).toEqual([
        { hostPath: join(root, 'worktrees', 'PROJ-44', 'app'), containerPath: '/work/app' },
      ]);
    } finally {
      await app.close();
    }
  });

  it('tells the first prompt the line count of a file the task names, and nothing when it names none', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-plan-lines-'));
    await writeEnv(root);
    mkdirSync(join(root, 'worktrees', 'PROJ-49', 'billing-api'), { recursive: true });
    writeFileSync(join(root, 'worktrees', 'PROJ-49', 'billing-api', 'core.ts'), 'a\nb\nc\n');
    mkdirSync(join(root, 'worktrees', 'PROJ-50', 'billing-api'), { recursive: true });
    const agent = jest.fn().mockResolvedValue(result(planBlock(['add the field'])));
    const app = await boot(root, agent);
    try {
      await seed(app, 'PROJ-49', '');
      await putImpact(app, 'PROJ-49', '- core.ts: the field is read here\n');
      await seed(app, 'PROJ-50', '');
      await app.get(PipelineService).step('plan', 'PROJ-49');
      await app.get(PipelineService).step('plan', 'PROJ-50');
      expect((agent.mock.calls[0]?.[0] as AgentRunInput).prompt).toContain('core.ts: 3 lines');
      expect((agent.mock.calls[1]?.[0] as AgentRunInput).prompt).not.toContain(' lines\n');
      expect((agent.mock.calls[1]?.[0] as AgentRunInput).prompt).not.toContain('Named files');
    } finally {
      await app.close();
    }
  });

  it('does not start the agent while questions are open', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-plan-questions-'));
    await writeEnv(root);
    const agent = jest.fn();
    const app = await boot(root, agent);
    try {
      await seed(app, 'PROJ-41', '- which field?\n');
      const result = await app.get(PipelineService).step('plan', 'PROJ-41');
      expect(result.exitCode).toBe(0);
      expect(result.message).toContain('questions are open');
      expect(agent).not.toHaveBeenCalled();
      const run = await app.get(RunRepository).findRun('PROJ-41');
      expect(run?.currentStep).toBe('plan');
      expect(run?.status).toBe('waiting');
    } finally {
      await app.close();
    }
  });

  it('puts the Impact section in the full and the follow-up prompt, and leaves it out when the list is empty', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-plan-impact-'));
    await writeEnv(root);
    mkdirSync(join(root, 'worktrees', 'PROJ-46', 'billing-api'), { recursive: true });
    mkdirSync(join(root, 'worktrees', 'PROJ-47', 'billing-api'), { recursive: true });
    mkdirSync(join(root, 'data'), { recursive: true });
    mkdirSync(join(root, 'data', 'agent-state', 'PROJ-47', 'plan'), { recursive: true });
    writeFileSync(
      join(root, 'data', 'PROJ-47-plan-session.json'),
      `${JSON.stringify({ runtime: 'cursor', chatId: 'chat-1', resumed: true, completed: true, killReason: null, usd: 0 })}\n`,
    );
    const agent = jest.fn().mockResolvedValue(result(planBlock(['add the field'])));
    const app = await boot(root, agent);
    try {
      await seed(app, 'PROJ-46', '');
      await seed(app, 'PROJ-47', '');
      await storePlanVisit(app, 'PROJ-47');
      await putImpact(app, 'PROJ-47', '- live agent log | step-documents.tsx | kept\n');
      await app.get(PipelineService).step('plan', 'PROJ-46');
      await app.get(PipelineService).step('plan', 'PROJ-47');
      const [plain, resumed] = agent.mock.calls.map((call) => (call[0] as AgentRunInput).prompt);
      expect(plain).not.toContain('\nImpact:\n');
      expect(resumed).toContain('The requirements in this message are the whole task');
      expect(resumed).toContain('\nImpact:\n- live agent log | step-documents.tsx | kept');
    } finally {
      await app.close();
    }
  });

  it('puts the Impact section in the full prompt', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-plan-impact-full-'));
    await writeEnv(root);
    mkdirSync(join(root, 'worktrees', 'PROJ-48', 'billing-api'), { recursive: true });
    const agent = jest.fn().mockResolvedValue(result(planBlock(['add the field'])));
    const app = await boot(root, agent);
    try {
      await seed(app, 'PROJ-48', '');
      await putImpact(app, 'PROJ-48', '- live agent log | step-documents.tsx | kept\n');
      await app.get(PipelineService).step('plan', 'PROJ-48');
      expect((agent.mock.calls[0]?.[0] as AgentRunInput).prompt).toContain(
        '\nImpact:\n- live agent log | step-documents.tsx | kept',
      );
    } finally {
      await app.close();
    }
  });

  it('waits and writes the questions document when the answer has questions and no plan', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-plan-ask-'));
    await writeEnv(root);
    mkdirSync(join(root, 'worktrees', 'PROJ-49', 'billing-api'), { recursive: true });
    const ask = 'This change makes the live agent log unreachable. Is that intended?';
    const agent = jest
      .fn()
      .mockResolvedValueOnce(result(questionsBlock([ask])))
      .mockResolvedValue(result(planBlock(['add the field'])));
    const app = await boot(root, agent);
    try {
      await seed(app, 'PROJ-49', '');
      const waiting = await app.get(PipelineService).step('plan', 'PROJ-49');
      expect(waiting.message).toContain(ask);
      const run = await app.get(RunRepository).findRun('PROJ-49');
      expect(run?.currentStep).toBe('plan');
      expect(run?.status).toBe('waiting');
      const documents = app.get(DocumentRepository);
      expect(await documents.latestBody('PROJ-49', 'questions')).toBe(`- ${ask}\n`);

      await documents.putDocument(run!, 'answers', `question: ${ask}\nanswer: yes\n`);
      await app.get(PipelineService).step('plan', 'PROJ-49');
      expect(agent).toHaveBeenCalledTimes(2);
      expect((await app.get(RunRepository).findRun('PROJ-49'))?.currentStep).toBe('plan-improve');
    } finally {
      await app.close();
    }
  });

  it('fails when the checklist is empty', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-plan-empty-'));
    await writeEnv(root);
    mkdirSync(join(root, 'worktrees', 'PROJ-42', 'billing-api'), { recursive: true });
    const agent = jest.fn().mockResolvedValue(result(planBlock([])));
    const app = await boot(root, agent);
    try {
      await seed(app, 'PROJ-42', '');
      const result = await app.get(PipelineService).step('plan', 'PROJ-42');
      expect(result.exitCode).toBe(1);
      expect(result.message).toContain('exactly one of plan, questions and tasks must be filled in');
      expect((await app.get(RunRepository).findRun('PROJ-42'))?.currentStep).toBe('plan');
      expect((await app.get(RunRepository).findRun('PROJ-42'))?.status).toBe('failed');
    } finally {
      await app.close();
    }
  });

  it('keeps a valid plan after a write was refused in plan mode', async () => {
    const answer = planBlock(['add the field', 'cover the empty case']);
    const clean = await planOutcome(result(answer));
    const refused = await planOutcome({ ...result(answer), output: REFUSED_WRITE });
    expect(clean.exitCode).toBe(0);
    expect(refused.exitCode).toBe(0);
    expect(refused.documents).toEqual(clean.documents);
  });

  it('names the refused write when a write was refused and the answer has no plan', async () => {
    const outcome = await planOutcome({ ...result('the file is written'), output: REFUSED_WRITE });
    expect(outcome.exitCode).toBe(1);
    expect(outcome.message).toContain('the answer has no result block');
    expect(outcome.message).toContain('a write was refused: Cannot write to /work/billing-api/a.php');
  });

  it('stops before the agent when the sandbox cannot start', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-plan-sandbox-'));
    await writeEnv(root);
    const agent = jest.fn();
    const app = await boot(root, agent, new SwarmloopError('docker is not running'));
    try {
      await seed(app, 'PROJ-43', '');
      const result = await app.get(PipelineService).step('plan', 'PROJ-43');
      expect(result.exitCode).toBe(1);
      expect(result.message).toContain('docker is not running');
      expect(agent).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('blocks the run with the image code and keeps its attempts when the agent image is missing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-plan-images-'));
    await writeEnv(root);
    const agent = jest.fn();
    const refused = imageMissing(imageName('agent-cursor'));
    const app = await boot(root, agent, refused);
    try {
      await seed(app, 'PROJ-44', '');
      const result = await app.get(PipelineService).step('plan', 'PROJ-44');
      const run = await app.get(RunRepository).findRun('PROJ-44');
      expect(result.exitCode).toBe(1);
      expect(run?.status).toBe('blocked');
      expect(JSON.parse(run?.stateReason ?? '{}').code).toBe('IMAGE_MISSING');
      expect([run?.attemptsReview, run?.attemptsQa, run?.attemptsPipeline, run?.agentCalls]).toEqual([0, 0, 0, 0]);
      expect(agent).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('finishes one plan visit after a time kill', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-plan-time-'));
    await writeEnv(root, 0);
    mkdirSync(join(root, 'worktrees', 'PROJ-146', 'billing-api'), { recursive: true });
    const answer = planBlock(['add the field'], { summary: ['covers the empty case'] });
    const spawn = scripted([chatStream('plan-chat', 'partial'), doneStream(answer)]);
    const app = await bootLive(root, spawn);
    try {
      await seed(app, 'PROJ-146', '');
      const done = await app.get(PipelineService).step('plan', 'PROJ-146');
      expect(done.exitCode).toBe(0);
      expect(spawn).toHaveBeenCalledTimes(2);
      expect(launchedPrompt(spawn.mock.calls[1])).toBe(planContinue());
      expect(resumeArg(spawn.mock.calls[1])).toBe('plan-chat');
      const runs = app.get(RunRepository);
      const visitRepository = app.get(VisitRepository);
      const run = await runs.findRun('PROJ-146');
      expect(run?.currentStep).toBe('plan-improve');
      expect(run?.agentCalls).toBe(2);
      const stats = await visitRepository.listStats(run?.id ?? 0);
      const visits = stats.filter((item) => item.step === 'plan');
      expect(visits).toHaveLength(1);
      expect(visits[0]?.status).toBe('done');
      expect(visits[0]?.killReason ?? null).toBeNull();
      const documents = app.get<Repository<DocumentEntity>>(getRepositoryToken(DocumentEntity));
      const stored = await documents.find({ where: { kind: 'requirements' }, order: { id: 'DESC' } });
      expect(JSON.parse(stored[0]?.body ?? '{}').plan.items).toEqual(['add the field']);
    } finally {
      await app.close();
    }
  });
});

async function planOutcome(answer: AgentRunResult) {
  const root = await mkdtemp(join(tmpdir(), 'swarmloop-plan-refusal-'));
  await writeEnv(root);
  mkdirSync(join(root, 'worktrees', 'PROJ-44', 'billing-api'), { recursive: true });
  const app = await boot(root, jest.fn().mockResolvedValue(answer));
  try {
    await seed(app, 'PROJ-44', '');
    const done = await app.get(PipelineService).step('plan', 'PROJ-44');
    const documents = app.get<Repository<DocumentEntity>>(getRepositoryToken(DocumentEntity));
    const bodies = async (kind: string) => (await documents.find({ where: { kind } })).map((item) => item.body);
    return {
      exitCode: done.exitCode,
      message: done.message,
      documents: { requirements: await bodies('requirements'), handoff: await bodies('handoff') },
    };
  } finally {
    await app.close();
  }
}

/** One finished plan visit with an agent exchange, as an earlier plan visit of the run leaves it. */
async function storePlanVisit(app: Awaited<ReturnType<typeof boot>>, key: string): Promise<void> {
  const run = (await app.get(RunRepository).findRun(key))!;
  const at = new Date().toISOString();
  await app.get(VisitRepository).finishVisit(run, {
    step: 'plan',
    runtime: 'cursor',
    model: 'opus-5.5-extra-high',
    mode: 'plan',
    startedAt: at,
    finishedAt: at,
    durationMs: 5,
    status: 'done',
    exitCode: 0,
    killReason: null,
    tokensIn: 10,
    tokensOut: 4,
    usd: 0.01,
    samples: [],
    exchange: {
      model: 'opus-5.5-extra-high',
      startedAt: at,
      finishedAt: at,
      durationMs: 5,
      requestText: 'plan',
      responseText: planBlock(['add the field']),
      chatId: 'chat-1',
      resumed: false,
      killReason: null,
    },
    httpCalls: [],
    document: null,
    resumed: false,
  });
}

async function putImpact(app: Awaited<ReturnType<typeof boot>>, key: string, body: string): Promise<void> {
  const run = await app.get(RunRepository).findRun(key);
  await app.get(DocumentRepository).putDocument(run!, 'impact', body);
}

async function bootLive(root: string, spawn: jest.Mock): ReturnType<typeof boot> {
  mkdirSync(join(root, 'data'), { recursive: true });
  writeFileSync(
    join(root, 'data', 'price-cache-cursor.json'),
    `${JSON.stringify({ fetchedAt: new Date().toISOString(), prices: {} })}\n`,
  );
  return Test.createTestingModule({
    imports: [SwarmloopConfigModule.forRoot(join(root, '.env')), PipelineModule],
  })
    .overrideProvider(SandboxService)
    .useValue({
      assertReady: jest.fn().mockResolvedValue(undefined),
      spawn,
      stats: jest.fn().mockResolvedValue({ cpuPercent: 0, rssBytes: 0 }),
      kill: jest.fn().mockResolvedValue(undefined),
    })
    .compile();
}

function scripted(chunks: string[]): jest.Mock {
  const pending = [...chunks];
  return jest.fn(async () => {
    const next = pending.shift();
    if (!next) {
      throw new Error('unexpected spawn');
    }
    return fakeChild([next], 0);
  });
}

function launchedPrompt(call: unknown[] | undefined): string {
  const command = (call?.[0] as { command?: string[] } | undefined)?.command ?? [];
  return command[command.length - 1] ?? '';
}

function resumeArg(call: unknown[] | undefined): string | null {
  const command = (call?.[0] as { command?: string[] } | undefined)?.command ?? [];
  const at = command.indexOf('--resume');
  return at < 0 ? null : (command[at + 1] ?? null);
}

function chatStream(chatId: string, note?: string): string {
  const noteLine = note ? `${JSON.stringify({ type: 'thinking', text: note })}\n` : '';
  return `${noteLine}${JSON.stringify({ session_id: chatId })}\n`;
}

function doneStream(text: string): string {
  return `${JSON.stringify({ type: 'result', result: text })}\n`;
}

function fakeChild(chunks: string[], code: number): EventEmitter {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const child = new EventEmitter();
  for (const chunk of chunks) {
    stdout.write(chunk);
  }
  const on = child.on.bind(child);
  child.on = ((event: string | symbol, listener: (...args: unknown[]) => void) => {
    const returned = on(event, listener);
    if (event === 'close') {
      setImmediate(() => child.emit('close', code));
    }
    return returned;
  }) as typeof child.on;
  return Object.assign(child, { stdout, stderr, containerName: 'box', kill: () => true });
}
