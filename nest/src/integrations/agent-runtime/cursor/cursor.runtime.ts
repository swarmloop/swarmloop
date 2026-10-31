import { SwarmloopError } from '../../../swarmloop-error';
import { AbstractAgentRuntime } from '../abstract-agent-runtime';
import type { AgentPrintInput, RuntimeKeys } from '../agent-runtime';

export class CursorRuntime extends AbstractAgentRuntime {
  readonly name = 'cursor' as const;
  readonly command = 'agent' as const;
  readonly syncsChatMode = true;
  readonly priceSource = 'https://cursor.com/docs/models-and-pricing.md';
  readonly apiHosts = ['api2.cursor.sh', 'api.cursor.com', 'cursor.com'];
  readonly credentialNames = ['CURSOR_API_KEY'];

  credential(keys: RuntimeKeys): { name: string; value: string } {
    if (keys.cursorKey === '') {
      throw new SwarmloopError('CURSOR_API_KEY is missing');
    }
    return { name: 'CURSOR_API_KEY', value: keys.cursorKey };
  }

  briefArgs(): string[] {
    return ['--add-dir', '/work/brief'];
  }

  protected appendPrintFlags(args: string[], input: AgentPrintInput): void {
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
