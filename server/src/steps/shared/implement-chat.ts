import { join } from 'path';
import { Injectable } from '@nestjs/common';
import { resumableChat } from '../../agent/agent-session';
import { StepStopped } from '../../agent/step-stopped';
import type { ResultDefinition } from '../../agent-result/result-definition';
import { agentFor } from '../../config/agents';
import { AppConfig } from '../../config/env';
import { SwarmloopError } from '../../core/swarmloop-error';
import { mountsForStep } from '../../git/repo-names';
import type { RunEntity } from '../../history/entities';
import { root } from '../../history/run-paths';
import { agentFailure } from './agent-result';
import { AgentLauncher } from './agent-launcher';

/** The validated result, or the reason the agent gave none. */
export type ChatAnswer = { value: unknown } | { error: string };

/**
 * One question to the implement agent, outside its own step: in the implement chat of the run when it has one, else in
 * a new chat of the same agent. It has the read-only tools and no file edits, and answers with the given result.
 */
@Injectable()
export class ImplementChat {
  constructor(
    private readonly launcher: AgentLauncher,
    private readonly config: AppConfig,
  ) {}

  async ask(run: RunEntity, repos: string[], prompt: string, definition: ResultDefinition): Promise<ChatAnswer> {
    const env = this.config.env;
    const { runtime, model, ...effort } = agentFor(env, run, 'implement');
    const dir = root(this.config);
    const chat = await resumableChat(dir, run.key, 'implement', runtime);
    try {
      const result = await this.launcher.launch({
        root: dir,
        run,
        key: run.key,
        step: chat?.chatId ? 'implement' : 'merge-request',
        mode: 'plan',
        tools: 'plan',
        runtime,
        model,
        ...effort,
        timeLimitMs: env.IMPLEMENT_TIMEOUT_MS,
        prompt,
        result: definition,
        workspace: join(dir, 'worktrees', run.key),
        mounts: mountsForStep(dir, run.key, repos, run.targetPath),
      });
      const failure = agentFailure(result, 'implement', 'plan');
      if (failure) {
        return { error: failure };
      }
      return result.resultValue === undefined
        ? { error: `the implement agent gave no ${definition.name}` }
        : { value: result.resultValue };
    } catch (error) {
      if (error instanceof StepStopped) throw error;
      return { error: error instanceof SwarmloopError ? error.message : `${definition.name} failed` };
    }
  }
}
