import { readFileSync } from 'fs';
import { RUNTIME_NAMES, RuntimeName } from '../integrations/agent-runtime/agent-runtime.registry';

export interface ShellConfig {
  runtime: RuntimeName;
  model: string;
  cursorKey: string;
  anthropicKey: string;
  oauthToken: string;
  checkoutsRoot: string | undefined;
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
    const match = /^(?:export\s+)?(RUNTIME|MODEL_IMPLEMENT|CURSOR_API_KEY|ANTHROPIC_API_KEY|CLAUDE_CODE_OAUTH_TOKEN|CHECKOUTS_ROOT)=(.*)$/.exec(line.trim());
    if (!match) {
      continue;
    }
    values.set(match[1], unquote(match[2].trim()));
  }
  const runtime = values.get('RUNTIME');
  if (!isRuntimeName(runtime)) {
    throw new Error('RUNTIME is missing');
  }
  return {
    runtime,
    model: values.get('MODEL_IMPLEMENT') ?? '',
    cursorKey: values.get('CURSOR_API_KEY') ?? '',
    anthropicKey: values.get('ANTHROPIC_API_KEY') ?? '',
    oauthToken: values.get('CLAUDE_CODE_OAUTH_TOKEN') ?? '',
    checkoutsRoot: values.get('CHECKOUTS_ROOT'),
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
