import 'reflect-metadata';
import type { AppConfig } from '../config/env';
import type { DrainView } from '../contract/api';
import { DrainCommand } from './drain.command';

jest.mock('../core/delay', () => ({ delay: async () => undefined }));

function views(...answers: DrainView[]) {
  const calls: { url: string; method: string }[] = [];
  jest.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    calls.push({ url: url as string, method: String(init?.method) });
    return new Response(JSON.stringify(answers.shift()), { status: 200 });
  });
  return calls;
}

async function drain(): Promise<string> {
  const out = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
  const config = { env: { SWARMLOOP_API_HOST: '0.0.0.0', SWARMLOOP_API_PORT: 3920 } } as AppConfig;
  try {
    await new DrainCommand(config).run();
    return out.mock.calls.map(([text]) => String(text)).join('');
  } finally {
    out.mockRestore();
  }
}

describe('DrainCommand', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    process.exitCode = undefined;
  });

  it('posts the drain, polls until the instance is idle and says so', async () => {
    const calls = views(
      { draining: true, idle: false, running: 2 },
      { draining: true, idle: false, running: 1 },
      { draining: true, idle: true, running: 0 },
    );

    const text = await drain();

    expect(calls).toEqual([
      { url: 'http://127.0.0.1:3920/drain', method: 'POST' },
      { url: 'http://127.0.0.1:3920/drain', method: 'GET' },
      { url: 'http://127.0.0.1:3920/drain', method: 'GET' },
    ]);
    expect(text).toBe(
      'draining: no new runs or steps are accepted\nwaiting for 2 running\nwaiting for 1 running\nidle\n',
    );
  });

  it('exits 1 when the server does not answer', async () => {
    jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('connect ECONNREFUSED'));
    const err = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);

    await drain();

    expect(String(err.mock.calls[0][0])).toContain('ECONNREFUSED');
    expect(process.exitCode).toBe(1);
  });
});
