import type { ConnectionFlow } from '../../../contract/connections';
import type { Connection, ConnectionProbe, ConnectionTestResult, SignInFlow, SignInParse } from '../../connection';
import { envFields } from '../../env-fields';
import { modelsApiAnswer } from '../models-api-answer';

const KEY = 'CODEX_API_KEY';
const AUTH = 'CODEX_AUTH';
const LINK = /https:\/\/\S+/;
const DEVICE_CODE = /\b[A-Z0-9]{4,}-[A-Z0-9]{4,}\b/;
/** Printed after the login, in the container that made `auth.json`, which is gone when the sign-in ends. */
const AUTH_MARKER = 'AUTH_JSON_B64:';
const SIGN_IN_TIMEOUT_MS = 15 * 60 * 1000;
const LOGIN_AND_PRINT = `codex login --device-auth && printf "\\n${AUTH_MARKER}" && base64 -w0 /home/sandbox/.codex/auth.json`;

/** Codex on the Connections page: a pasted API key, or a ChatGPT login whose account the CLI checks. */
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
      { kind: 'device-code', label: 'Sign in with ChatGPT', fields: [], helpUrl: null },
    ];
  }

  envDefault(env: object): Record<string, string> | null {
    return envFields(env, [KEY, AUTH]);
  }

  secrets(fields: Record<string, string>): string[] {
    return [fields[KEY], fields[AUTH]].filter(Boolean);
  }

  signIn(): SignInFlow {
    return {
      command: () => ['sh', '-c', LOGIN_AND_PRINT],
      hosts: [],
      timeoutMs: SIGN_IN_TIMEOUT_MS,
      parse: parseDeviceLogin,
    };
  }

  async test(fields: Record<string, string>, probe: ConnectionProbe): Promise<ConnectionTestResult> {
    if (fields[AUTH]) {
      return this.accountStatus(fields[AUTH], probe);
    }
    const answer = await probe.request(`${this.baseUrl}/v1/models`, { authorization: `Bearer ${fields[KEY] ?? ''}` });
    return modelsApiAnswer('OpenAI', answer);
  }

  /** The account check of the CLI, with the stored login in place. */
  private async accountStatus(auth: string, probe: ConnectionProbe): Promise<ConnectionTestResult> {
    const status = await probe.check('codex', [{ name: AUTH, value: auth }], ['codex', 'login', 'status']);
    return status.ok ? { ok: true, account: status.output || null } : { ok: false, message: status.output };
  }
}

/** `codex login --device-auth` prints a link and a code, and after it the marker and the base64 of `auth.json`. */
function parseDeviceLogin(output: string): SignInParse {
  const marker = output.indexOf(AUTH_MARKER);
  const shown = marker === -1 ? output : output.slice(0, marker);
  const auth = marker === -1 ? '' : output.slice(marker + AUTH_MARKER.length).trim();
  return {
    link: LINK.exec(shown)?.[0] ?? null,
    code: DEVICE_CODE.exec(shown)?.[0] ?? null,
    asksForCode: false,
    fields: auth === '' ? null : { [AUTH]: auth },
  };
}
