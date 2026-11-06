import { existsSync, readFileSync, realpathSync } from 'fs';
import { join } from 'path';
import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { AppConfig } from '../config/env';
import { Clock } from '../core/clock';
import { resolveRepoRoot } from '../config/repo-root';
import { DocumentRepository } from '../history/document.repository';
import { root } from '../history/run-paths';
import { RunRepository } from '../history/run.repository';
import { modelForStep } from '../agent/spend';
import { CHAT_LOCK, chatLockBody } from '../pipeline/chat-lock';
import { settleShell, shellHolding } from '../pipeline/shell-lock';
import { ServiceContextService } from '../integrations/service-context';
import { AgentLauncher } from '../steps/shared/agent-launcher';
import { agentFailure } from '../steps/shared/agent-result';
import { LOCAL_RUN_RULE } from '../steps/shared/skill-prompt';
import { mountsForRun } from '../sandbox/sandbox-launch';
import { SandboxService } from '../sandbox/sandbox.service';
import { SwarmloopError } from '../core/swarmloop-error';
import { installMcp, McpServerSpec, readMcpServers } from './mcp-config';
import { ChatBody, ChatView } from '../contract/api';

@Injectable()
export class ChatService {
  constructor(
    private readonly runs: RunRepository,
    private readonly documents: DocumentRepository,
    private readonly config: AppConfig,
    private readonly clock: Clock,
    private readonly sandbox: SandboxService,
    private readonly launcher: AgentLauncher,
    private readonly services: ServiceContextService,
  ) {}

  async speak(key: string, body: ChatBody): Promise<ChatView> {
    const found = await this.runs.findRun(key);
    if (!found) {
      throw new NotFoundException(`${key} is missing`);
    }
    const run = await settleShell(this.runs, this.documents, this.sandbox, found, this.clock);
    if (shellHolding(await this.documents.latestBody(key, CHAT_LOCK), run.status) || this.runs.held(run)) {
      throw new ConflictException(`${key} is already running`);
    }
    const prompt = body.prompt?.trim() ?? '';
    if (!prompt) {
      throw new BadRequestException('prompt is missing');
    }
    const env = this.config.env;
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
        await this.documents.putDocument(run, CHAT_LOCK, chatLockBody(previous.status, process.pid));
      }
      locked = true;
      if (run.runtime !== env.RUNTIME) {
        run.runtime = env.RUNTIME;
        await this.documents.putDocument(run, 'shell_resume', 'clear\n');
      }
      run.status = 'running';
      run.ownerPid = process.pid;
      await this.runs.saveRun(run);
      await this.sandbox.assertReady(env.RUNTIME);
      const result = await this.launcher.launch({
        root: root(this.config),
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
        continuePrompt: null,
      });
      const failed = agentFailure(result, 'chat', 'agent');
      if (failed) {
        throw new BadRequestException(failed);
      }
      await this.documents.putDocument(run, 'chat', `user: ${prompt}\n\n${result.responseText}`);
      return { text: result.responseText };
    } catch (error) {
      if (
        error instanceof BadRequestException ||
        error instanceof ConflictException ||
        error instanceof NotFoundException
      ) {
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
          await this.runs.saveRun(run);
        } catch {
          // The chat result is the error to surface. The lock still names this process.
        }
        try {
          await this.documents.putDocument(run, CHAT_LOCK, 'clear\n');
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
    const workspace = join(root(this.config), 'worktrees', key);
    if (!targetPath && !existsSync(workspace)) {
      throw new BadRequestException('working directory is missing');
    }
    return mountsForRun(workspace, targetPath);
  }

  private async prompt(
    key: string,
    skill: string | undefined,
    text: string,
    directory: string,
    servers: McpServerSpec[],
  ): Promise<string> {
    const name = skill?.trim() ?? '';
    const body = name ? this.skill(name) : '';
    const stored = await this.documents.latestBody(key, 'requirements');
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
    const file = join(resolveRepoRoot(this.config.env.SWARMLOOP_ROOT, __dirname), 'skills', name, 'SKILL.md');
    try {
      return readFileSync(file, 'utf8').trimEnd();
    } catch {
      throw new BadRequestException(`${name} skill is missing`);
    }
  }
}
