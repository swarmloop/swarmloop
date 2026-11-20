import type { RunSummary } from '../contract/api';
import { HttpServerApi } from './server-api';

const run = (key: string) => ({ key }) as RunSummary;

describe('HttpServerApi', () => {
  it('sends the shell container uid with its lock so volume ownership matches the shell', async () => {
    const requests: unknown[] = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      requests.push(JSON.parse(init.body as string));
      return { ok: true, json: async () => ({ status: 'running' }) };
    }) as unknown as typeof fetch;
    const api = new HttpServerApi('http://nest', 'token', fetchImpl);
    await expect(api.shellLock('run-1', 'run-1-shell', 501)).resolves.toMatchObject({ status: 'running' });
    expect(requests).toEqual([{ container: 'run-1-shell', userId: 501 }]);
  });
  it('reads every page of part=all', async () => {
    const asked: string[] = [];
    const pages: Record<string, unknown> = {
      '/runs?part=all': { runs: [run('a'), run('b')], next: 'c1' },
      '/runs?part=all&cursor=c1': { runs: [run('c')], next: null },
    };
    const fetchImpl = (async (url: string) => {
      asked.push(url.replace('http://nest', ''));
      return { ok: true, json: async () => pages[asked[asked.length - 1]] };
    }) as unknown as typeof fetch;
    const api = new HttpServerApi('http://nest', 'token', fetchImpl);
    expect((await api.list()).runs.map((entry) => entry.key)).toEqual(['a', 'b', 'c']);
    expect(asked).toEqual(['/runs?part=all', '/runs?part=all&cursor=c1']);
  });

  it('lists the server clones with their origins', async () => {
    const asked: string[] = [];
    const clones = [{ name: 'r', path: '/checkouts/r', origin: 'https://github.com/o/r.git' }];
    const fetchImpl = (async (url: string, init: { method: string }) => {
      asked.push(`${init.method} ${url.replace('http://nest', '')}`);
      return { ok: true, json: async () => ({ clones }) };
    }) as unknown as typeof fetch;
    const api = new HttpServerApi('http://nest', 'token', fetchImpl);
    expect((await api.cloneOrigins()).clones).toEqual(clones);
    expect(asked).toEqual(['GET /checkouts/origins']);
  });
});
