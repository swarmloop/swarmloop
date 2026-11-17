/**
 * A fake git for specs: armed answers for chosen git calls, the real git for everything else.
 * A spec mocks child_process with `faultyChildProcess()` and arms a fault with `failGit`.
 */
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

/** Arms `answer` for the next `times` git calls whose words after `-C <path>` start with `match`. */
export function failGit(match: string[], answer: GitAnswer, times = 1): void {
  faults.push({ match, answer, times });
}

export function clearGitFaults(): void {
  faults.length = 0;
}

function takeFault(file: unknown, args: unknown): GitAnswer | null {
  if (file !== 'git' || !Array.isArray(args) || args[0] !== '-C') {
    return null;
  }
  const words = args.slice(2) as string[];
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
