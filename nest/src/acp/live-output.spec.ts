import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { mkdtemp } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { liveLogBody, liveLogCurrent, liveLogFinished, liveLogView, replaceLogFile } from './live-output';

describe('live log files', () => {
  it('reads a per-repo implement file and skips implement-review', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sloop-log-'));
    mkdirSync(join(root, 'data'));
    writeFileSync(join(root, 'data', 'run-1-implement-swarmloop-output.txt'), 'implement\n');
    writeFileSync(join(root, 'data', 'run-1-implement-review-swarmloop-output.txt'), 'review\n');
    expect(liveLogBody(root, 'run-1', 'implement')).toBe('implement\n');
    expect(liveLogBody(root, 'run-1', 'implement-review')).toBe('review\n');
  });

  it('keeps each code reviewer on its own file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sloop-review-log-'));
    mkdirSync(join(root, 'data'));
    writeFileSync(join(root, 'data', 'run-1-code-review-quality-output.txt'), 'quality\n');
    writeFileSync(join(root, 'data', 'run-1-code-review-security-output.txt'), 'security\n');
    expect(liveLogBody(root, 'run-1', 'code-review')).toBe('');
    expect(liveLogBody(root, 'run-1', 'code-review-quality')).toBe('quality\n');
    expect(liveLogBody(root, 'run-1', 'code-review-security')).toBe('security\n');
  });

  it('treats a result or exit line as finished', () => {
    expect(liveLogFinished('{"type":"thinking"}\n')).toBe(false);
    expect(liveLogFinished('{"type":"result"}\n')).toBe(true);
    expect(liveLogFinished('process exited 0\n')).toBe(true);
    expect(liveLogFinished('process killed: idle\n')).toBe(true);
    expect(liveLogFinished('thinking\nprocess killed: time\nthinking\n')).toBe(false);
    expect(liveLogFinished('process killed: time\nprocess started\n')).toBe(false);
    expect(liveLogFinished('{"type":"tool_call","snippet":"process exited 0"}\n')).toBe(false);
  });

  it('keeps every open reviewer current while they run together', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sloop-current-log-'));
    const directory = join(root, 'data');
    mkdirSync(directory);
    const older = join(directory, 'run-1-code-review-security-output.txt');
    const newer = join(directory, 'run-1-code-review-performance-output.txt');
    const chat = join(directory, 'run-1-chat-output.txt');
    writeFileSync(older, 'thinking\nprocess killed: time\nthinking\n');
    writeFileSync(newer, 'process started\n');
    writeFileSync(chat, 'asking\n');
    expect(liveLogCurrent(root, 'run-1', 'code-review-security')).toBe(true);
    expect(liveLogCurrent(root, 'run-1', 'code-review-performance')).toBe(true);
    expect(liveLogView(root, 'run-1', 'code-review-security')).toEqual({
      body: 'thinking\nprocess killed: time\nthinking\n',
      current: true,
    });
    writeFileSync(newer, 'notes\ndecision: ok\nprocess exited 0\n');
    expect(liveLogCurrent(root, 'run-1', 'code-review-performance')).toBe(false);
    expect(liveLogCurrent(root, 'run-1', 'code-review-security')).toBe(true);
    writeFileSync(older, 'starting\n');
    expect(liveLogCurrent(root, 'run-1', 'code-review-security')).toBe(false);
    writeFileSync(older, 'starting\nprocess started\n');
    expect(liveLogCurrent(root, 'run-1', 'code-review-security')).toBe(true);
  });

  it('replaces a log with the latest body and leaves no temp file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sloop-replace-log-'));
    const directory = join(root, 'data');
    mkdirSync(directory);
    const file = join(directory, 'run-1-code-review-quality-output.txt');
    writeFileSync(file, 'first\n');
    await replaceLogFile(file, 'second\n');
    expect(liveLogBody(root, 'run-1', 'code-review-quality')).toBe('second\n');
    expect(existsSync(`${file}.tmp`)).toBe(false);
  });
});
