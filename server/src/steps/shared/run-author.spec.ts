import { HostUnavailable } from '../../core/swarmloop-error';
import { RunAuthor } from './run-author';

type Row = { id: number; startedBy: string | null; parentRunId: number | null; codeHost: string };

const NO_REPLY = { name: 'Ann Lee', email: '1+ann@users.noreply.gitlab.example', httpCalls: [] };

function authorOf(
  rows: Row[],
  answer: () => Promise<{ name: string | null; email: string | null; httpCalls: never[] }>,
  registered = true,
) {
  const asked: string[] = [];
  const runs = { findById: async (id: number) => rows.find((row) => row.id === id) ?? null };
  const registry = {
    has: () => registered,
    hostFor: async () => ({
      readAuthor: (login: string) => {
        asked.push(login);
        return answer();
      },
    }),
  };
  return { author: new RunAuthor(runs as never, registry as never), asked };
}

const ann: Row = { id: 1, startedBy: 'ann', parentRunId: null, codeHost: 'gitlab' };

describe('RunAuthor', () => {
  it("gives the person's name with the no-reply address of their account", async () => {
    const { author, asked } = authorOf([ann], async () => NO_REPLY);
    expect(await author.of(ann)).toEqual({ name: 'Ann Lee', email: '1+ann@users.noreply.gitlab.example' });
    expect(asked).toEqual(['ann']);
  });

  it('gives the login as the name when the host has none', async () => {
    const { author } = authorOf([ann], async () => ({ ...NO_REPLY, name: null }));
    expect(await author.of(ann)).toEqual({ name: 'ann', email: NO_REPLY.email });
  });

  it('gives null when the host gives no address', async () => {
    const { author } = authorOf([ann], async () => ({ name: 'Ann Lee', email: null, httpCalls: [] }));
    expect(await author.of(ann)).toBeNull();
  });

  it('gives null for a run with no person, and never asks the host', async () => {
    const run = { ...ann, startedBy: null };
    const { author, asked } = authorOf([run], async () => NO_REPLY);
    expect(await author.of(run)).toBeNull();
    expect(asked).toEqual([]);
  });

  it('gives null for a run of the machine', async () => {
    const run = { ...ann, startedBy: 'machine' };
    const { author, asked } = authorOf([run], async () => NO_REPLY);
    expect(await author.of(run)).toBeNull();
    expect(asked).toEqual([]);
  });

  it('gives a subtask the person that started its parent', async () => {
    const subtask = { id: 2, startedBy: 'machine', parentRunId: 1, codeHost: 'gitlab' };
    const { author, asked } = authorOf([ann, subtask], async () => NO_REPLY);
    expect(await author.of(subtask)).toEqual({ name: 'Ann Lee', email: NO_REPLY.email });
    expect(asked).toEqual(['ann']);
  });

  it('gives null when the code host of the run is not registered', async () => {
    const { author, asked } = authorOf([ann], async () => NO_REPLY, false);
    expect(await author.of(ann)).toBeNull();
    expect(asked).toEqual([]);
  });

  it('lets a host outage through, so the run waits', async () => {
    const { author } = authorOf([ann], async () => {
      throw new HostUnavailable('gitlab', 'HTTP 503', '2026-11-19T00:00:00.000Z');
    });
    await expect(author.of(ann)).rejects.toBeInstanceOf(HostUnavailable);
  });
});
