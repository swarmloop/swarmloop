import { useEffect, useMemo, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { RunSummary } from '@contract/api';
import { listRuns } from '../../lib/endpoints';
import { useStatsVersion } from '../stats';
import { useLiveBridge } from '../shell';

const KEY = 'overview-runs';

/** The pages of finished runs read to find the latest finished: creation order does not tell the finish order, so a bound keeps the reading small. */
const DONE_PAGES = 5;

interface OverviewRuns {
  /** Both lists have arrived; a refresh that fails keeps them. */
  loaded: boolean;
  /** A list never arrived because its request failed. */
  failed: boolean;
  active: RunSummary[];
  done: RunSummary[];
}

async function listDone(): Promise<RunSummary[]> {
  const runs: RunSummary[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < DONE_PAGES; page += 1) {
    const result = await listRuns({ part: 'done', q: '', ...(cursor === undefined ? {} : { cursor }) });
    runs.push(...result.runs);
    if (result.next === null) {
      break;
    }
    cursor = result.next;
  }
  return runs;
}

/** The active runs and the finished runs of the first pages, with the live snapshot's rows laid over them by key. */
export function useOverviewRuns(): OverviewRuns {
  const client = useQueryClient();
  const version = useStatsVersion();
  const live = useLiveBridge((snapshot) => snapshot.runs);
  const seen = useRef(version);
  useEffect(() => {
    if (seen.current !== version) {
      seen.current = version;
      void client.invalidateQueries({ queryKey: [KEY] });
    }
  }, [client, version]);
  const active = useQuery({
    queryKey: [KEY, 'active'],
    queryFn: async () => (await listRuns({ part: 'active', q: '' })).runs,
  });
  const done = useQuery({ queryKey: [KEY, 'done'], queryFn: listDone });
  const activeRuns = active.data;
  const doneRuns = done.data;
  const loaded = activeRuns !== undefined && doneRuns !== undefined;
  const failed = (active.isError && activeRuns === undefined) || (done.isError && doneRuns === undefined);
  return useMemo(() => {
    const rows = new Map(live.map((run) => [run.key, run]));
    const overlay = (runs: RunSummary[] | undefined): RunSummary[] =>
      (runs ?? []).map((run) => rows.get(run.key) ?? run);
    return { loaded, failed, active: overlay(activeRuns), done: overlay(doneRuns) };
  }, [live, activeRuns, doneRuns, loaded, failed]);
}
