import { utimesSync } from 'fs';
import { mkdtemp, mkdir, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { launchCount, launchOpen, launchesInLog, recordLaunch } from './agent-launches';

describe('agent launches', () => {
  it('counts a process that continued after a time kill', () => {
    const body = 'thinking\nprocess killed: time\nthinking\nfinishing the review\n';
    expect(launchesInLog(body)).toBe(2);
    expect(launchesInLog('{"type":"result"}\nprocess exited 0\n')).toBe(1);
    expect(launchesInLog('process killed: time\nprocess started\nthinking\nprocess exited 0\n')).toBe(2);
    expect(launchesInLog('waiting for output\n')).toBe(0);
    expect(launchesInLog('starting\n')).toBe(0);
    expect(launchesInLog('')).toBe(0);
  });

  it('keeps the record after the log is replaced, and closes when the last line ends', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-launches-'));
    const output = join(root, 'data', 'proj-1-code-review-requirements-output.txt');
    await mkdir(join(root, 'data'), { recursive: true });
    await writeFile(output, 'thinking\nprocess killed: time\n');
    await recordLaunch(output, 'proj-1', 'code-review-requirements');
    await recordLaunch(output, 'proj-1', 'code-review-requirements');
    await writeFile(output, 'process exited 0\n');
    expect(launchCount(root, 'proj-1', 'code-review-requirements')).toBe(3);
    expect(launchOpen(root, 'proj-1', 'code-review-requirements')).toBe(false);
    await writeFile(output, 'process killed: time\nprocess started\n');
    expect(launchOpen(root, 'proj-1', 'code-review-requirements')).toBe(true);
    await writeFile(output, 'process killed: time\nprocess exited 0\nprocess exited 0\n');
    expect(launchOpen(root, 'proj-1', 'code-review-requirements')).toBe(false);
    expect(launchCount(root, 'proj-1', 'research')).toBe(0);
  });

  it('does not count an older attempt that is still open', async () => {
    const root = await mkdtemp(join(tmpdir(), 'launches-attempt-'));
    await mkdir(join(root, 'data'));
    const older = join(root, 'data', 'proj-1-implement-zzz-output.txt');
    const newer = join(root, 'data', 'proj-1-implement-aaa-output.txt');
    await writeFile(older, 'process started\nthinking\n');
    await writeFile(newer, 'process exited 0\n');
    utimesSync(older, new Date(1000), new Date(1000));
    utimesSync(newer, new Date(2000), new Date(2000));
    expect(launchOpen(root, 'proj-1', 'implement')).toBe(false);
    expect(launchOpen(root, 'proj-1', 'implement', 'aaa')).toBe(false);
    expect(launchOpen(root, 'proj-1', 'implement', 'zzz')).toBe(true);
  });
});
