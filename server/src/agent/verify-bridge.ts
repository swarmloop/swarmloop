import { lstat, mkdir, readdir, readFile, rename, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import type { Clock } from '../core/clock';
import { delay } from '../core/delay';
import type { LiveHub } from '../live/live.hub';
import { containerName, type SandboxMount } from '../sandbox/sandbox-launch';
import type { SandboxService } from '../sandbox/sandbox.service';
import { readManifest } from '../verify/manifest';
import { createVerifyLog } from '../verify/verify-log';
import type { VerifyResult, VerifyService } from '../verify/verify.service';
import { worktreeSnapshot } from '../git/worktree-git';
import { renderVerifyLog, snapshotId, type VerifyRecord } from '../steps/verify/verify-record';
import type { DocumentDraft } from '../history/visit';

const REQUEST_ID = /^[a-z0-9]{12}$/;

export interface VerifyBridgeInput {
  repos: { name: string; path: string }[];
  baseRef: string;
  maxCalls: number;
}

export interface VerifyBridgeDeps {
  clock: Clock;
  sandbox: SandboxService;
  verifier: VerifyService;
  root: string;
  key: string;
  step: string;
  statePath: string;
  touch: () => void;
  live?: LiveHub;
}

/** File bridge between an agent's home mount and server-owned project checks. */
export class VerifyBridge {
  private readonly dir: string;
  private stopped = false;
  private calls = 0;
  private running = false;
  private loop: Promise<void> | null = null;
  private readonly documents: DocumentDraft[] = [];

  constructor(
    private readonly input: VerifyBridgeInput,
    private readonly deps: VerifyBridgeDeps,
  ) {
    this.dir = join(deps.statePath, '.swarmloop', 'verify');
  }

  static async enabled(input: VerifyBridgeInput): Promise<boolean> {
    for (const repo of input.repos) {
      try {
        if (await readManifest(repo.path, input.baseRef)) {
          return true;
        }
      } catch {
        // Let the agent start; VerifyService returns the manifest error when it is invoked.
        return true;
      }
    }
    return false;
  }

  async start(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await writeFile(join(this.deps.statePath, '.swarmloop', 'verify.enabled'), '');
    this.loop = this.watch();
  }

  async stop(): Promise<DocumentDraft[]> {
    this.stopped = true;
    if (this.running) {
      await this.deps.sandbox.kill(containerName(this.deps.key, 'verify'));
    }
    await this.loop;
    await rm(this.dir, { recursive: true, force: true });
    await rm(join(this.deps.statePath, '.swarmloop', 'verify.enabled'), { force: true });
    return this.documents;
  }

  private async watch(): Promise<void> {
    while (!this.stopped) {
      const request = await this.nextRequest();
      if (request) {
        try {
          await this.answer(request.id, request.repo);
        } catch {
          await this.writeResponse(request.id, 'exit: 2\nswarmloop could not run it\n');
        }
        continue;
      }
      await delay(500);
    }
  }

  private async nextRequest(): Promise<{ id: string; repo: string } | null> {
    let files: string[];
    try {
      files = await readdir(this.dir);
    } catch {
      return null;
    }
    for (const file of files.filter((name) => name.endsWith('.req')).sort()) {
      const id = file.slice(0, -'.req'.length);
      const request = join(this.dir, file);
      try {
        if (!(await lstat(request)).isFile()) {
          await rm(request, { recursive: true, force: true });
          continue;
        }
      } catch {
        continue;
      }
      let body: string;
      try {
        body = await readFile(request, 'utf8');
      } catch {
        await rm(request, { recursive: true, force: true });
        continue;
      }
      const repo = body.endsWith('\n') ? body.slice(0, -1) : '';
      if (
        !REQUEST_ID.test(id) ||
        repo.includes('\n') ||
        (repo !== 'all' && !this.input.repos.some((item) => item.name === repo))
      ) {
        await rm(request, { recursive: true, force: true });
        continue;
      }
      await rm(request, { recursive: true, force: true });
      return { id, repo };
    }
    return null;
  }

  private async answer(id: string, requested: string): Promise<void> {
    if (this.calls >= this.input.maxCalls) {
      await this.writeResponse(id, `exit: 2\nverify call limit reached (${this.calls}): finish your work\n`);
      return;
    }
    this.calls += 1;
    this.running = true;
    this.deps.touch();
    const activity = setInterval(() => this.deps.touch(), 500);
    activity.unref();
    const repos = requested === 'all' ? this.input.repos : this.input.repos.filter((item) => item.name === requested);
    const log = createVerifyLog({
      clock: this.deps.clock,
      live: this.deps.live,
      root: this.deps.root,
      key: this.deps.key,
      label: `agent call ${this.calls} (${this.deps.step})`,
    });
    const results: { name: string; result: VerifyResult }[] = [];
    try {
      for (const repo of repos) {
        this.deps.touch();
        const result = await this.deps.verifier.run({
          runKey: this.deps.key,
          project: repo.name,
          worktree: repo.path,
          baseRef: this.input.baseRef,
          onOutput: (line) => {
            this.deps.touch();
            log.onOutput(line);
          },
        });
        results.push({ name: repo.name, result });
        if (result.status !== 'ok' && result.status !== 'skipped') {
          break;
        }
      }
    } finally {
      clearInterval(activity);
      this.running = false;
      this.deps.touch();
    }
    const failed = results.find((item) => item.result.status === 'failed');
    const error = results.find((item) => item.result.status === 'error');
    const exitCode = error ? 2 : failed ? 1 : 0;
    await log.finish(exitCode);
    if (exitCode === 0 && requested === 'all' && results.some((item) => item.result.status === 'ok')) {
      const commands = results
        .flatMap((item) => (item.result.status === 'ok' ? item.result.commands : []))
        .map((item) => item.command);
      const mounts: SandboxMount[] = this.input.repos.map((repo) => ({ hostPath: repo.path, containerPath: '' }));
      const record: VerifyRecord = {
        result: 'pass',
        snapshot: snapshotId(await worktreeSnapshot(mounts)),
        commands,
        exitCode: null,
        tail: '',
      };
      this.documents.push({ kind: 'verify_log', fileName: '', body: renderVerifyLog(record, 0) });
    }
    await this.writeResponse(id, response(exitCode, results));
  }

  private async writeResponse(id: string, body: string): Promise<void> {
    const file = join(this.dir, `${id}.res`);
    const temp = join(this.dir, `${id}.tmp`);
    const first = body.indexOf('\n') + 1;
    const text = body.length <= 6000 ? body : `${body.slice(0, first)}${body.slice(-(6000 - first))}`;
    await writeFile(temp, text);
    await rename(temp, file);
  }
}

function response(exitCode: number, results: { name: string; result: VerifyResult }[]): string {
  const lines = [`exit: ${exitCode}`];
  for (const { name, result } of results) {
    lines.push(`repo: ${name}`);
    if (result.status === 'skipped') {
      lines.push('skipped');
      continue;
    }
    for (const command of result.commands) {
      lines.push(`command: ${command.command}`, `exit: ${command.exitCode}`, command.tail);
    }
    if (result.message) {
      lines.push(result.message);
    }
  }
  return `${lines.join('\n')}\n`;
}
