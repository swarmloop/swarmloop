import { writeFileSync } from 'fs';
import { join } from 'path';
import { commitFiles, makeRepo } from '../git/git-repo.spec-helpers';
import { checksFingerprint } from './checks-fingerprint';
import type { EnvironmentRecord, PreparedEnvironment } from './environment-types';

const record: EnvironmentRecord = {
  repo: 'app',
  config: { checks: ['npm test'], cache: [], source: '.swarmloop.json' },
  setup: { command: 'npm ci', image: 'img', exitCode: 0, tail: '' },
};

describe('checksFingerprint', () => {
  const repo = makeRepo({ 'a.txt': 'a\n' });
  const other = makeRepo({ 'b.txt': 'b\n' });
  const input = {
    mounts: [
      { hostPath: repo, containerPath: '/work' },
      { hostPath: other, containerPath: '/work/other' },
    ],
  };
  const prepared = (change: Partial<EnvironmentRecord> = {}): PreparedEnvironment => ({
    launch: { image: 'node:22' } as PreparedEnvironment['launch'],
    record: { ...record, ...change },
  });
  const fingerprint = (current: PreparedEnvironment = prepared(), id = 'sha256:one\n'): Promise<string> =>
    checksFingerprint(input, current, () => Promise.resolve(id));

  it('stays equal when nothing changed', async () => {
    expect(await fingerprint()).toBe(await fingerprint());
  });

  it('changes with the hosts of the manifest and keeps its value without them', async () => {
    const config = (hosts?: object) => ({ ...record.config, ...(hosts ? { hosts } : {}) });
    const plain = await fingerprint();
    const withHosts = await fingerprint(prepared({ config: config({ setup: ['pub.dev'] }) }));
    expect(withHosts).not.toBe(plain);
    expect(await fingerprint(prepared({ config: config({ setup: ['pub.dev', 'x.example'] }) }))).not.toBe(withHosts);
    expect(await fingerprint(prepared({ config: config() }))).toBe(plain);
  });

  it('changes with a tracked edit, an untracked file, another repository or a moved HEAD', async () => {
    const seen = new Set([await fingerprint()]);
    writeFileSync(join(repo, 'a.txt'), 'edited\n');
    seen.add(await fingerprint());
    writeFileSync(join(repo, 'new.txt'), 'x\n');
    seen.add(await fingerprint());
    writeFileSync(join(other, 'b.txt'), 'edited\n');
    seen.add(await fingerprint());
    commitFiles(repo, {});
    seen.add(await fingerprint());
    expect(seen.size).toBe(5);
  });

  it('changes with the image id, the checks list or the setup command', async () => {
    const seen = new Set([
      await fingerprint(),
      await fingerprint(prepared(), 'sha256:two\n'),
      await fingerprint(prepared({ config: { ...record.config, checks: ['npm test', 'npm run lint'] } })),
      await fingerprint(prepared({ setup: { ...record.setup!, command: 'npm install' } })),
    ]);
    expect(seen.size).toBe(4);
  });
});
