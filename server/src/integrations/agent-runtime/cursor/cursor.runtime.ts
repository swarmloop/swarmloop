import { SwarmloopError } from '../../../core/swarmloop-error';
import type { Effort } from '../../../contract/effort';
import { AbstractAgentRuntime } from '../abstract-agent-runtime';
import type { AgentPrintInput, EffortLaunch, RuntimeKeys } from '../agent-runtime';
import { CURSOR_LIMITS } from './cursor-limit';
import { effortsOf, idWithEffort } from './cursor-models';

export class CursorRuntime extends AbstractAgentRuntime {
  readonly name = 'cursor' as const;
  readonly command = 'agent' as const;
  readonly syncsChatMode = true;
  readonly planModeHasPlanTool = true;
  readonly priceSource = 'https://cursor.com/docs/models-and-pricing.md';
  readonly apiHosts = ['*.cursor.sh', '*.cursor.com'];
  readonly credentialNames = ['CURSOR_API_KEY'];
  protected readonly limits = CURSOR_LIMITS;
  private modelIds: readonly string[] = [];

  credential(keys: RuntimeKeys): { name: string; value: string } {
    if (keys.cursorKey === '') {
      throw new SwarmloopError('CURSOR_API_KEY is missing');
    }
    return { name: 'CURSOR_API_KEY', value: keys.cursorKey };
  }

  // Cursor CLI 2025.11.25 loads AGENTS.md and CLAUDE.md: https://cursor.com/docs/cli/using#rules
  ownRuleFiles(): readonly string[] {
    return ['AGENTS.md', 'CLAUDE.md'];
  }

  briefArgs(): string[] {
    return ['--add-dir', '/work/brief'];
  }

  override modelListArgs(): string[] {
    return ['--list-models'];
  }

  /** The ids from the cached model list. Until they are set no model has a level. */
  setModelIds(ids: readonly string[]): void {
    this.modelIds = ids;
  }

  override efforts(model: string): readonly Effort[] {
    return effortsOf(this.modelIds, model);
  }

  /** The level is part of Cursor's model id, so it swaps the id after `--model`. */
  override withEffort(launch: EffortLaunch, level: Effort): EffortLaunch {
    const id = idWithEffort(this.modelIds, launch.model, level);
    const at = launch.args.indexOf('--model');
    if (id === null || at < 0) {
      return launch;
    }
    const args = [...launch.args];
    args[at + 1] = id;
    return { ...launch, model: id, args };
  }

  protected override partialOutputFlag(): string {
    return '--stream-partial-output';
  }

  protected override workspaceArgs(workspace: string): string[] {
    return ['--trust', '--workspace', workspace];
  }

  protected override appendPrintFlags(args: string[], input: AgentPrintInput): void {
    if (input.mode === 'plan' || input.mode === 'ask') {
      args.push('--mode', input.mode);
    } else {
      args.push('--force', '--sandbox', 'disabled');
    }
    if (input.approveMcps) {
      args.push('--approve-mcps');
    }
  }
}
