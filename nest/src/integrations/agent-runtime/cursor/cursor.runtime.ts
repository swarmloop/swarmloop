import { SwarmloopError } from '../../../swarmloop-error';
import { AbstractAgentRuntime } from '../abstract-agent-runtime';
import type { RuntimeKeys } from '../agent-runtime';

export class CursorRuntime extends AbstractAgentRuntime {
  readonly name = 'cursor' as const;
  readonly command = 'agent';
  readonly apiHosts = ['api2.cursor.sh', 'api.cursor.com', 'cursor.com'];
  readonly credentialNames = ['CURSOR_API_KEY'];

  credential(keys: RuntimeKeys): { name: string; value: string } {
    if (keys.cursorKey === '') {
      throw new SwarmloopError('CURSOR_API_KEY is missing');
    }
    return { name: 'CURSOR_API_KEY', value: keys.cursorKey };
  }
}
