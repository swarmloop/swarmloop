import { existsSync, mkdtempSync, readFileSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { FakeClock } from '../core/fake-clock.spec-helpers';
import type { LiveHub } from '../live/live.hub';
import { createVerifyLog } from './verify-log';

function line(text: string) {
  return { command: 'npm test', stream: 'stdout' as const, text };
}

function setup(withHub = true) {
  const root = mkdtempSync(join(tmpdir(), 'swarmloop-verify-log-'));
  const clock = new FakeClock();
  const live = { log: jest.fn() };
  const file = join(root, 'data', 'PROJ-1-verify-output.txt');
  const make = (label = 'gate') =>
    createVerifyLog({ live: withHub ? (live as unknown as LiveHub) : undefined, clock, root, key: 'PROJ-1', label });
  return { root, clock, live, file, make };
}

async function until(done: () => boolean): Promise<void> {
  for (let turn = 0; turn < 500 && !done(); turn += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  expect(done()).toBe(true);
}

beforeEach(() => {
  jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
});

afterEach(() => {
  jest.useRealTimers();
});

describe('createVerifyLog', () => {
  it('writes a header, the lines as delivered and the exit line, and sends the same body live', async () => {
    const { make, file, live } = setup();
    const log = make();
    log.onOutput(line('$ npm test'));
    log.onOutput(line('  FAIL  src/a.spec.ts'));
    log.onOutput(line('exit 1 (3s)'));
    await log.finish(1);
    const body = '== gate ==\n$ npm test\n  FAIL  src/a.spec.ts\nexit 1 (3s)\nprocess exited 1\n';
    expect(readFileSync(file, 'utf8')).toBe(body);
    expect(live.log).toHaveBeenLastCalledWith({ key: 'PROJ-1', step: 'verify', body });
  });

  it('appends a later run below the earlier one with its own header', async () => {
    const { make, file } = setup();
    const first = make('gate');
    first.onOutput(line('one'));
    await first.finish(0);
    const second = make('gate');
    second.onOutput(line('two'));
    await second.finish(1);
    expect(readFileSync(file, 'utf8')).toBe('== gate ==\none\nprocess exited 0\n== gate ==\ntwo\nprocess exited 1\n');
  });

  it('writes at most once every 300 ms', async () => {
    const { make, file, live, clock } = setup();
    const log = make();
    log.onOutput(line('a'));
    await until(() => live.log.mock.calls.length === 1);
    log.onOutput(line('b'));
    log.onOutput(line('c'));
    await new Promise((resolve) => setImmediate(resolve));
    expect(live.log).toHaveBeenCalledTimes(1);
    expect(readFileSync(file, 'utf8')).toBe('== gate ==\na\n');
    clock.advance(300);
    jest.advanceTimersByTime(300);
    await until(() => live.log.mock.calls.length === 2);
    expect(readFileSync(file, 'utf8')).toBe('== gate ==\na\nb\nc\n');
    await log.finish(0);
    expect(live.log).toHaveBeenCalledTimes(3);
  });

  it('keeps the last 500 KB, from a whole line', async () => {
    const { make, file } = setup();
    const log = make();
    const row = 'x'.repeat(1023);
    for (let index = 0; index < 700; index += 1) {
      log.onOutput(line(`${index} ${row}`));
    }
    await log.finish(0);
    const body = readFileSync(file, 'utf8');
    expect(statSync(file).size).toBeLessThanOrEqual(500 * 1024);
    expect(body.startsWith('== gate ==')).toBe(false);
    expect(body).toMatch(/^\d+ x+\n/);
    expect(body.endsWith('process exited 0\n')).toBe(true);
  });

  it('writes the file without a hub', async () => {
    const { make, file } = setup(false);
    const log = make();
    log.onOutput(line('ok'));
    await log.finish(0);
    expect(readFileSync(file, 'utf8')).toBe('== gate ==\nok\nprocess exited 0\n');
  });

  it('leaves no file when no output came', async () => {
    const { make, file } = setup();
    await make().finish(0);
    expect(existsSync(file)).toBe(false);
  });
});
