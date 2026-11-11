import type { RunEntity } from '../../history/entities';
import type { BranchCheckout } from '../shared/branch-checkout';
import type { CheckoutService } from '../shared/checkout.service';
import type { PrepareStep } from './prepare.step';
import type { RemoteRepositories } from './remote-repositories.service';
import { ProjectAppendService } from './project-append.service';

describe('ProjectAppendService', () => {
  const prompt = 'branch: feature/PROJ-12-add-field\n';

  function harness(status: string, repos: string | null = null) {
    const run = { id: 7, key: 'PROJ-20', status, projects: 'billing-api\n', prompt } as RunEntity;
    const docs: { kind: string; body: string }[] = repos === null ? [] : [{ kind: 'repos', body: repos }];
    const stats: { step: string; status: string }[] = [];
    const runs = {
      findRun: jest.fn(async () => run),
      saveRun: jest.fn(async (saved: RunEntity) => {
        run.projects = saved.projects;
      }),
    };
    const documents = {
      latestBody: jest.fn(
        async (_key: string, kind: string) => [...docs].reverse().find((item) => item.kind === kind)?.body ?? null,
      ),
      putDocument: jest.fn(async (_run: RunEntity, kind: string, body: string) => {
        docs.push({ kind, body });
      }),
    };
    const visits = { listStats: jest.fn(async () => stats) };
    const prepare = { listProjects: () => ({ projects: ['billing-api', 'worker', 'handbook'] }) };
    const worktrees = { ensureDetached: jest.fn(async () => undefined) };
    const branch = { ensure: jest.fn(async () => undefined) };
    const remote = { offers: jest.fn(async (name: string) => name === 'fresh'), clone: jest.fn(async () => undefined) };
    const service = new ProjectAppendService(
      runs as never,
      documents as never,
      visits as never,
      prepare as unknown as PrepareStep,
      worktrees as unknown as CheckoutService,
      branch as unknown as BranchCheckout,
      remote as unknown as RemoteRepositories,
    );
    return { run, docs, stats, worktrees, branch, remote, service };
  }

  it('prepares only the new worktree and leaves the feature branch for later', async () => {
    const { run, docs, worktrees, branch, service } = harness('waiting');
    const result = await service.add('PROJ-20', 'handbook');
    expect(result).toEqual({ projects: ['billing-api', 'handbook'], applied: true });
    expect(worktrees.ensureDetached).toHaveBeenCalledWith(run, ['handbook'], prompt, false);
    expect(branch.ensure).not.toHaveBeenCalled();
    expect(run.projects).toBe('billing-api\nhandbook\n');
    const note = docs.filter((item) => item.kind === 'added_repos').at(-1)?.body ?? '';
    expect(note).toContain('/work/handbook');
    expect(note).toContain("Write this task's contract changes there");
  });

  it('clones a repository of a connected host before it prepares the worktree', async () => {
    const { run, remote, worktrees, service } = harness('waiting');
    run.startedBy = 'ana';
    const order: string[] = [];
    remote.clone.mockImplementation(async () => void order.push('clone'));
    worktrees.ensureDetached.mockImplementation(async () => void order.push('worktree'));
    const result = await service.add('PROJ-20', 'fresh');
    expect(result.projects).toEqual(['billing-api', 'fresh']);
    expect(remote.clone).toHaveBeenCalledWith('fresh', 'ana');
    expect(order).toEqual(['clone', 'worktree']);
  });

  it('does not clone a local checkout, and still refuses a name no host offers', async () => {
    const { remote, service } = harness('waiting');
    await service.add('PROJ-20', 'handbook');
    expect(remote.clone).not.toHaveBeenCalled();
    await expect(service.add('PROJ-20', 'nowhere')).rejects.toThrow('nowhere is not a checkout');
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
    expect(branch.ensure).toHaveBeenCalledWith('PROJ-20', 'handbook', null, false);
  });

  it('waits until the running step closes, then prepares the worktree', async () => {
    const { run, docs, worktrees, service } = harness('running');
    const result = await service.add('PROJ-20', 'handbook');
    expect(result.applied).toBe(false);
    expect(worktrees.ensureDetached).not.toHaveBeenCalled();
    expect(docs.filter((item) => item.kind === 'pending_repos').at(-1)?.body).toBe('handbook\n');
    run.status = 'waiting';
    await service.flush('PROJ-20');
    expect(worktrees.ensureDetached).toHaveBeenCalledTimes(1);
    expect(docs.filter((item) => item.kind === 'pending_repos').at(-1)?.body).toBe('');
  });
});
