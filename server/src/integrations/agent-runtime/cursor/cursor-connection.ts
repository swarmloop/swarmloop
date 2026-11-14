import type { ConnectionFlow } from '../../../contract/connections';
import type { Connection, ConnectionProbe, ConnectionTestResult } from '../../connection';
import { envFields } from '../../env-fields';

const KEY = 'CURSOR_API_KEY';

/** Cursor on the Connections page: a pasted API key, tested by the CLI's own model list in the agent image. */
export class CursorConnection implements Connection {
  readonly id = 'cursor';
  readonly logo = 'cursor';
  readonly label = 'Cursor';
  readonly purpose = 'Runs Cursor agents on your own Cursor account';

  flows(): ConnectionFlow[] {
    return [
      {
        kind: 'secret',
        label: 'Paste an API key',
        fields: [{ name: KEY, label: 'Cursor API key', secret: true }],
        helpUrl: null,
      },
    ];
  }

  envDefault(env: object): Record<string, string> | null {
    return envFields(env, [KEY]);
  }

  secrets(fields: Record<string, string>): string[] {
    return [fields[KEY]].filter(Boolean);
  }

  async test(fields: Record<string, string>, probe: ConnectionProbe): Promise<ConnectionTestResult> {
    try {
      const models = await probe.listModels('cursor', { cursorKey: fields[KEY] ?? '' });
      return models.length > 0 ? { ok: true, account: null } : { ok: false, message: 'Cursor listed no models' };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  }
}
