import { existsSync, readFileSync, realpathSync } from 'fs';
import { join } from 'path';
import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { readEnv } from '../config/env';
import { resolveRepoRoot } from '../config/repo-root';
import { HistoryService } from '../history/history.service';
import { AGENT_RUNNER, AgentProcessRunner } from '../limits/agent-runner';
import { modelForStep } from '../limits/spend';
import { CHAT_LOCK, chatLockBody } from '../pipeline/chat-lock';
import { settleShell, shellHolding } from '../pipeline/shell-lock';
import { ServiceContextService } from '../providers/service-context';
import { agentFailure, launchAgent, LOCAL_RUN_RULE } from '../steps/model-step';
import { mountsForRun } from '../sandbox/sandbox-launch';
import { SandboxService } from '../sandbox/sandbox.service';
import { SwarmloopError } from '../swarmloop-error';
import { installMcp, McpServerSpec, readMcpServers } from './mcp-config';

export interface ChatBody {
  prompt?: string;
  skill?: string;
  cwd?: string;
  mcpServers?: unknown;
}

@Injectable()
export class ChatService {
  constructor(
    private readonly history: HistoryService,
    private readonly config: ConfigService,
    private readonly sandbox: SandboxService,
    @Inject(AGENT_RUNNER) private readonly agent: AgentProcessRunner,
    private readonly services: ServiceContextService,
  ) {}

  async speak(key: string, body: ChatBody): Promise<{ text: string }> {
    const found = await this.history.findRun(key);
    if (!found) {
      throw new NotFoundException(`${key} is missing`);
    }
    const run = await settleShell(this.history, this.sandbox, found);
    if (shellHolding(await this.history.latestBody(key, CHAT_LOCK), run.status) || this.history.held(run)) {
      throw new ConflictException(`${key} is already running`);
    }
    const prompt = body.prompt?.trim() ?? '';
    if (!prompt) {
      throw new BadRequestException('prompt is missing');
    }
    const env = readEnv(this.config);
    const model = modelForStep('implement', env);
    if (!model) {
      throw new BadRequestException('MODEL_IMPLEMENT is missing');
    }
    const mounts = this.mounts(key, body.cwd, run.targetPath);
    const servers = readMcpServers(body.mcpServers);
    const restore = installMcp(mounts[0].hostPath, servers);
    const previous = { status: run.status, ownerPid: run.ownerPid };
    let locked = false;
    try {
      if (/^(waiting|blocked|failed|done)$/.test(previous.status)) {
        await this.history.putDocument(run, CHAT_LOCK, chatLockBody(previous.status, process.pid));
      }
      locked = true;
      run.status = 'running';
      run.ownerPid = process.pid;
      await this.history.saveRun(run);
      await this.sandbox.assertReady(env.RUNTIME);
      const result = await launchAgent({
        agent: this.agent,
        history: this.history,
        run,
        key,
        step: 'chat',
        mode: 'agent',
        model,
        timeLimitMs: env.IMPLEMENT_TIMEOUT_MS,
        prompt: await this.prompt(key, body.skill, prompt, mounts[0].hostPath, servers),
        workspace: mounts[0].containerPath,
        mounts,
        approveMcps: servers.length > 0,
      });
      const failed = agentFailure(result, 'chat');
      if (failed) {
        throw new BadRequestException(failed);
      }
      await this.history.putDocument(run, 'chat', `user: ${prompt}\n\n${result.responseText}`);
      return { text: result.responseText };
    } catch (error) {
      if (error instanceof BadRequestException || error instanceof ConflictException || error instanceof NotFoundException) {
        throw error;
      }
      const message = error instanceof SwarmloopError ? error.message : 'chat failed';
      throw new BadRequestException(message);
    } finally {
      restore();
      if (locked) {
        run.status = previous.status;
        run.ownerPid = previous.ownerPid;
        try {
          await this.history.saveRun(run);
        } catch {
          // The chat result is the error to surface. The lock still names this process.
        }
        try {
          await this.history.putDocument(run, CHAT_LOCK, 'clear\n');
        } catch {
          // A leftover lock is ignored once a later step uses a different pid.
        }
      }
    }
  }

  private mounts(key: string, cwd: string | undefined, targetPath: string | null) {
    const trimmed = cwd?.trim() ?? '';
    if (trimmed) {
      if (!existsSync(trimmed)) {
        throw new BadRequestException('working directory is missing');
      }
      return [{ hostPath: realpathSync(trimmed), containerPath: '/work' }];
    }
    const workspace = join(this.history.root(), 'worktrees', key);
    if (!targetPath && !existsSync(workspace)) {
      throw new BadRequestException('working directory is missing');
    }
    return mountsForRun(workspace, targetPath);
  }

  private async prompt(key: string, skill: string | undefined, text: string, directory: string, servers: McpServerSpec[]): Promise<string> {
    const name = skill?.trim() ?? '';
    const body = name ? this.skill(name) : '';
    const stored = await this.history.latestBody(key, 'requirements');
    let notes = '';
    try {
      notes = await this.services.block(key, text);
    } catch {
      notes = '';
    }
    const parts = [LOCAL_RUN_RULE, `Working directory: ${directory}`];
    if (body) {
      parts.push('', body);
    }
    if (stored?.trim()) {
      parts.push('', 'Requirements:', stored.trim());
    }
    if (notes) {
      parts.push('', notes);
    }
    if (servers.length > 0) {
      parts.push('', `MCP servers: ${servers.map((server) => server.name).join(', ')}`);
    }
    parts.push('', 'User:', text);
    return parts.join('\n');
  }

  private skill(name: string): string {
    if (!/^[a-z0-9-]+$/.test(name)) {
      throw new BadRequestException(`${name} skill is missing`);
    }
    const file = join(resolveRepoRoot(readEnv(this.config).SWARMLOOP_ROOT, __dirname), 'skills', name, 'SKILL.md');
    try {
      return readFileSync(file, 'utf8').trimEnd();
    } catch {
      throw new BadRequestException(`${name} skill is missing`);
    }
  }
}
