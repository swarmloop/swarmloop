import type { LiveRunUsage } from '../contract/live';
import type { LiveGateway } from './live.gateway';
import type { RunQueriesService } from './run-queries.service';
import type { RunUsageReader } from './run-usage';

/** A reader that gives no usage entries, for specs that are not about usage. */
export function noUsage(): RunUsageReader {
  return { entries: jest.fn().mockResolvedValue([]) } as unknown as RunUsageReader;
}

/** A reader that gives the same entries for every key. */
export function usageOf(entries: LiveRunUsage[]): RunUsageReader {
  return { entries: jest.fn().mockResolvedValue(entries) } as unknown as RunUsageReader;
}

/**
 * A runs service whose `flow` gives the page of the key and whose `tasks` gives its task section, each recording
 * the keys it was asked for.
 */
export function runsOf(pages: Record<string, object> = {}, sections: Record<string, object> = {}) {
  const built: string[] = [];
  const tasked: string[] = [];
  const service = {
    flow: async (key: string) => {
      built.push(key);
      return pages[key] ?? { key };
    },
    tasks: async (key: string) => {
      tasked.push(key);
      return sections[key] ?? {};
    },
  } as unknown as RunQueriesService;
  return { service, built, tasked };
}

/** A socket that joins any room and keeps what it is sent. */
export function clientOf(told: Array<[string, unknown]> = []) {
  return {
    rooms: new Set<string>(),
    join: async () => undefined,
    emit: (name: string, entry: unknown) => told.push([name, entry]),
  } as never;
}

/** The run list as the kept rows give it: only the keys and the parent links matter to a publish. */
export function rowsOf(runs: Array<{ key: string; parentKey?: string }>, recomputed = 1) {
  return { read: jest.fn().mockResolvedValue({ view: { runs: runs.map(summaryOf) }, recomputed }) };
}

/** A run row with the fields the counts read. */
export function summaryOf(row: { key: string; parentKey?: string }) {
  return { title: '', name: '', state: 'running', createdAt: '2026-01-01T00:00:00Z', ...row };
}

/** A server with `connected` sockets, and the rooms with a socket in them. */
export function serverOf(
  connected: number,
  watchedRooms: string[],
  sent: Array<{ room: string; entry: unknown }> = [],
) {
  return {
    emit: jest.fn(),
    sockets: {
      sockets: new Map(Array.from({ length: connected }, (_, n) => [`socket-${n}`, {}])),
      adapter: { rooms: new Map(watchedRooms.map((name) => [name, new Set(['socket'])])) },
    },
    to: (room: string) => ({ emit: (_name: string, entry: unknown) => sent.push({ room, entry }) }),
  } as unknown as LiveGateway['server'];
}
