import type { ConnectionFlow } from '../../../contract/connections';
import type { Connection, ConnectionProbe, ConnectionTestResult } from '../../connection';
import { modelsApiAnswer } from '../models-api-answer';

const KEY = 'CODEX_API_KEY';

/** Codex on the Connections page: a pasted API key, tested against the models endpoint. */
export class CodexConnection implements Connection {
  readonly id = 'codex';
  readonly logo = 'codex';
  readonly label = 'Codex';
  readonly purpose = 'Runs Codex agents on your own OpenAI account';

  constructor(private readonly baseUrl = 'https://api.openai.com') {}

  flows(): ConnectionFlow[] {
    return [
      {
        kind: 'secret',
        label: 'Paste an API key',
        fields: [{ name: KEY, label: 'OpenAI API key', secret: true }],
        helpUrl: 'https://platform.openai.com/api-keys',
      },
    ];
  }

  envDefault(env: object): boolean {
    const values = env as Record<string, unknown>;
    return Boolean(values.CODEX_API_KEY || values.CODEX_AUTH);
  }

  secrets(fields: Record<string, string>): string[] {
    return [fields[KEY]].filter(Boolean);
  }

  async test(fields: Record<string, string>, probe: ConnectionProbe): Promise<ConnectionTestResult> {
    const answer = await probe.request(`${this.baseUrl}/v1/models`, { authorization: `Bearer ${fields[KEY] ?? ''}` });
    return modelsApiAnswer('OpenAI', answer);
  }
}
