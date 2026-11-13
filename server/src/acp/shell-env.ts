import { readFileSync } from 'fs';
import { splitAgent } from '../config/agents';
import { splitList } from '../config/env';
import type { RuntimeName } from '../integrations/agent-runtime/agent-runtime.registry';

export interface ShellConfig {
  runtime: RuntimeName;
  model: string;
  cursorKey: string;
  anthropicKey: string;
  oauthToken: string;
  codexAuth: string;
  codexApiKey: string;
  checkoutsRoot: string | undefined;
  /** Repository folder names the server is limited to. Empty means every repository. */
  repos: string[];
  /** `open` turns the egress proxy off, as on the server. */
  egress: string | undefined;
  /** A Docker runtime such as `runsc`, as on the server. */
  engine: string;
}

/** Reads the model key for the sandbox env only. Callers must not print the result. */
export function readShellConfig(file: string): ShellConfig {
  const values = new Map<string, string>();
  let body = '';
  try {
    body = readFileSync(file, 'utf8');
  } catch {
    body = '';
  }
  for (const line of body.split('\n')) {
    const match =
      /^(?:export\s+)?(AGENTS_IMPLEMENT|CURSOR_API_KEY|ANTHROPIC_API_KEY|CLAUDE_CODE_OAUTH_TOKEN|CODEX_AUTH|CODEX_API_KEY|CHECKOUTS_ROOT|SWARMLOOP_REPOS|SANDBOX_EGRESS|SANDBOX_DOCKER_RUNTIME)=(.*)$/.exec(
        line.trim(),
      );
    if (!match) {
      continue;
    }
    values.set(match[1], unquote(match[2].trim()));
  }
  const implement = firstImplementAgent(values.get('AGENTS_IMPLEMENT') ?? '');
  return {
    runtime: implement.runtime,
    model: implement.model,
    cursorKey: values.get('CURSOR_API_KEY') ?? '',
    anthropicKey: values.get('ANTHROPIC_API_KEY') ?? '',
    oauthToken: values.get('CLAUDE_CODE_OAUTH_TOKEN') ?? '',
    codexAuth: values.get('CODEX_AUTH') ?? '',
    codexApiKey: values.get('CODEX_API_KEY') ?? '',
    checkoutsRoot: values.get('CHECKOUTS_ROOT'),
    repos: splitList(values.get('SWARMLOOP_REPOS')),
    egress: values.get('SANDBOX_EGRESS'),
    engine: values.get('SANDBOX_DOCKER_RUNTIME') ?? '',
  };
}

function firstImplementAgent(listed: string): { runtime: RuntimeName; model: string } {
  try {
    // The shell runs without an effort, and the server start-up checks the level, so the level is not asked here.
    const [first] = listed === '' ? [] : listed.split(',').map((item) => splitAgent('AGENTS_IMPLEMENT', item));
    if (first) {
      return { runtime: first.runtime, model: first.model };
    }
  } catch {
    // An unparsable list is reported the same way as a missing one.
  }
  throw new Error('AGENTS_IMPLEMENT is missing or invalid');
}

function unquote(value: string): string {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}
