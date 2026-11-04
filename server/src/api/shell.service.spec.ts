import type { AppConfig } from '../config/env';
import type { RunEntity } from '../history/entities';
import type { DocumentRepository } from '../history/document.repository';
import type { FlowRepository } from '../history/flow.repository';
import type { RunRepository } from '../history/run.repository';
import type { VisitRepository } from '../history/visit.repository';
import type { SandboxService } from '../sandbox/sandbox.service';
import { FakeClock } from '../core/fake-clock.spec-helpers';
import { ShellService } from './shell.service';

const config = { env: { SWARMLOOP_ROOT: '/tmp/swarmloop' } } as unknown as AppConfig;

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
    );
    const created = await service.open('/tmp/demo');
    expect(created).toMatchObject({ created: true, status: 'waiting', currentStep: 'requirements' });
    expect(notes[0]).toBe('open /tmp/demo');
    expect(notes[1]).toMatch(/^flow /);
    const again = await service.open('/tmp/demo');
    expect(again).toMatchObject({ created: false, key: (created as { key: string }).key });
    expect(notes.filter((note) => note.startsWith('open'))).toHaveLength(1);
  });

  it('lists several matches and creates nothing', async () => {
    const notes: string[] = [];
    const runRepository = {
      listRuns: async () => [
        { key: 'PROJ-1', targetPath: '/tmp/demo', status: 'waiting', currentStep: 'requirements' },
        { key: 'PROJ-2', targetPath: '/tmp', status: 'waiting', currentStep: 'plan' },
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
    );
    const result = await service.open('/tmp/demo');
    expect(result).toEqual({
      matches: [
        { key: 'PROJ-1', status: 'waiting', currentStep: 'requirements' },
        { key: 'PROJ-2', status: 'waiting', currentStep: 'plan' },
      ],
    });
    expect(notes).toEqual([]);
  });
});
