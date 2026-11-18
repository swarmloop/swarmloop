/**
 * A fake git for specs: armed answers for chosen git calls, the real git for everything else.
 * A spec mocks child_process with `faultyChildProcess()` and arms a fault with `failGit`.
 */
import { existsSync, realpathSync } from 'fs';
import { sep } from 'path';

interface GitAnswer {
  stderr?: string;
  stdout?: string;
  code?: number;
}

interface Fault {
  match: string[];
  answer: GitAnswer;
  times: number;
}

const faults: Fault[] = [];
const distrusted: string[] = [];

/** From now on a git call that opens a path under `root` without `safe.directory=<that path>` is refused as dubious ownership. */
export function distrustGit(root: string): void {
  distrusted.push(realpathSync(root));
}

/** Arms `answer` for the next `times` git calls whose words after `-C <path>` start with `match`. */
export function failGit(match: string[], answer: GitAnswer, times = 1): void {
  faults.push({ match, answer, times });
}

export function clearGitFaults(): void {
  faults.length = 0;
  distrusted.length = 0;
}

/** The words of a call without its leading `-c <value>` pairs. */
function withoutConfig(args: string[]): string[] {
  let at = 0;
  while (args[at] === '-c') {
    at += 2;
  }
  return args.slice(at);
}

function openedPath(args: string[]): string | null {
  const words = withoutConfig(args);
  if (words[0] === '-C') {
    return words[1] ?? null;
  }
  return words[0] === 'clone' ? (words[words.indexOf('--') + 1] ?? null) : null;
}

function refusedAsDubious(args: string[]): GitAnswer | null {
  const opened = openedPath(args);
  if (!opened || !existsSync(opened)) {
    return null;
  }
  const real = realpathSync(opened);
  const under = distrusted.some((root) => real === root || real.startsWith(`${root}${sep}`));
  if (!under || args.includes(`safe.directory=${real}`)) {
    return null;
  }
  return { stderr: `fatal: detected dubious ownership in repository at '${opened}'` };
}

function takeFault(file: unknown, args: unknown): GitAnswer | null {
  if (file !== 'git' || !Array.isArray(args)) {
    return null;
  }
  const refused = refusedAsDubious(args as string[]);
  if (refused) {
    return refused;
  }
  const own = withoutConfig(args as string[]);
  if (own[0] !== '-C') {
    return null;
  }
  const words = own.slice(2);
  const fault = faults.find((item) => item.times > 0 && item.match.every((word, index) => words[index] === word));
  if (!fault) {
    return null;
  }
  fault.times -= 1;
  return fault.answer;
}

type Callback = (error: Error | null, stdout: string, stderr: string) => void;

export function faultyChildProcess(): Record<string, unknown> {
  const actual = jest.requireActual<Record<string, unknown>>('child_process');
  const execFile = (...call: unknown[]) => {
    const answer = takeFault(call[0], call[1]);
    const callback = call[call.length - 1] as Callback;
    if (!answer) {
      return (actual.execFile as (...rest: unknown[]) => unknown)(...call);
    }
    const { stdout = '', stderr = '', code = 128 } = answer;
    const error = stdout && !stderr && answer.code === undefined ? null : Object.assign(new Error(stderr), { code });
    setImmediate(() => callback(error, stdout, stderr));
    return undefined;
  };
  return { ...actual, execFile };
}
