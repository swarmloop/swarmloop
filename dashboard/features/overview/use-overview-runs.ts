import { useMemo, useRef } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type { RunSummary } from '@contract/api';
import { listRuns } from '../../lib/endpoints';
import { useStatsVersion } from '../stats';
import { useLiveBridge } from '../shell';

const KEY = 'overview-runs';

interface OverviewRuns {
  /** Both lists have arrived; a refresh that fails keeps them. */
  loaded: boolean;
  /** A list never arrived because its request failed. */
  failed: boolean;
  active: RunSummary[];
  done: RunSummary[];
}

/** The data of a read, or the last data that arrived when the read of a newer key failed: a refresh that fails keeps them. */
function useLastData<T>(data: T | undefined): T | undefined {
  const last = useRef<T | undefined>(undefined);
  if (data !== undefined) {
    last.current = data;
  }
  return data ?? last.current;
}

async function listDone(): Promise<RunSummary[]> {
  const runs: RunSummary[] = [];
  let cursor: string | undefined;
  for (;;) {
    const result = await listRuns({ part: 'done', q: '', ...(cursor === undefined ? {} : { cursor }) });
    runs.push(...result.runs);
    if (result.next === null) {
      return runs;
    }
    cursor = result.next;
  }
}

/** The active runs and the finished runs of every page, with the live snapshot's rows laid over them by key. */
export function useOverviewRuns(): OverviewRuns {
  const version = useStatsVersion();
  const live = useLiveBridge((snapshot) => snapshot.runs);
  const active = useQuery({
    queryKey: [KEY, 'active', version],
    queryFn: async () => (await listRuns({ part: 'active', q: '' })).runs,
    placeholderData: keepPreviousData,
  });
  const done = useQuery({
    queryKey: [KEY, 'done', version],
    queryFn: listDone,
    placeholderData: keepPreviousData,
  });
  const activeRuns = useLastData(active.data);
  const doneRuns = useLastData(done.data);
  const loaded = activeRuns !== undefined && doneRuns !== undefined;
  const failed = (active.isError && activeRuns === undefined) || (done.isError && doneRuns === undefined);
  return useMemo(() => {
    const rows = new Map(live.map((run) => [run.key, run]));
    const overlay = (runs: RunSummary[] | undefined): RunSummary[] =>
      (runs ?? []).map((run) => rows.get(run.key) ?? run);
    return { loaded, failed, active: overlay(activeRuns), done: overlay(doneRuns) };
  }, [live, activeRuns, doneRuns, loaded, failed]);
}
