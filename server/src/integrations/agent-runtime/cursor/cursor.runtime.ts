import { SwarmloopError } from '../../../core/swarmloop-error';
import type { Effort } from '../../../contract/effort';
import type { LimitHit } from '../runtime-limit';
import { AbstractAgentRuntime } from '../abstract-agent-runtime';
import type { AgentPrintInput, EffortLaunch, PromptCache, RuntimeKeys } from '../agent-runtime';
import { CursorConnection } from './cursor-connection';
import { CURSOR_LIMITS } from './cursor-limit';
import { CURSOR_OUTAGES } from './cursor-outage';
import { effortsOf, idWithEffort, parseModelIds } from './cursor-models';

export class CursorRuntime extends AbstractAgentRuntime {
  readonly name = 'cursor' as const;
  readonly command = 'agent' as const;
  readonly syncsChatMode = true;
  readonly planModeHasPlanTool = true;
  // Not read for Cursor CLI 2025.11.25 in this change: no helper is declared, and a print launch is as before.
  readonly hasHelpers = false;
  readonly readsPaidUse = false;
  readonly priceSource = 'https://cursor.com/docs/models-and-pricing.md';
  readonly apiHosts = ['*.cursor.sh', '*.cursor.com'];
  readonly connection = new CursorConnection();
  readonly credentialNames = ['CURSOR_API_KEY'];
  promptCache(_model: string): PromptCache | null {
    return null;
  }
  contextTokens(_model: string): number | null {
    return null;
  }

  protected readonly limits = CURSOR_LIMITS;
  protected readonly outages = CURSOR_OUTAGES;
  protected readonly modelHost = 'api2.cursor.sh';
  private modelIds: readonly string[] = [];

  /** Null for every line: this CLI's paid-use signal is not read yet, so swarmloop cannot see paid use here. */
  paidUseLimit(_line: string): LimitHit | null {
    return null;
  }

  secrets(keys: RuntimeKeys): string[] {
    return [keys.cursorKey].filter(Boolean);
  }

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

  readDirArgs(dir: string): string[] {
    return ['--add-dir', dir];
  }

  override modelListArgs(): string[] {
    return ['--list-models'];
  }

  /** The ids from the model list. Until they are set no model has a level. */
  override useModelList(output: string): void {
    this.setModelIds(parseModelIds(output));
  }

  override listLoaded(): boolean {
    return this.modelIds.length > 0;
  }

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
    // Cursor has no tool list: a step with no tools asks, which leaves it no edits and no commands.
    const mode = input.tools === 'none' ? 'ask' : input.mode;
    if (mode === 'plan' || mode === 'ask') {
      args.push('--mode', mode);
    } else {
      args.push('--force', '--sandbox', 'disabled');
    }
  }
}
