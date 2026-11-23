import { mkdir, mkdtemp, readFile, writeFile } from 'fs/promises';
import { RunStop } from '../agent/run-stop';
import { tmpdir } from 'os';
import { join } from 'path';
import { AppConfig } from '../config/env';
import { testEnv } from '../config/env.spec-helpers';
import { FakeClock } from '../core/fake-clock.spec-helpers';
import { BadRequestException, ConflictException } from '@nestjs/common';
import type { AgentRunInput, AgentRunResult } from '../agent/agent-runner';
import { AgentDoor } from '../steps/shared/agent-door';
import { AgentLauncher } from '../steps/shared/agent-launcher';
import { WRITE_REFUSAL } from '../steps/shared/start-refused';
import { REASON } from '../contract/run-state';
import { stateColumns, storedState } from '../history/run-state';
import { ChatService } from './chat.service';

/** The door around a launcher. The refusal of write tools needs nothing of the door's repositories. */
function doorOf(launcher: AgentLauncher): AgentDoor {
  const none = {} as never;
  return new AgentDoor(launcher, none, none, none, none, none, none, none, none);
}

describe('chat', () => {
  it('uses the implement model from the environment and removes the mcp file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sloop-chat-'));
    const project = join(root, 'project');
    await mkdir(join(root, 'skills', 'research'), { recursive: true });
    await mkdir(project, { recursive: true });
    await writeFile(join(root, 'skills', 'research', 'SKILL.md'), '# Research\n\nRead the ticket.\n');
    const run = {
      id: 4,
      key: 'PROJ-1',
      status: 'waiting',
      currentStep: 'plan',
      ownerPid: null,
      agentCalls: 1,
      spentUsd: 0.2,
      targetPath: null,
    };
    const saved: unknown[] = [];
    const documents: string[] = [];
    const runRepository = {
      findRun: async () => run,
      held: () => false,
      claim: async () => {
        Object.assign(run, { status: 'running', ownerPid: process.pid });
        saved.push({ ...run });
        return run;
      },
      release: async (value: typeof run, change: { status: string; ownerPid: number | null }) => {
        Object.assign(value, { status: change.status, ownerPid: change.ownerPid });
        saved.push({ ...value });
        return value;
      },
    };
    const documentRepository = {
      latestBody: async (_key: string, kind: string) => (kind === 'requirements' ? 'Add the field' : null),
      putDocument: async (_run: unknown, kind: string, body: string) => {
        documents.push(`${kind}:${body}`);
      },
    };
    const visitRepository = { tokenTotal: async () => 3 };
    const agent = jest.fn(async (input: AgentRunInput): Promise<AgentRunResult> => result(input.prompt));
    const chat = new ChatService(
      runRepository as never,
      documentRepository as never,
      config(root),
      new FakeClock(),
      { assertReady: async () => undefined } as never,
      doorOf(new AgentLauncher({ run: agent } as never, visitRepository as never, new RunStop())),
      { block: async () => 'Services:\nJira PROJ-1: Ship the field' } as never,
      { ensureForRequest: async () => undefined } as never,
    );
    await expect(
      chat.speak('PROJ-1', {
        prompt: 'what is open?',
        skill: 'research',
        cwd: project,
        mcpServers: [{ name: 'idea', command: 'idea-mcp', args: [], env: [{ name: 'TOKEN', value: 'secret-value' }] }],
      }),
    ).rejects.toThrow(new BadRequestException(WRITE_REFUSAL));
    expect(agent).not.toHaveBeenCalled();
    expect(run.status).toBe('waiting');
    expect(run.spentUsd).toBeCloseTo(0.2);
    await expect(readFile(join(project, '.cursor', 'mcp.json'), 'utf8')).rejects.toThrow();
    expect(saved.map((row) => (row as { status: string }).status)).toEqual(['running', 'waiting']);
    expect(documents.some((row) => row.startsWith(`chat_lock:waiting ${process.pid}`))).toBe(true);
    expect(documents.some((row) => row.startsWith('chat_lock:clear'))).toBe(true);
  });

  it('puts a stopped run back stopped with Resume after a chat', async () => {
    const stopped = { code: REASON.stopped, message: 'stopped by a person' };
    const run = {
      id: 5,
      key: 'PROJ-2',
      status: 'blocked',
      currentStep: 'plan',
      ownerPid: null,
      ownerInstance: null,
      activeAttempt: null,
      targetPath: null,
      state: 'stopped',
      stateReason: JSON.stringify(stopped),
    };
    const before = storedState(run);
    expect(before.reason?.code).toBe(REASON.stopped);
    const runRepository = {
      findRun: async () => run,
      held: () => false,
      claim: async () => {
        Object.assign(run, stateColumns(run, { status: 'running', ownerPid: process.pid }));
        return run;
      },
      release: async (value: typeof run, change: Parameters<typeof stateColumns>[1]) => {
        Object.assign(value, stateColumns(value, { ...change, activeAttempt: null }));
        return value;
      },
    };
    const root = await mkdtemp(join(tmpdir(), 'sloop-chat-'));
    const project = join(root, 'project');
    await mkdir(project, { recursive: true });
    const chat = new ChatService(
      runRepository as never,
      { latestBody: async () => null, putDocument: async () => undefined } as never,
      config(root),
      new FakeClock(),
      { assertReady: async () => undefined } as never,
      doorOf(
        new AgentLauncher(
          { run: async (input: AgentRunInput) => result(input.prompt) } as never,
          { tokenTotal: async () => 1 } as never,
          new RunStop(),
        ),
      ),
      { block: async () => '' } as never,
      { ensureForRequest: async () => undefined } as never,
    );
    await expect(chat.speak('PROJ-2', { prompt: 'look at it', cwd: project })).rejects.toThrow(WRITE_REFUSAL);
    expect(run.status).toBe('blocked');
    expect(storedState(run)).toEqual(before);
  });

  it('refuses a chat while the feature is running', async () => {
    const runRepository = {
      findRun: async () => ({ key: 'PROJ-1', status: 'running', ownerPid: process.pid }),
      held: () => true,
    };
    const documentRepository = { latestBody: async () => null };
    const chat = new ChatService(
      runRepository as never,
      documentRepository as never,
      config('/tmp'),
      new FakeClock(),
      { assertReady: async () => undefined } as never,
      doorOf(new AgentLauncher({ run: jest.fn() } as never, {} as never, new RunStop())),
      {
        block: async () => '',
      } as never,
      { ensureForRequest: async () => undefined } as never,
    );
    await expect(chat.speak('PROJ-1', { prompt: 'hello' })).rejects.toBeInstanceOf(ConflictException);
  });

  it('refuses an empty prompt', async () => {
    const runRepository = {
      findRun: async () => ({ key: 'PROJ-1', status: 'waiting' }),
      held: () => false,
    };
    const documentRepository = { latestBody: async () => null };
    const chat = new ChatService(
      runRepository as never,
      documentRepository as never,
      config('/tmp'),
      new FakeClock(),
      { assertReady: async () => undefined } as never,
      doorOf(new AgentLauncher({ run: jest.fn() } as never, {} as never, new RunStop())),
      {
        block: async () => '',
      } as never,
      { ensureForRequest: async () => undefined } as never,
    );
    await expect(chat.speak('PROJ-1', { prompt: '  ' })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('refuses a chat when the stored implement agent has no model', async () => {
    const runRepository = {
      findRun: async () => ({
        key: 'PROJ-1',
        status: 'waiting',
        agents: { main: { implement: [{ runtime: 'cursor', model: '' }] } },
      }),
      held: () => false,
    };
    const documentRepository = { latestBody: async () => null };
    const chat = new ChatService(
      runRepository as never,
      documentRepository as never,
      config('/tmp'),
      new FakeClock(),
      { assertReady: async () => undefined } as never,
      doorOf(new AgentLauncher({ run: jest.fn() } as never, {} as never, new RunStop())),
      {
        block: async () => '',
      } as never,
      { ensureForRequest: async () => undefined } as never,
    );
    await expect(chat.speak('PROJ-1', { prompt: 'hello' })).rejects.toThrow('AGENTS_IMPLEMENT is missing');
  });
});

function config(root: string): AppConfig {
  return new AppConfig(
    testEnv({
      SWARMLOOP_ROOT: root,
      REQUIREMENTS_VIA: 'direct',
      CURSOR_API_KEY: '',
      MAX_AGENT_CALLS: 20,
      MAX_RUN_USD: 25,
      IDLE_TIMEOUT_MS: 1000,
      TICK_MS: 1000,
      REQUIREMENTS_TIMEOUT_MS: 1000,
      RESEARCH_TIMEOUT_MS: 1000,
      PLAN_TIMEOUT_MS: 1000,
      IMPLEMENT_TIMEOUT_MS: 5000,
      CODE_REVIEW_TIMEOUT_MS: 1000,
      MERGE_REQUEST_TIMEOUT_MS: 1000,
      PIPELINE_TIMEOUT_MS: 1000,
      AGENTS_PLAN: 'cursor:plan-model',
      AGENTS_IMPLEMENT: 'cursor:implement-model',
      AGENTS_REVIEW: 'cursor:plan-model',
    }),
  );
}

function result(prompt: string): AgentRunResult {
  const now = new Date().toISOString();
  return {
    responseText: 'answered',
    chatId: null,
    tokensIn: 2,
    tokensOut: 1,
    usd: 0.01,
    killReason: null,
    exitCode: 0,
    output: prompt,
    resumed: false,
    calls: 1,
    samples: [],
    durationMs: 5,
    startedAt: now,
    finishedAt: now,
  };
}
