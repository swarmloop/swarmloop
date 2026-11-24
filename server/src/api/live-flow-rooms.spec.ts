import 'reflect-metadata';
import { NotFoundException } from '@nestjs/common';
import type { FlowView } from '../contract/api';
import { LiveFlowRooms } from './live-flow-rooms';
import type { RunQueriesService } from './run-queries.service';

type Told = Array<[string, string, unknown]>;

function setup(pages: Record<string, unknown>, watched: string[] = []) {
  const told: Told = [];
  const rooms = new Map(watched.map((name) => [name, new Set(['socket'])]));
  const server = {
    sockets: { adapter: { rooms } },
    to: (name: string) => ({ emit: (event: string, view: unknown) => told.push([name, event, view]) }),
  };
  const runs = {
    flow: async (key: string) => {
      if (!(key in pages)) {
        throw new NotFoundException();
      }
      return pages[key];
    },
  };
  const flows = new LiveFlowRooms(runs as unknown as RunQueriesService, () => server as never);
  const joiner: Told = [];
  const client = { emit: (event: string, view: unknown) => joiner.push(['joiner', event, view]) } as never;
  return { flows, told, joiner, client, rooms };
}

const view = (name: string) => ({ key: 'run-1', name }) as unknown as FlowView;

describe('LiveFlowRooms', () => {
  it('sends a page to its room and records it', () => {
    const { flows, told } = setup({});
    flows.send('run-1', view('a'));
    expect(told).toEqual([['run:run-1', 'flow', view('a')]]);
    expect(flows.has('run-1')).toBe(true);
  });

  it('sends a page that equals the last one sent to nobody', () => {
    const { flows, told } = setup({});
    flows.send('run-1', view('a'));
    flows.send('run-1', view('a'));
    flows.send('run-1', view('b'));
    expect(told.map(([, , sent]) => sent)).toEqual([view('a'), view('b')]);
  });

  it('sends a page to the room of the joiner when it has no record or the page changed', async () => {
    const { flows, told, joiner, client } = setup({ 'run-1': view('a') });
    await flows.watch(client, 'run-1');
    expect(told).toEqual([['run:run-1', 'flow', view('a')]]);
    expect(joiner).toEqual([]);
  });

  it('sends an unchanged page to the joining socket only', async () => {
    const { flows, told, joiner, client } = setup({ 'run-1': view('a') });
    flows.send('run-1', view('a'));
    told.length = 0;
    await flows.watch(client, 'run-1');
    expect(told).toEqual([]);
    expect(joiner).toEqual([['joiner', 'flow', view('a')]]);
  });

  it('sends nothing for a run that is gone', async () => {
    const { flows, told, joiner, client } = setup({});
    await flows.watch(client, 'run-1');
    await flows.publish('run-1');
    expect(told).toEqual([]);
    expect(joiner).toEqual([]);
  });

  it('forgets a room that no socket is in, so its next page is sent again', () => {
    const { flows, told, rooms } = setup({}, ['run:run-1']);
    flows.send('run-1', view('a'));
    rooms.clear();
    flows.prune();
    expect(flows.has('run-1')).toBe(false);
    flows.send('run-1', view('a'));
    expect(told).toHaveLength(2);
  });

  it('keeps the record of a room that still has a socket', () => {
    const { flows, told } = setup({}, ['run:run-1']);
    flows.send('run-1', view('a'));
    flows.prune();
    flows.send('run-1', view('a'));
    expect(told).toHaveLength(1);
  });
});
