import { readFileSync } from 'fs';
import { parseAgentList } from '../config/agents';
import { splitList } from '../config/env';
import type { RuntimeName } from '../integrations/agent-runtime/agent-runtime.registry';
import { RUNTIME_NAMES } from '../integrations/agent-runtime/agent-runtime.registry';

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
      /^(?:export\s+)?(RUNTIME|MODEL_IMPLEMENT|AGENTS_IMPLEMENT|CURSOR_API_KEY|ANTHROPIC_API_KEY|CLAUDE_CODE_OAUTH_TOKEN|CODEX_AUTH|CODEX_API_KEY|CHECKOUTS_ROOT|SWARMLOOP_REPOS|SANDBOX_EGRESS|SANDBOX_DOCKER_RUNTIME)=(.*)$/.exec(
        line.trim(),
      );
    if (!match) {
      continue;
    }
    values.set(match[1], unquote(match[2].trim()));
  }
  const listed = values.get('AGENTS_IMPLEMENT') ?? '';
  const implement = listed === '' ? undefined : parseAgentList('AGENTS_IMPLEMENT', listed)[0];
  const runtime = implement?.runtime ?? values.get('RUNTIME');
  if (!isRuntimeName(runtime)) {
    throw new Error('RUNTIME is missing');
  }
  return {
    runtime,
    model: implement?.model ?? values.get('MODEL_IMPLEMENT') ?? '',
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

function isRuntimeName(value: string | undefined): value is RuntimeName {
  return RUNTIME_NAMES.some((name) => name === value);
}

function unquote(value: string): string {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}
