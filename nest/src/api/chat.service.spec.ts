import { mkdir, mkdtemp, readFile, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { ConfigService } from '@nestjs/config';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { AgentRunInput, AgentRunResult } from '../limits/agent-runner';
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
    const history = {
      findRun: async () => run,
      held: () => false,
      root: () => root,
      tokenTotal: async () => 3,
      latestBody: async (_key: string, kind: string) => (kind === 'requirements' ? 'Add the field' : null),
      saveRun: async (value: unknown) => {
        saved.push({ ...(value as object) });
        return value;
      },
      putDocument: async (_run: unknown, kind: string, body: string) => {
        documents.push(`${kind}:${body}`);
      },
    };
    const agent = jest.fn(async (input: AgentRunInput): Promise<AgentRunResult> => {
      const raw = await readFile(join(project, '.cursor', 'mcp.json'), 'utf8');
      expect(raw).toContain('idea-mcp');
      expect(raw).not.toContain('secret-value');
      return result(input.prompt);
    });
    const chat = new ChatService(
      history as never,
      config(root),
      { assertReady: async () => undefined } as never,
      { run: agent } as never,
      { block: async () => 'Services:\nJira PROJ-1: Ship the field' } as never,
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
    expect(saved.length).toBeGreaterThan(0);
    expect(documents.some((row) => row.startsWith(`chat_lock:waiting ${process.pid}`))).toBe(true);
    expect(documents.some((row) => row.startsWith('chat_lock:clear'))).toBe(true);
  });

  it('refuses a chat while the feature is running', async () => {
    const history = {
      findRun: async () => ({ key: 'PROJ-1', status: 'running', ownerPid: process.pid }),
      held: () => true,
      latestBody: async () => null,
    };
    const chat = new ChatService(history as never, config('/tmp'), { assertReady: async () => undefined } as never, { run: jest.fn() } as never, {
      block: async () => '',
    } as never);
    await expect(chat.speak('PROJ-1', { prompt: 'hello' })).rejects.toBeInstanceOf(ConflictException);
  });

  it('refuses an empty prompt', async () => {
    const history = {
      findRun: async () => ({ key: 'PROJ-1', status: 'waiting' }),
      held: () => false,
      latestBody: async () => null,
    };
    const chat = new ChatService(history as never, config('/tmp'), { assertReady: async () => undefined } as never, { run: jest.fn() } as never, {
      block: async () => '',
    } as never);
    await expect(chat.speak('PROJ-1', { prompt: '  ' })).rejects.toBeInstanceOf(BadRequestException);
  });
});

function config(root: string): ConfigService {
  const values: Record<string, string | number> = {
    RUNTIME: 'cursor',
    REQUIREMENTS_VIA: 'direct',
    ISSUE_TRACKER: 'jira',
    JIRA_BASE_URL: '',
    JIRA_EMAIL: '',
    JIRA_API_TOKEN: '',
    GITLAB_BASE_URL: '',
    GITLAB_TOKEN: '',
    GITHUB_BASE_URL: '',
    GITHUB_TOKEN: '',
    CURSOR_API_KEY: '',
    ANTHROPIC_API_KEY: '',
    MAX_AGENT_CALLS: 20,
    MAX_RETURNS: 3,
    MAX_PIPELINE_RETURNS: 6,
    MAX_LAUNCHES: 3,
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
    PIPELINE_START_TIMEOUT_MS: 180000,
    MODEL_RESEARCH: 'research-model',
    MODEL_PLAN: 'plan-model',
    MODEL_IMPLEMENT: 'implement-model',
    SWARMLOOP_ROOT: root,
    SWARMLOOP_API_PORT: 3920,
    SWARMLOOP_API_HOST: '127.0.0.1',
  };
  return {
    get: (key: string) => values[key],
    getOrThrow: (key: string) => {
      if (values[key] === undefined) {
        throw new Error(key);
      }
      return values[key];
    },
  } as ConfigService;
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
