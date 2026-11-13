import type { PipelineJob, PipelineSnapshot } from '../integrations/code-host/code-host';

const URL = 'https://gitlab.example/group/demo/-/pipelines/9';

type Script = { kind: 'pass' } | { kind: 'fail'; log: string } | { kind: 'silent' };

/** The CI of a fake code host: what each commit's pipeline says, as a spec scripts it. The latest script for a sha wins. */
export class FakeCi {
  private readonly scripts = new Map<string, Script>();
  private read: string | undefined;

  pass(sha: string): void {
    this.scripts.set(sha, { kind: 'pass' });
  }

  /** The `test` job of the commit fails with `jobLog` as its log. */
  fail(sha: string, jobLog: string): void {
    this.scripts.set(sha, { kind: 'fail', log: jobLog });
  }

  /** No run ever starts for the commit. */
  silent(sha: string): void {
    this.scripts.set(sha, { kind: 'silent' });
  }

  snapshot(sha: string | undefined): PipelineSnapshot | null {
    this.read = sha;
    const script = sha ? this.scripts.get(sha) : undefined;
    if (!script || script.kind === 'silent') {
      return null;
    }
    const status = script.kind === 'pass' ? 'success' : 'failed';
    const jobs: PipelineJob[] = [{ id: 1, name: 'test', stage: 'test', status, allowFailure: false }];
    return { id: 9, status, url: URL, jobs, runs: [{ id: 9, status, url: URL, jobs }], checks: [], awaiting: [] };
  }

  /** The log of the failed job of the commit read last, or an empty text. */
  trace(): string {
    const script = this.read ? this.scripts.get(this.read) : undefined;
    return script?.kind === 'fail' ? script.log : '';
  }
}
