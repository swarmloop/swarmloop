import { mkdir, mkdtemp, readFile, writeFile } from 'fs/promises';
import { RunStop } from '../agent/run-stop';
import { tmpdir } from 'os';
import { join } from 'path';
import { AppConfig } from '../config/env';
import { testEnv } from '../config/env.spec-helpers';
import { FakeClock } from '../core/fake-clock.spec-helpers';
import { BadRequestException, ConflictException } from '@nestjs/common';
import type { AgentRunInput, AgentRunResult } from '../agent/agent-runner';
import { AgentLauncher } from '../steps/shared/agent-launcher';
import { ChatService } from './chat.service';

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
    const agent = jest.fn(async (input: AgentRunInput): Promise<AgentRunResult> => {
      const raw = await readFile(join(project, '.cursor', 'mcp.json'), 'utf8');
      expect(raw).toContain('idea-mcp');
      expect(raw).not.toContain('secret-value');
      return result(input.prompt);
    });
    const chat = new ChatService(
      runRepository as never,
      documentRepository as never,
      config(root),
      new FakeClock(),
      { assertReady: async () => undefined } as never,
      new AgentLauncher({ run: agent } as never, visitRepository as never, new RunStop()),
      { block: async () => 'Services:\nJira PROJ-1: Ship the field' } as never,
      { ensureForRequest: async () => undefined } as never,
    );
    const spoken = await chat.speak('PROJ-1', {
      prompt: 'what is open?',
      skill: 'research',
      cwd: project,
      mcpServers: [{ name: 'idea', command: 'idea-mcp', args: [], env: [{ name: 'TOKEN', value: 'secret-value' }] }],
    });
    expect(spoken.text).toBe('answered');
    const input = agent.mock.calls[0][0];
    expect(input.model).toBe('implement-model');
    expect(input.mode).toBe('agent');
    expect(input.approveMcps).toBe(true);
    expect(input.prompt).toContain('Read the ticket.');
    expect(input.prompt).toContain('Do not start a service');
    expect(input.prompt).toContain('Add the field');
    expect(input.prompt).toContain('Jira PROJ-1: Ship the field');
    expect(input.prompt).toContain('MCP servers: idea');
    expect(input.prompt).not.toContain('secret-value');
    expect(input.continuePrompt).toBeNull();
    expect(run.status).toBe('waiting');
    expect(run.spentUsd).toBeCloseTo(0.21);
    await expect(readFile(join(project, '.cursor', 'mcp.json'), 'utf8')).rejects.toThrow();
    expect(saved.map((row) => (row as { status: string }).status)).toEqual(['running', 'waiting']);
    expect(documents.some((row) => row.startsWith(`chat_lock:waiting ${process.pid}`))).toBe(true);
    expect(documents.some((row) => row.startsWith('chat_lock:clear'))).toBe(true);
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
      new AgentLauncher({ run: jest.fn() } as never, {} as never, new RunStop()),
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
      new AgentLauncher({ run: jest.fn() } as never, {} as never, new RunStop()),
      {
        block: async () => '',
      } as never,
      { ensureForRequest: async () => undefined } as never,
    );
    await expect(chat.speak('PROJ-1', { prompt: '  ' })).rejects.toBeInstanceOf(BadRequestException);
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
      MODEL_RESEARCH: 'research-model',
      MODEL_PLAN: 'plan-model',
      MODEL_IMPLEMENT: 'implement-model',
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
