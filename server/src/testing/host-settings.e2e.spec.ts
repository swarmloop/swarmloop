import { existsSync } from 'fs';
import { join } from 'path';
import { GitRuleRefused } from '../core/git-rule-refused';
import { git } from './git-fixture';
import { FakeBacklogHost } from './fake-backlog-host';
import { createFlowHarness } from './flow-harness';

const TEMPLATE = '.gitlab/merge_request_templates/Default.md';

describe('fake host settings through the flow harness', () => {
  it('answers the allowed methods, the author and the title rule it is set to', async () => {
    const harness = await createFlowHarness('F61-2', {
      fakeHost: {
        mergeMethods: ['merge'],
        author: 'none',
        title: { pattern: '^(feat|fix): ', message: 'title must be conventional' },
      },
    });
    try {
      expect((await harness.host.readMergeMethods()).methods).toEqual(['merge']);
      expect(await harness.host.readAuthor('robin')).toMatchObject({ name: null, email: null });
      const draft = { project: 'group/demo', source: 'x', target: 'main', title: 'ship', summary: '', draft: false };
      await expect(harness.host.openMergeRequest(draft)).rejects.toBeInstanceOf(GitRuleRefused);
      await expect(harness.host.mergeMergeRequest('group/demo', 1)).rejects.toThrow('does not allow a squash merge');
    } finally {
      await harness.close();
    }
  });

  it('answers the no-reply address and all three methods by default', async () => {
    const harness = await createFlowHarness('F61-3');
    try {
      expect((await harness.host.readMergeMethods()).methods).toEqual(['squash', 'rebase', 'merge']);
      expect((await harness.host.readAuthor('robin')).email).toBe('1+robin@users.noreply.gitlab.example');
      const { host, tree } = harness;
      const draft = {
        project: 'group/demo',
        source: 'feature/F61-3-x',
        target: 'main',
        title: 't',
        summary: '',
        draft: false,
      };
      git(tree, ['checkout', '-b', draft.source]);
      git(tree, ['commit', '--allow-empty', '-m', 'feat: first']);
      git(tree, ['commit', '--allow-empty', '-m', 'feat: second']);
      git(tree, ['push', 'origin', draft.source]);
      await host.openMergeRequest(draft);
      const merged = await host.mergeMergeRequest('group/demo', 1, undefined, { method: 'merge', title: 'feat: x' });
      const bare = join(harness.app.root, 'demo.git');
      expect(git(bare, ['log', '-1', '--format=%s', merged.sha])).toBe('feat: x');
      expect(git(bare, ['log', '-1', '--format=%P', merged.sha]).split(' ')).toHaveLength(2);
    } finally {
      await harness.close();
    }
  });

  it('writes the repository files, and the origin hook refuses a branch it does not accept', async () => {
    const harness = await createFlowHarness('F61-4', {
      repoFiles: { '.swarmloop.json': '{"git":{"commit":"{subject}"}}\n', [TEMPLATE]: '- [ ] tested\n' },
      fakeHost: { origin: { branch: { pattern: '^feature/F61-4-', message: 'branch name refused' } } },
    });
    try {
      expect(existsSync(join(harness.tree, '.swarmloop.json'))).toBe(true);
      expect(git(harness.tree, ['show', `HEAD:${TEMPLATE}`])).toBe('- [ ] tested');
      git(harness.tree, ['checkout', '-b', 'feature/F61-4-ok']);
      git(harness.tree, ['push', 'origin', 'feature/F61-4-ok']);
      git(harness.tree, ['checkout', '-b', 'wrong-name']);
      expect(() => git(harness.tree, ['push', 'origin', 'wrong-name'])).toThrow('branch name refused');
    } finally {
      await harness.close();
    }
  });

  it('merges on the fake backlog host by the allowed method and refuses another', async () => {
    const backlog = new FakeBacklogHost();
    backlog.addProject('acme/app');
    backlog.allowMerge('acme/app', ['rebase']);
    expect((await backlog.readMergeMethods('acme/app')).methods).toEqual(['rebase']);
    await backlog.mergeMergeRequest('acme/app', 1, undefined, { method: 'rebase' });
    expect(backlog.mergesOf('acme/app')).toEqual([{ method: 'rebase' }]);
    await expect(backlog.mergeMergeRequest('acme/app', 2)).rejects.toThrow('does not allow a squash merge');
  });
});
