import type { PipelineJob, PipelineSnapshot } from '../integrations/code-host/code-host';

const URL = 'https://gitlab.example/group/demo/-/pipelines/9';

type Script =
  { kind: 'pass' } | { kind: 'fail'; log: string } | { kind: 'silent' } | { kind: 'queued' } | { kind: 'timed-out' };

/** The CI of a fake code host: what each commit's pipeline says, as a spec scripts it. The latest script for a sha wins. */
export class FakeCi {
  private readonly scripts = new Map<string, Script>();
  private readonly branchScripts = new Map<string, Script>();
  private read: string | undefined;
  private readBranch: string | undefined;
  private readCount = 0;
  private noted = '';

  pass(sha: string): void {
    this.scripts.set(sha, { kind: 'pass' });
  }

  /** The `test` job of the commit fails with `jobLog` as its log. */
  fail(sha: string, jobLog: string): void {
    this.scripts.set(sha, { kind: 'fail', log: jobLog });
  }

  /** The `test` job of every commit of the branch fails with `jobLog` as its log, whatever the commit, until a sha is scripted. */
  failBranch(branch: string, jobLog: string): void {
    this.branchScripts.set(branch, { kind: 'fail', log: jobLog });
  }

  /** No run ever starts for the commit. */
  silent(sha: string): void {
    this.scripts.set(sha, { kind: 'silent' });
  }

  /** The host accepted a run for the commit and never starts a job. */
  queued(sha: string): void {
    this.scripts.set(sha, { kind: 'queued' });
  }

  /** The run of the commit ends with its `test` job timed out, again after every rerun. */
  timedOut(sha: string): void {
    this.scripts.set(sha, { kind: 'timed-out' });
  }

  /** What the host says about the failed run, as its notes. */
  note(text: string): void {
    this.noted = text;
  }

  get notes(): string {
    return this.noted;
  }

  /** How many times a pipeline was read. */
  get reads(): number {
    return this.readCount;
  }

  /** True when the pipeline of the commit is scripted to pass. */
  passed(sha: string | undefined, branch?: string): boolean {
    return this.outcome(sha, branch)?.kind === 'pass';
  }

  /** What the commit's pipeline is scripted to do: its own script, else the script of its branch. */
  private outcome(sha: string | undefined, branch?: string): Script | undefined {
    return (sha ? this.scripts.get(sha) : undefined) ?? (branch ? this.branchScripts.get(branch) : undefined);
  }

  snapshot(sha: string | undefined, branch?: string): PipelineSnapshot | null {
    this.read = sha;
    this.readBranch = branch;
    this.readCount += 1;
    const script = this.outcome(sha, branch);
    if (!script || script.kind === 'silent') {
      return null;
    }
    if (script.kind === 'queued') {
      const run = { id: 9, status: 'running', url: URL, jobs: [], total: 0, queued: true };
      return { id: 9, status: 'running', url: URL, jobs: [], runs: [run], checks: [], awaiting: [] };
    }
    const status = script.kind === 'pass' ? 'success' : script.kind === 'timed-out' ? 'timed_out' : 'failed';
    const jobs: PipelineJob[] = [{ id: 1, name: 'test', stage: 'test', status, allowFailure: false }];
    if (script.kind === 'timed-out') {
      const run = { id: 9, status: 'failed', url: URL, jobs };
      return { id: 9, status: 'failed', url: URL, jobs, runs: [run], checks: [], awaiting: [] };
    }
    return { id: 9, status, url: URL, jobs, runs: [{ id: 9, status, url: URL, jobs }], checks: [], awaiting: [] };
  }

  /** The log of the failed job of the commit read last, or an empty text. */
  trace(): string {
    const script = this.outcome(this.read, this.readBranch);
    return script?.kind === 'fail' ? script.log : '';
  }
}
