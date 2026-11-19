import type { RunSummary } from '../contract/api';
import { HttpServerApi } from './server-api';

const run = (key: string) => ({ key }) as RunSummary;

describe('HttpServerApi', () => {
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
});
