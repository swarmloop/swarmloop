import 'reflect-metadata';
import { writeFileSync } from 'fs';
import { mkdtemp } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { RunRepository } from '../../history/run.repository';
import { DocumentRepository } from '../../history/document.repository';
import { FlowRepository } from '../../history/flow.repository';
import { PipelineService } from '../../pipeline/pipeline.service';
import { CI_SKIPPED } from './commit.step';
import { NOT_DELIVERED } from './commit-delivered';
import { boot, featureTree, git, hostPush, seed } from './commit.step.spec-helpers';

describe('commit step on a clean tree', () => {
  it('finishes when the branch already matches origin', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-commit-published-'));
    const tree = featureTree(root, 'PROJ-114');
    writeFileSync(join(tree, 'src', 'field.ts'), 'export const field = 1;\n');
    git(tree, ['add', 'src/field.ts']);
    git(tree, ['commit', '-m', 'already']);
    git(tree, ['push', '-u', 'origin', 'feature/PROJ-114-ship-the-field']);
    const app = await boot(root);
    try {
      await seed(app, 'PROJ-114');
      const documents = app.get(DocumentRepository);
      const before = await documents.latestBody('PROJ-114', 'pipeline_ref');
      const done = await app.get(PipelineService).step('commit', 'PROJ-114');
      expect(done.exitCode).toBe(0);
      expect(done.message).toContain('commit done');
      expect(done.message).not.toContain('nothing to commit');
      expect(done.message).not.toContain(CI_SKIPPED);
      expect(await documents.latestBody('PROJ-114', 'ci_skip')).toBeNull();
      expect(await documents.latestBody('PROJ-114', 'pipeline_ref')).toBe(before);
      expect(git(tree, ['rev-list', '--count', 'HEAD'])).toBe('2');
    } finally {
      await app.close();
    }
  });

  it('pushes an empty Re-run CI commit when a ci_rerun is pending and the tree is clean', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-commit-rerun-'));
    const tree = featureTree(root, 'PROJ-130');
    const branch = 'feature/PROJ-130-ship-the-field';
    const bare = join(root, 'demo.git');
    const token = 'rerun-token';
    git(tree, ['push', '-u', 'origin', branch]);
    const old = git(tree, ['rev-parse', 'HEAD']);
    git(tree, ['remote', 'set-url', 'origin', 'git@gitlab.example:group/demo.git']);
    const restore = hostPush(bare, token);
    try {
      const app = await boot(root, 'gitlab', { baseUrl: 'https://gitlab.example', token });
      try {
        await seed(app, 'PROJ-130', 'gitlab');
        const runs = app.get(RunRepository);
        const documents = app.get(DocumentRepository);
        const seeded = await runs.findRun('PROJ-130');
        await documents.putDocument(seeded!, 'ci_rerun', `demo ${old} -> ${old}\n`);
        const pushed = await app.get(PipelineService).step('commit', 'PROJ-130');
        expect(pushed.exitCode).toBe(0);
        expect(git(tree, ['rev-list', '--count', 'HEAD'])).toBe('2');
        expect(git(tree, ['log', '-1', '--format=%s'])).toBe('Re-run CI');
        const head = git(tree, ['rev-parse', 'HEAD']);
        expect(git(bare, ['rev-parse', `refs/heads/${branch}`])).toBe(head);
        expect(await documents.latestBody('PROJ-130', 'pipeline_ref')).toContain(`sha: ${head}`);
        expect(await documents.latestBody('PROJ-130', 'commit')).toContain(`demo ${head}`);
        const again = await app.get(PipelineService).step('commit', 'PROJ-130');
        expect(again.exitCode).toBe(0);
        expect(git(tree, ['rev-list', '--count', 'HEAD'])).toBe('2');
      } finally {
        await app.close();
      }
    } finally {
      restore();
    }
  });

  it('pushes an unpublished HEAD without an empty commit when a ci_rerun is pending', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-commit-rerun-ahead-'));
    const tree = featureTree(root, 'PROJ-131');
    const branch = 'feature/PROJ-131-ship-the-field';
    const bare = join(root, 'demo.git');
    writeFileSync(join(tree, 'src', 'field.ts'), 'export const field = 1;\n');
    git(tree, ['add', 'src/field.ts']);
    git(tree, ['commit', '-m', 'already']);
    const app = await boot(root);
    try {
      await seed(app, 'PROJ-131');
      const runs = app.get(RunRepository);
      const documents = app.get(DocumentRepository);
      const seeded = await runs.findRun('PROJ-131');
      await documents.putDocument(seeded!, 'ci_rerun', 'demo old -> new\n');
      const pushed = await app.get(PipelineService).step('commit', 'PROJ-131');
      expect(pushed.exitCode).toBe(0);
      expect(git(tree, ['rev-list', '--count', 'HEAD'])).toBe('2');
      expect(git(tree, ['log', '-1', '--format=%s'])).toBe('already');
      expect(git(bare, ['rev-parse', `refs/heads/${branch}`])).toBe(git(tree, ['rev-parse', 'HEAD']));
    } finally {
      await app.close();
    }
  });

  it('checks ahead against the branch the prompt names, not against the default branch', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-commit-named-base-'));
    const tree = featureTree(root, 'PROJ-133');
    writeFileSync(join(tree, 'src', 'field.ts'), 'export const field = 1;\n');
    git(tree, ['add', 'src/field.ts']);
    git(tree, ['commit', '-m', 'parent work']);
    git(tree, ['push', 'origin', 'HEAD:refs/heads/feature/PARENT-1-epic']);
    const app = await boot(root);
    try {
      await seed(app, 'PROJ-133');
      const runs = app.get(RunRepository);
      await runs.saveRun({ ...(await runs.findRun('PROJ-133'))!, prompt: 'task\nbranch: feature/PARENT-1-epic\n' });
      const done = await app.get(PipelineService).step('commit', 'PROJ-133');
      expect(done.exitCode).toBe(0);
      expect((await runs.findRun('PROJ-133'))?.currentStep).toBe('implement');
      expect(await app.get(DocumentRepository).latestBody('PROJ-133', 'issues')).toContain(NOT_DELIVERED);
    } finally {
      await app.close();
    }
  });

  it('returns to implement with the issue when a clean tree has no review that found the behavior', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-commit-clean-'));
    const tree = featureTree(root, 'PROJ-132');
    const app = await boot(root);
    try {
      await seed(app, 'PROJ-132');
      const done = await app.get(PipelineService).step('commit', 'PROJ-132');
      expect(done.exitCode).toBe(0);
      expect(done.message).not.toContain('nothing to commit');
      const run = await app.get(RunRepository).findRun('PROJ-132');
      expect(run?.currentStep).toBe('implement');
      expect(run?.status).toBe('waiting');
      expect(await app.get(DocumentRepository).latestBody('PROJ-132', 'issues')).toContain(NOT_DELIVERED);
      expect(git(tree, ['rev-list', '--count', 'HEAD'])).toBe('1');
    } finally {
      await app.close();
    }
  });

  it('returns to implement when a reviewer returned the unchanged tree', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-commit-returned-'));
    featureTree(root, 'PROJ-134');
    const app = await boot(root);
    try {
      await seed(app, 'PROJ-134');
      await putReviews(
        app,
        'PROJ-134',
        'decision: ok\n- met: 1. Ship the field (src/field.ts)\n',
        'decision: return\n',
      );
      await app.get(PipelineService).step('commit', 'PROJ-134');
      expect((await app.get(RunRepository).findRun('PROJ-134'))?.currentStep).toBe('implement');
    } finally {
      await app.close();
    }
  });

  it('ends done with no merge request when the review says where the behavior already is', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-commit-delivered-'));
    featureTree(root, 'PROJ-135');
    const app = await boot(root);
    try {
      await seed(app, 'PROJ-135');
      await putReviews(app, 'PROJ-135', 'decision: ok\n- met: 1. Ship the field (src/readme.ts)\n', 'decision: ok\n');
      const done = await app.get(PipelineService).step('commit', 'PROJ-135');
      expect(done.exitCode).toBe(0);
      expect(done.message).toContain('already delivered: src/readme.ts');
      const run = await app.get(RunRepository).findRun('PROJ-135');
      expect(run?.status).toBe('done');
      expect(await app.get(DocumentRepository).latestBody('PROJ-135', 'commit')).toBe(
        'already delivered: src/readme.ts\n',
      );
      expect(await app.get(DocumentRepository).latestBody('PROJ-135', 'merge_request')).toBeNull();
    } finally {
      await app.close();
    }
  });

  it('ends done when the met lines are only in the stored review result', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-commit-delivered-result-'));
    featureTree(root, 'PROJ-137');
    const app = await boot(root);
    try {
      await seed(app, 'PROJ-137');
      await putResults(app, 'PROJ-137', {
        summary: ['met: 1. Ship the field — in src/readme.ts'],
        met: ['src/readme.ts'],
      });
      const done = await app.get(PipelineService).step('commit', 'PROJ-137');
      expect(done.message).toContain('already delivered: src/readme.ts');
    } finally {
      await app.close();
    }
  });

  it('does not read a location out of the summary lines of a stored review result', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-commit-delivered-prose-'));
    featureTree(root, 'PROJ-138');
    const app = await boot(root);
    try {
      await seed(app, 'PROJ-138');
      await putResults(app, 'PROJ-138', { summary: ['met: 1. Ship the field (src/readme.ts)'] });
      await app.get(PipelineService).step('commit', 'PROJ-138');
      expect((await app.get(RunRepository).findRun('PROJ-138'))?.currentStep).toBe('implement');
      expect(await app.get(DocumentRepository).latestBody('PROJ-138', 'issues')).toContain(NOT_DELIVERED);
    } finally {
      await app.close();
    }
  });

  it('ends done on a clean tree without CI when the review says where the behavior already is', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-commit-delivered-nociy-'));
    featureTree(root, 'PROJ-136');
    const app = await boot(root);
    try {
      await seed(app, 'PROJ-136');
      const runs = app.get(RunRepository);
      const seeded = (await runs.findRun('PROJ-136'))!;
      await app.get(FlowRepository).noteFlow('PROJ-136', ['code-review'], 'commit');
      await putReviews(app, 'PROJ-136', 'decision: ok\n- met: 1. Ship the field (src/readme.ts)\n', 'decision: ok\n');
      const done = await app.get(PipelineService).step('commit', seeded.key);
      expect(done.message).toContain('already delivered: src/readme.ts');
    } finally {
      await app.close();
    }
  });
});

/** A passing requirements review and a passing quality review, stored as results only. */
async function putResults(
  app: Awaited<ReturnType<typeof boot>>,
  key: string,
  requirements: { summary: string[]; met?: string[] },
): Promise<void> {
  const run = (await app.get(RunRepository).findRun(key))!;
  const documents = app.get(DocumentRepository);
  const result = (value: object) => `${JSON.stringify({ decision: 'ok', review: 'Checked.', ...value })}\n`;
  await documents.putDocument(run, 'review_requirements_result', result(requirements));
  await documents.putDocument(run, 'review_quality_result', result({ summary: ['clear'] }));
}

async function putReviews(
  app: Awaited<ReturnType<typeof boot>>,
  key: string,
  requirements: string,
  quality: string,
): Promise<void> {
  const run = (await app.get(RunRepository).findRun(key))!;
  const documents = app.get(DocumentRepository);
  await documents.putDocument(run, 'review_requirements', requirements);
  await documents.putDocument(run, 'review_quality', quality);
}
