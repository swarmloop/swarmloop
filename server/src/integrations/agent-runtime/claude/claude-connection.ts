import type { ConnectionFlow } from '../../../contract/connections';
import type { Connection, ConnectionProbe, ConnectionTestResult } from '../../connection';
import { modelsApiAnswer } from '../models-api-answer';

const KEY = 'ANTHROPIC_API_KEY';

/** Claude on the Connections page: a pasted API key, tested against the models endpoint. */
export class ClaudeConnection implements Connection {
  readonly id = 'claude';
  readonly logo = 'claude';
  readonly label = 'Claude';
  readonly purpose = 'Runs Claude agents on your own Anthropic account';

  constructor(private readonly baseUrl = 'https://api.anthropic.com') {}

  flows(): ConnectionFlow[] {
    return [
      {
        kind: 'secret',
        label: 'Paste an API key',
        fields: [{ name: KEY, label: 'Anthropic API key', secret: true }],
        helpUrl: 'https://console.anthropic.com/settings/keys',
      },
    ];
  }

  envDefault(env: object): boolean {
    const values = env as Record<string, unknown>;
    return Boolean(values.ANTHROPIC_API_KEY || values.CLAUDE_CODE_OAUTH_TOKEN);
  }

  secrets(fields: Record<string, string>): string[] {
    return [fields[KEY]].filter(Boolean);
  }

  async test(fields: Record<string, string>, probe: ConnectionProbe): Promise<ConnectionTestResult> {
    const answer = await probe.request(`${this.baseUrl}/v1/models`, {
      'x-api-key': fields[KEY] ?? '',
      'anthropic-version': '2023-06-01',
    });
    return modelsApiAnswer('Anthropic', answer);
  }
}
