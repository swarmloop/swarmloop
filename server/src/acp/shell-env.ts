import { splitAgent } from '../config/agents';
import { splitList } from '../config/env';
import { readDefaultSettings, readSettings } from '../config/load-env';
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
  /** The memory in GB that Docker keeps for the server and the dashboard, as on the server. */
  reserveMemoryGb: number;
}

/** Reads the model key for the sandbox env only. Callers must not print the result. */
export function readShellConfig(file: string, launchEnv?: Readonly<NodeJS.ProcessEnv>): ShellConfig {
  const { values } = readSettings(file, launchEnv);
  const implement = firstImplementAgent(values.AGENTS_IMPLEMENT ?? '');
  return {
    runtime: implement.runtime,
    model: implement.model,
    cursorKey: values.CURSOR_API_KEY ?? '',
    anthropicKey: values.ANTHROPIC_API_KEY ?? '',
    oauthToken: values.CLAUDE_CODE_OAUTH_TOKEN ?? '',
    codexAuth: values.CODEX_AUTH ?? '',
    codexApiKey: values.CODEX_API_KEY ?? '',
    checkoutsRoot: values.CHECKOUTS_ROOT,
    repos: splitList(values.SWARMLOOP_REPOS),
    egress: values.SANDBOX_EGRESS,
    engine: values.SANDBOX_DOCKER_RUNTIME ?? '',
    reserveMemoryGb: reserveGigabytes(values.RESERVE_MEMORY_GB),
  };
}

function reserveGigabytes(value: string | undefined): number {
  const given = value === undefined || value === '' ? Number.NaN : Number(value);
  return Number.isFinite(given) && given >= 0 ? given : Number(readDefaultSettings().RESERVE_MEMORY_GB);
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
