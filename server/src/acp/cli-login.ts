import { hostname } from 'os';
import { rawEnv } from '../config/process-env';
import { envFilePath } from '../config/load-env';
import { delay } from '../core/delay';
import { HttpServerApi } from './server-api';
import { readApiUrl } from './shell-env';
import { configPath, deleteFileToken, readFileToken, writeFileToken } from './cli-token';

const POLL_MS = 2000;
const ENV_NOTE = 'SWARMLOOP_TOKEN is set and is used instead of this login';

type LoginApi = Pick<HttpServerApi, 'startCliLogin' | 'pollCliLogin' | 'currentToken' | 'revokeCurrent'>;

export interface AuthDeps {
  /** An api that sends the given token as the bearer; an empty token sends none. */
  apiFor(token: string): LoginApi;
  wait(ms: number): Promise<void>;
  print(line: string): void;
  machine: string;
  env: NodeJS.ProcessEnv;
  home?: string;
}

export function authDeps(root: string): AuthDeps {
  return {
    apiFor: (token) => new HttpServerApi(readApiUrl(envFilePath(root)), token),
    wait: delay,
    print: (line) => process.stderr.write(`${line}\n`),
    machine: hostname(),
    env: rawEnv(),
  };
}

/** Runs `login`, `login --token <value>` or `logout`. Returns false for any other command. */
export async function runAuthCommand(argv: string[], deps: AuthDeps): Promise<boolean> {
  if (argv[0] === 'login') {
    await (argv[1] === '--token' ? loginWithToken(argv[2] ?? '', deps) : login(deps));
    return true;
  }
  if (argv[0] === 'logout') {
    await logout(deps);
    return true;
  }
  return false;
}

async function login(deps: AuthDeps): Promise<void> {
  const anonymous = deps.apiFor('');
  const started = await anonymous.startCliLogin(deps.machine);
  deps.print(`Open ${started.url} and approve code ${started.code}`);
  for (;;) {
    const poll = await anonymous.pollCliLogin(started.id);
    if (poll.status === 'approved') {
      await store(poll.token, deps);
      return;
    }
    if (poll.status === 'expired') {
      throw new Error('the login code expired: run `sloop login` again');
    }
    await deps.wait(POLL_MS);
  }
}

async function loginWithToken(value: string, deps: AuthDeps): Promise<void> {
  if (!value) {
    throw new Error('--token needs a value');
  }
  await store(value, deps);
}

async function store(token: string, deps: AuthDeps): Promise<void> {
  const current = await deps.apiFor(token).currentToken();
  writeFileToken(configPath(deps.env, deps.home), token);
  deps.print(`Signed in as ${current.login}`);
  if (deps.env.SWARMLOOP_TOKEN) {
    deps.print(ENV_NOTE);
  }
}

async function logout(deps: AuthDeps): Promise<void> {
  const file = configPath(deps.env, deps.home);
  const token = readFileToken(file);
  if (!token) {
    deps.print('not signed in');
    return;
  }
  await deps.apiFor(token).revokeCurrent();
  deleteFileToken(file);
  deps.print('Signed out');
}
