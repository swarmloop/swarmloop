import { RunEntity } from '../../history/entities';
import { BranchService } from '../branch/branch.service';
import { PrepareService } from './prepare.service';
import { ProjectAppendService } from './project-append.service';

describe('ProjectAppendService', () => {
  const prompt = 'branch: feature/PROJ-12-add-field\n';

  function harness(status: string, repos: string | null = null) {
    const run = { id: 7, key: 'PROJ-20', status, projects: 'billing-api\n', prompt } as RunEntity;
    const docs: { kind: string; body: string }[] = repos === null ? [] : [{ kind: 'repos', body: repos }];
    const stats: { step: string; status: string }[] = [];
    const history = {
      findRun: jest.fn(async () => run),
      latestBody: jest.fn(async (_key: string, kind: string) => [...docs].reverse().find((item) => item.kind === kind)?.body ?? null),
      putDocument: jest.fn(async (_run: RunEntity, kind: string, body: string) => {
        docs.push({ kind, body });
      }),
      saveRun: jest.fn(async (saved: RunEntity) => {
        run.projects = saved.projects;
      }),
      listStats: jest.fn(async () => stats),
    };
    const prepare = { listProjects: () => ({ projects: ['billing-api', 'worker', 'handbook'] }), ensureDetached: jest.fn(async () => undefined) };
    const branch = { ensure: jest.fn(async () => undefined) };
    const service = new ProjectAppendService(history as never, prepare as unknown as PrepareService, branch as unknown as BranchService);
    return { run, docs, stats, prepare, branch, service };
  }

  it('prepares only the new worktree and leaves the feature branch for later', async () => {
    const { run, docs, prepare, branch, service } = harness('waiting');
    const result = await service.add('PROJ-20', 'handbook');
    expect(result).toEqual({ projects: ['billing-api', 'handbook'], applied: true });
    expect(prepare.ensureDetached).toHaveBeenCalledWith(run, ['handbook'], prompt, false);
    expect(branch.ensure).not.toHaveBeenCalled();
    expect(run.projects).toBe('billing-api\nhandbook\n');
    const note = docs.filter((item) => item.kind === 'added_repos').at(-1)?.body ?? '';
    expect(note).toContain('/work/handbook');
    expect(note).toContain("Write this task's contract changes there");
  });

  it('keeps every added repository in the note', async () => {
    const { docs, service } = harness('waiting');
    await service.add('PROJ-20', 'handbook');
    await service.add('PROJ-20', 'worker');
    const note = docs.filter((item) => item.kind === 'added_repos').at(-1)?.body ?? '';
    expect(note).toContain('/work/handbook');
    expect(note).toContain('/work/worker');
  });

  it('appends the new name to the repos document', async () => {
    const { docs, service } = harness('waiting', 'billing-api\n');
    await service.add('PROJ-20', 'handbook');
    expect(docs.filter((item) => item.kind === 'repos').at(-1)?.body).toBe('billing-api\nhandbook\n');
  });

  it('checks out the feature branch when branch already finished', async () => {
    const { stats, branch, service } = harness('waiting', 'billing-api\n');
    stats.push({ step: 'branch', status: 'done' });
    await service.add('PROJ-20', 'handbook');
    expect(branch.ensure).toHaveBeenCalledWith('PROJ-20', 'handbook');
  });

  it('waits until the running step closes, then prepares the worktree', async () => {
    const { run, docs, prepare, service } = harness('running');
    const result = await service.add('PROJ-20', 'handbook');
    expect(result.applied).toBe(false);
    expect(prepare.ensureDetached).not.toHaveBeenCalled();
    expect(docs.filter((item) => item.kind === 'pending_repos').at(-1)?.body).toBe('handbook\n');
    run.status = 'waiting';
    await service.flush('PROJ-20');
    expect(prepare.ensureDetached).toHaveBeenCalledTimes(1);
    expect(docs.filter((item) => item.kind === 'pending_repos').at(-1)?.body).toBe('');
  });
});
