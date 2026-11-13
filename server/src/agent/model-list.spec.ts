import { EventEmitter } from 'events';
import { mkdtemp, readFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { ClaudeRuntime } from '../integrations/agent-runtime/claude/claude.runtime';
import { CursorRuntime } from '../integrations/agent-runtime/cursor/cursor.runtime';
import type { SandboxService } from '../sandbox/sandbox.service';
import { loadModelList, sandboxModelLister } from './model-list';

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-11-13T10:00:00Z');

describe('loadModelList', () => {
  const cursor = new CursorRuntime();

  it('reads once and reuses the cache within a day', async () => {
    const root = await mkdtemp(join(tmpdir(), 'model-list-'));
    const list = jest.fn(() => Promise.resolve('grok-4.7 - Grok 4.7\n'));
    expect(await loadModelList(root, cursor, NOW, list)).toBe('grok-4.7 - Grok 4.7\n');
    const again = jest.fn(() => Promise.resolve('other - Other\n'));
    expect(await loadModelList(root, cursor, NOW + DAY_MS - 1, again)).toBe('grok-4.7 - Grok 4.7\n');
    expect(again).not.toHaveBeenCalled();
    const file = JSON.parse(await readFile(join(root, 'data', 'model-list-cursor.json'), 'utf8')) as { output: string };
    expect(file.output).toBe('grok-4.7 - Grok 4.7\n');
  });

  it('refreshes a cache that is a day old', async () => {
    const root = await mkdtemp(join(tmpdir(), 'model-list-'));
    await loadModelList(root, cursor, NOW, () => Promise.resolve('old - Old\n'));
    expect(await loadModelList(root, cursor, NOW + DAY_MS, () => Promise.resolve('new - New\n'))).toBe('new - New\n');
  });

  it('keeps the old cache when a read fails or prints nothing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'model-list-'));
    await loadModelList(root, cursor, NOW, () => Promise.resolve('old - Old\n'));
    const later = NOW + 2 * DAY_MS;
    expect(await loadModelList(root, cursor, later, () => Promise.reject(new Error('docker is down')))).toBe(
      'old - Old\n',
    );
    expect(await loadModelList(root, cursor, later, () => Promise.resolve('  \n'))).toBe('old - Old\n');
  });

  it('gives an empty text when there is no cache and the read fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'model-list-'));
    expect(await loadModelList(root, cursor, NOW, () => Promise.reject(new Error('down')))).toBe('');
  });

  it('does not read for a runtime without a model list', async () => {
    const root = await mkdtemp(join(tmpdir(), 'model-list-'));
    const list = jest.fn(() => Promise.resolve('x'));
    expect(await loadModelList(root, new ClaudeRuntime(), NOW, list)).toBe('');
    expect(list).not.toHaveBeenCalled();
  });
});

describe('sandboxModelLister', () => {
  const mount = { hostPath: '/tmp/state', containerPath: '/work' };
  const credential = { name: 'CURSOR_API_KEY', value: 'key' };

  function fakeSandbox(output: string, code: number) {
    const launches: { command: string[]; runtime: string }[] = [];
    const sandbox = {
      spawn: (launch: { command: string[]; runtime: string }) => {
        launches.push(launch);
        const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter() });
        setImmediate(() => {
          child.stdout.emit('data', Buffer.from(output));
          child.emit('close', code);
        });
        return Promise.resolve(child);
      },
    } as unknown as SandboxService;
    return { sandbox, launches };
  }

  it('runs the list command of the runtime in its own image and returns what it prints', async () => {
    const { sandbox, launches } = fakeSandbox('grok-4.7 - Grok 4.7\n', 0);
    const list = sandboxModelLister(sandbox, new CursorRuntime(), credential, mount);
    expect(await list()).toBe('grok-4.7 - Grok 4.7\n');
    expect(launches[0]).toMatchObject({ runtime: 'cursor', command: ['agent', '--list-models'] });
  });

  it('fails when the command exits with an error', async () => {
    const { sandbox } = fakeSandbox('', 1);
    await expect(sandboxModelLister(sandbox, new CursorRuntime(), credential, mount)()).rejects.toThrow('exited');
  });
});
