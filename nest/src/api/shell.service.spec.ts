import { HistoryService } from '../history/history.service';
import { RunEntity } from '../history/entities';
import { SandboxService } from '../sandbox/sandbox.service';
import { ShellService } from './shell.service';

describe('shell open', () => {
  it('creates one waiting feature and does not start the pipeline', async () => {
    const notes: string[] = [];
    const runs: RunEntity[] = [];
    const history = {
      root: () => '/tmp/swarmloop',
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
      noteFlow: async (key: string) => {
        notes.push(`flow ${key}`);
      },
      latestBody: async () => null,
    };
    const sandbox = { containerExists: async () => false };
    const service = new ShellService(history as unknown as HistoryService, sandbox as unknown as SandboxService);
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
    const history = {
      root: () => '/tmp/swarmloop',
      listRuns: async () => [
        { key: 'PROJ-1', targetPath: '/tmp/demo', status: 'waiting', currentStep: 'requirements' },
        { key: 'PROJ-2', targetPath: '/tmp', status: 'waiting', currentStep: 'plan' },
      ],
      openWaiting: async () => {
        notes.push('open');
        return {} as RunEntity;
      },
    };
    const service = new ShellService(history as unknown as HistoryService, {} as SandboxService);
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
