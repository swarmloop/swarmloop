import type { ConnectionFlow } from '../../../contract/connections';
import type { Connection, ConnectionProbe, ConnectionTestResult, SignInFlow, SignInParse } from '../../connection';
import { modelsApiAnswer } from '../models-api-answer';

const KEY = 'ANTHROPIC_API_KEY';
const TOKEN = 'CLAUDE_CODE_OAUTH_TOKEN';
const LINK = /https:\/\/\S+/;
const PRINTED_TOKEN = /sk-ant-oat[\w-]+/;
const SIGN_IN_TIMEOUT_MS = 10 * 60 * 1000;

/** Claude on the Connections page: a pasted API key, or the token `claude setup-token` makes, tested against the models endpoint. */
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
      { kind: 'cli-code', label: 'Sign in with Claude', fields: [], helpUrl: null },
    ];
  }

  envDefault(env: object): boolean {
    const values = env as Record<string, unknown>;
    return Boolean(values.ANTHROPIC_API_KEY || values.CLAUDE_CODE_OAUTH_TOKEN);
  }

  secrets(fields: Record<string, string>): string[] {
    return [fields[KEY], fields[TOKEN]].filter(Boolean);
  }

  signIn(): SignInFlow {
    return {
      command: () => ['claude', 'setup-token'],
      hosts: ['claude.ai', 'platform.claude.com', 'console.anthropic.com'],
      timeoutMs: SIGN_IN_TIMEOUT_MS,
      parse: parseSetupToken,
    };
  }

  async test(fields: Record<string, string>, probe: ConnectionProbe): Promise<ConnectionTestResult> {
    const version = { 'anthropic-version': '2023-06-01' };
    const headers = fields[TOKEN]
      ? { ...version, authorization: `Bearer ${fields[TOKEN]}`, 'anthropic-beta': 'oauth-2025-04-20' }
      : { ...version, 'x-api-key': fields[KEY] ?? '' };
    const answer = await probe.request(`${this.baseUrl}/v1/models`, headers);
    return modelsApiAnswer('Anthropic', answer);
  }
}

/** `claude setup-token` prints a link, asks for the code the page shows, then prints the token. */
function parseSetupToken(output: string): SignInParse {
  const link = LINK.exec(output)?.[0] ?? null;
  const token = PRINTED_TOKEN.exec(output)?.[0] ?? null;
  return { link, code: null, asksForCode: link !== null && token === null, fields: token ? { [TOKEN]: token } : null };
}
