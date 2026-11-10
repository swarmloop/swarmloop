import { basename } from 'path';
import { AppConfig } from '../config/env';
import { testEnv } from '../config/env.spec-helpers';
import { FakeClock } from '../core/fake-clock.spec-helpers';
import { makeRepo, runGit, commitFiles } from '../git/git-repo.spec-helpers';
import type { RunEntity } from '../history/entities';
import type { DocumentRepository } from '../history/document.repository';
import type { SandboxService } from '../sandbox/sandbox.service';
import { EnvironmentService } from './environment.service';

describe('rebase environment refresh', () => {
  it('adopts the trusted base manifest instead of feature edits and drops old setup state', async () => {
    const manifest = { version: 1, image: 'node:22', checks: ['npm test'] };
    const repo = makeRepo({ '.swarmloop.json': JSON.stringify(manifest) });
    const base = runGit(repo, ['rev-parse', 'HEAD']).trim();
    runGit(repo, ['update-ref', 'refs/remotes/origin/main', base]);
    commitFiles(repo, { '.swarmloop.json': JSON.stringify({ ...manifest, checks: ['true'] }) });
    runGit(repo, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);
    const stored = new Map<string, string>();
    const documents = {
      latestBody: async (_key: string, kind: string) => stored.get(kind) ?? null,
      putDocument: async (_run: RunEntity, kind: string, body: string) => {
        stored.set(kind, body);
      },
    };
    const service = new EnvironmentService(
      new AppConfig(testEnv()),
      new FakeClock(),
      {} as SandboxService,
      documents as unknown as DocumentRepository,
    );
    const run = { key: 'run', prompt: '' } as RunEntity;
    const bases = new Map([[basename(repo), base]]);
    await service.refreshAfterRebase(run, [{ hostPath: repo, containerPath: '/work' }], bases);
    const record = JSON.parse(stored.get(`environment:${basename(repo)}`)!);
    expect(record.ref).toBe(base);
    expect(record.config.checks).toEqual(['npm test']);
    expect(record.setup).toBeUndefined();
    record.setup = { exitCode: 0 };
    stored.set(`environment:${basename(repo)}`, JSON.stringify(record));
    await service.refreshAfterRebase(run, [{ hostPath: repo, containerPath: '/work' }], bases);
    expect(JSON.parse(stored.get(`environment:${basename(repo)}`)!).setup).toEqual({ exitCode: 0 });
    runGit(repo, ['rm', '.swarmloop.json']);
    runGit(repo, ['commit', '-m', 'remove environment']);
    const removed = runGit(repo, ['rev-parse', 'HEAD']).trim();
    await service.refreshAfterRebase(run, [{ hostPath: repo, containerPath: '/work' }], new Map());
    expect(JSON.parse(stored.get(`environment:${basename(repo)}`)!).ref).toBe(base);
    await service.refreshAfterRebase(
      run,
      [{ hostPath: repo, containerPath: '/work' }],
      new Map([[basename(repo), removed]]),
    );
    expect(stored.get(`environment:${basename(repo)}`)).toBe('null');
    expect(
      await service.prepare({
        run,
        key: run.key,
        step: 'implement',
        runtime: 'codex',
        mounts: [{ hostPath: repo, containerPath: '/work' }],
      }),
    ).toBeNull();
  });
});
