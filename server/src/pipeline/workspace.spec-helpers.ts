import { mkdirSync, mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';
import { RunEntity } from '../history/entities';
import { DocumentRepository } from '../history/document.repository';
import { RunRepository } from '../history/run.repository';
import { writeRunState } from '../history/run-state';
import { BranchCheckout } from '../steps/shared/branch-checkout';
import { CheckoutService } from '../steps/shared/checkout.service';
import { boot, commitFile, git, repoWithMain, seedRequirements } from '../steps/prepare/prepare.step.spec-helpers';

export const DAY_MS = 86_400_000;

/** A run of one project `demo` whose worktree was prepared on its branch, with one commit that is also published. */
export interface World {
  app: TestingModule;
  swarm: string;
  parent: string;
  clone: string;
  remote: string;
  key: string;
  branch: string;
  worktree: string;
  /** The commit the branch was published at. */
  sha: string;
}

/**
 * `origin: 'github'` points origin at a host that cannot be fetched after the push, so the published commit is
 * matched to the repo through `pipeline_ref` and `origin/<branch>` is never there.
 */
export async function makeWorld(key: string, origin: 'path' | 'github' = 'path'): Promise<World> {
  const parent = mkdtempSync(join(tmpdir(), 'swarmloop-workspace-'));
  const swarm = join(parent, 'swarm');
  mkdirSync(swarm);
  const clone = repoWithMain(parent, 'demo');
  const remote = join(parent, 'demo.git');
  const app = await boot(swarm, '..');
  await seedRequirements(app, key);
  const documents = app.get(DocumentRepository);
  const run = (await app.get(RunRepository).findRun(key))!;
  const requirements = `${JSON.stringify({ prompt: 'ship the field', tickets: [] })}\n`;
  await documents.putDocument(run, 'requirements', requirements);
  const branch = app.get(BranchCheckout).branchFor(key, requirements);
  await app.get(CheckoutService).prepareCheckout(key, { name: 'demo', path: '' }, null);
  const worktree = join(swarm, 'worktrees', key, 'demo');
  git(worktree, ['switch', '-c', branch]);
  commitFile(worktree, 'feature.txt', 'feature\n', 'feature');
  git(worktree, ['push', 'origin', branch]);
  const sha = git(worktree, ['rev-parse', 'HEAD']);
  if (origin === 'github') {
    git(clone, ['remote', 'set-url', 'origin', 'git@github.com:acme/demo.git']);
  }
  await documents.putDocument(run, 'repos', 'demo\n');
  await documents.putDocument(run, 'pipeline_ref', `project: acme/demo\nref: ${branch}\nsha: ${sha}\n`);
  return { app, swarm, parent, clone, remote, key, branch, worktree, sha };
}

/** What retention leaves: the worktree is removed the way retention removes it, and the run is flagged. */
export async function clean(world: World): Promise<void> {
  const checkout = { name: 'demo', path: world.clone };
  await world.app.get(CheckoutService).removeWorktree(checkout, world.worktree);
  await world.app.get(RunRepository).markWorkspaceRemoved(world.key);
}

export async function freshRun(world: World): Promise<RunEntity> {
  return (await world.app.get(RunRepository).findRun(world.key))!;
}

/** Sets the status of an existing run and makes it `days` old. */
export async function ageRun(app: TestingModule, key: string, status: string, days: number): Promise<RunEntity> {
  const runs = app.get(RunRepository);
  const run = (await runs.findRun(key))!;
  writeRunState(run, { status, ownerPid: null, activeAttempt: null });
  await runs.saveRun(run);
  const table = app.get<Repository<RunEntity>>(getRepositoryToken(RunEntity));
  await table.update({ key }, { updatedAt: new Date(Date.now() - days * DAY_MS).toISOString() });
  return (await runs.findRun(key))!;
}

/** A new run in `status`, last changed `days` ago. */
export async function seedRun(app: TestingModule, key: string, status: string, days: number): Promise<RunEntity> {
  await app.get(RunRepository).begin(key, 'implement');
  return ageRun(app, key, status, days);
}

/** Files that a finished run leaves in `data/`: its agent state, one attempt output and its stored chat id. */
export function leaveFiles(swarm: string, key: string): { state: string; output: string; session: string } {
  const data = join(swarm, 'data');
  const state = join(data, 'agent-state', key, 'implement');
  mkdirSync(state, { recursive: true });
  writeFileSync(join(state, 'chat.db'), 'chat\n');
  const output = join(data, `${key}-implement-attempt1-output.txt`);
  const session = join(data, `${key}-implement-session.json`);
  writeFileSync(output, 'out\n');
  writeFileSync(session, '{"chatId":"c1"}\n');
  return { state, output, session };
}
