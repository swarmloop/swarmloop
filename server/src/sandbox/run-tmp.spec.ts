import { mkdtempSync, readdirSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SwarmloopError } from '../core/swarmloop-error';
import { prepareRunTmp, runTmpDir } from './run-tmp';

describe('run /tmp folder', () => {
  const own = typeof process.getuid === 'function' ? process.getuid() : 0;

  it('is named under worktrees/.tmp by run and unit, and refuses a name that is not a plain one', () => {
    expect(runTmpDir('/app', 'PROJ-1')).toBe('/app/worktrees/.tmp/PROJ-1');
    expect(runTmpDir('/app', 'PROJ-1', 'checks-demo-0')).toBe('/app/worktrees/.tmp/PROJ-1/checks-demo-0');
    expect(() => runTmpDir('/app', '../PROJ-1')).toThrow(SwarmloopError);
    expect(() => runTmpDir('/app', 'PROJ-1', '../implement')).toThrow(SwarmloopError);
  });

  it('is a /tmp mount with mode 1777 owned by the given user', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'swarmloop-runtmp-')), 'a', 'b');
    const mount = await prepareRunTmp(path, own, false);
    expect(mount).toEqual({ hostPath: path, containerPath: '/tmp' });
    const info = statSync(path);
    expect(info.mode & 0o7777).toBe(0o1777);
    expect(info.uid).toBe(own);
  });

  it('empties a folder with files when fresh and keeps them otherwise', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'swarmloop-runtmp-')), 'unit');
    await prepareRunTmp(path, own, true);
    writeFileSync(join(path, 'scratch'), 'x');
    await prepareRunTmp(path, own, false);
    expect(readdirSync(path)).toEqual(['scratch']);
    await prepareRunTmp(path, own, true);
    expect(readdirSync(path)).toEqual([]);
  });
});
