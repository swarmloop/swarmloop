import { mkdirSync, mkdtempSync, realpathSync, symlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { SwarmloopError } from '../core/swarmloop-error';
import type { AppConfig } from '../config/env';
import type { RunEntity } from '../history/entities';
import type { DocumentRepository } from '../history/document.repository';
import type { FlowRepository } from '../history/flow.repository';
import type { RunRepository } from '../history/run.repository';
import type { VisitRepository } from '../history/visit.repository';
import type { SandboxService } from '../sandbox/sandbox.service';
import { FakeClock } from '../core/fake-clock.spec-helpers';
import type { WorkspaceGuard } from '../pipeline/workspace-guard';
import { ShellService } from './shell.service';

const base = realpathSync(mkdtempSync(join(tmpdir(), 'swarmloop-shell-')));
const checkouts = join(base, 'checkouts');
const demo = join(checkouts, 'demo');
const other = join(checkouts, 'other');
mkdirSync(join(demo, '.git'), { recursive: true });
mkdirSync(join(other, '.git'), { recursive: true });
mkdirSync(join(base, 'private'));
symlinkSync(join(base, 'private'), join(demo, 'escape'));
const config = {
  env: { SWARMLOOP_ROOT: join(base, 'swarmloop'), CHECKOUTS_ROOT: checkouts, SWARMLOOP_REPOS: [] },
} as unknown as AppConfig;

describe('shell open', () => {
  it('creates one waiting feature and does not start the pipeline', async () => {
    const notes: string[] = [];
    const runs: RunEntity[] = [];
    const runRepository = {
      listRuns: async () => runs,
      openWaiting: async (key: string, targetPath: string) => {
        notes.push(`open ${targetPath}`);
        const run = {
          id: 1,
          key,
          targetPath,
          status: 'waiting',
          currentStep: 'requirements',
          runtime: 'cursor',
        } as RunEntity;
        runs.push(run);
        return run;
      },
    };
    const flowRepository = {
      noteFlow: async (key: string) => {
        notes.push(`flow ${key}`);
      },
    };
    const documentRepository = { latestBody: async () => null };
    const sandbox = { containerExists: async () => false };
    const service = new ShellService(
      runRepository as unknown as RunRepository,
      documentRepository as unknown as DocumentRepository,
      {} as VisitRepository,
      flowRepository as unknown as FlowRepository,
      config,
      sandbox as unknown as SandboxService,
      new FakeClock(),
      { ensureForRequest: async () => undefined } as unknown as WorkspaceGuard,
    );
    const created = await service.open(demo);
    expect(created).toMatchObject({ created: true, status: 'waiting', currentStep: 'requirements' });
    expect(notes[0]).toBe(`open ${demo}`);
    expect(notes[1]).toMatch(/^flow /);
    const again = await service.open(demo);
    expect(again).toMatchObject({ created: false, key: (created as { key: string }).key });
    expect(notes.filter((note) => note.startsWith('open'))).toHaveLength(1);
  });

  it('lists several matches and creates nothing', async () => {
    const notes: string[] = [];
    const runRepository = {
      listRuns: async () => [
        { key: 'PROJ-1', targetPath: demo, status: 'waiting', currentStep: 'requirements' },
        { key: 'PROJ-2', targetPath: checkouts, status: 'waiting', currentStep: 'plan' },
      ],
      openWaiting: async () => {
        notes.push('open');
        return {} as RunEntity;
      },
    };
    const service = new ShellService(
      runRepository as unknown as RunRepository,
      {} as DocumentRepository,
      {} as VisitRepository,
      {} as FlowRepository,
      config,
      {} as SandboxService,
      new FakeClock(),
      { ensureForRequest: async () => undefined } as unknown as WorkspaceGuard,
    );
    const result = await service.open(demo);
    expect(result).toEqual({
      matches: [
        { key: 'PROJ-1', status: 'waiting', currentStep: 'requirements' },
        { key: 'PROJ-2', status: 'waiting', currentStep: 'plan' },
      ],
    });
    expect(notes).toEqual([]);
  });
});

describe('shell lock', () => {
  function lockService(calls: string[]): ShellService {
    const run = { id: 1, key: 'proj-1', status: 'waiting', currentStep: 'plan', targetPath: null } as RunEntity;
    const runRepository = {
      findRun: async () => run,
      claim: async (key: string, step: string) => {
        calls.push(`claim ${key} ${step}`);
        return { ...run, status: 'running' };
      },
    };
    const documentRepository = {
      latestBody: async () => null,
      putDocument: async (_run: RunEntity, kind: string) => {
        calls.push(`document ${kind}`);
      },
    };
    return new ShellService(
      runRepository as unknown as RunRepository,
      documentRepository as unknown as DocumentRepository,
      {} as VisitRepository,
      {} as FlowRepository,
      config,
      { containerExists: async () => false } as unknown as SandboxService,
      new FakeClock(),
      { ensureForRequest: async () => undefined } as unknown as WorkspaceGuard,
    );
  }

  it('holds the run with a claim after it writes the lock', async () => {
    const calls: string[] = [];

    const locked = await lockService(calls).lock('proj-1', 'proj-1-shell');

    expect(locked).toEqual({ status: 'running' });
    expect(calls).toEqual(['document chat_lock', 'claim proj-1 plan']);
  });

  it('answers 409 when another writer took the run first', async () => {
    const service = lockService([]);
    jest
      .spyOn((service as unknown as { runs: RunRepository }).runs, 'claim')
      .mockRejectedValue(new SwarmloopError('proj-1 is already running'));

    await expect(service.lock('proj-1', 'proj-1-shell')).rejects.toBeInstanceOf(ConflictException);
  });

  it('finds the run of a path without writing, and names a new key when none matches', async () => {
    const runs: RunEntity[] = [{ id: 1, key: 'proj-1', targetPath: demo } as RunEntity];
    const service = new ShellService(
      { listRuns: async () => runs } as unknown as RunRepository,
      {} as DocumentRepository,
      {} as VisitRepository,
      {} as FlowRepository,
      config,
      {} as SandboxService,
      new FakeClock(),
      { ensureForRequest: async () => undefined } as unknown as WorkspaceGuard,
    );

    expect(await service.locate(demo)).toEqual({ key: 'proj-1', cwd: demo, created: false });
    expect(await service.locate(other)).toMatchObject({ cwd: other, created: true });
  });

  it('refuses a path outside the repositories and through a symlink, and writes nothing', async () => {
    const notes: string[] = [];
    const service = new ShellService(
      {
        listRuns: async () => [],
        openWaiting: async () => {
          notes.push('open');
          return {} as RunEntity;
        },
      } as unknown as RunRepository,
      {} as DocumentRepository,
      {} as VisitRepository,
      { noteFlow: async () => notes.push('flow') } as unknown as FlowRepository,
      config,
      {} as SandboxService,
      new FakeClock(),
      { ensureForRequest: async () => undefined } as unknown as WorkspaceGuard,
    );

    for (const path of [base, '/etc', join(base, 'private'), join(demo, 'escape')]) {
      await expect(service.locate(path)).rejects.toBeInstanceOf(BadRequestException);
      await expect(service.open(path)).rejects.toBeInstanceOf(BadRequestException);
    }
    expect(notes).toEqual([]);
  });
});
