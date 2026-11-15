import { mkdirSync } from 'fs';
import { mkdtemp, readFile, readdir } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import type * as FsPromises from 'fs/promises';
import { SystemClock } from '../core/clock';
import { AgentProcessRunner } from './agent-runner';
import { RunStop } from './run-stop';
import { config, fakeChild, input, sandbox, writePriceCache } from './agent-runner.spec-helpers';

let writeCalls = 0;

jest.mock('fs/promises', () => {
  const actual = jest.requireActual<typeof FsPromises>('fs/promises');
  return {
    ...actual,
    // Earlier writes wait longer than later ones, so an unordered write lands last.
    writeFile: async (...args: Parameters<typeof actual.writeFile>) => {
      const turns = Math.max(1, 40 - 8 * writeCalls++);
      for (let turn = 0; turn < turns; turn += 1) {
        await new Promise<void>((done) => setImmediate(done));
      }
      return actual.writeFile(...args);
    },
  };
});

describe('AgentProcessRunner writes', () => {
  it('resolves only after the log ending and the final session state are written', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-agent-writes-'));
    mkdirSync(join(root, 'data'), { recursive: true });
    writePriceCache(root);
    writeCalls = 0;
    const outputFile = join(root, 'data', 'run1-implement-output.txt');
    const stream = [
      `${JSON.stringify({ session_id: 'chat-7' })}\n`,
      `${JSON.stringify({ type: 'result', result: 'done' })}\n`,
    ];
    const spawn = jest.fn(() => Promise.resolve(fakeChild(stream, 0)));
    const runner = new AgentProcessRunner(config(root), new SystemClock(), sandbox(spawn), new RunStop());
    const request = input(root, outputFile, { resumeChatId: null });
    await runner.run(request);
    expect(await readFile(outputFile, 'utf8')).toMatch(/process exited 0\n$/);
    expect((await readdir(join(root, 'data'))).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    const session = JSON.parse(await readFile(request.sessionFile, 'utf8')) as { completed: boolean; chatId: string };
    expect(session).toMatchObject({ completed: true, chatId: 'chat-7' });
  });
});
