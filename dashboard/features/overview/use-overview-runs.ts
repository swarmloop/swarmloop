import { useMemo, useRef } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type { RunSummary } from '@contract/api';
import { listRuns } from '../../lib/endpoints';
import { useStatsVersion } from '../stats';
import { useLiveBridge } from '../shell';

const KEY = 'overview-runs';

interface OverviewRuns {
  /** The list has arrived; a refresh that fails keeps it. */
  loaded: boolean;
  /** The list never arrived because its request failed. */
  failed: boolean;
  active: RunSummary[];
}

/** The data of a read, or the last data that arrived when the read of a newer key failed: a refresh that fails keeps them. */
function useLastData<T>(data: T | undefined): T | undefined {
  const last = useRef<T | undefined>(undefined);
  if (data !== undefined) {
    last.current = data;
  }
  return data ?? last.current;
}

/** The active runs, with the live snapshot's rows laid over them by key. */
export function useOverviewRuns(): OverviewRuns {
  const version = useStatsVersion();
  const live = useLiveBridge((snapshot) => snapshot.runs);
  const active = useQuery({
    queryKey: [KEY, 'active', version],
    queryFn: async () => (await listRuns({ part: 'active', q: '' })).runs,
    placeholderData: keepPreviousData,
  });
  const activeRuns = useLastData(active.data);
  const loaded = activeRuns !== undefined;
  const failed = active.isError && activeRuns === undefined;
  return useMemo(() => {
    const rows = new Map(live.map((run) => [run.key, run]));
    const overlay = (runs: RunSummary[] | undefined): RunSummary[] =>
      (runs ?? []).map((run) => rows.get(run.key) ?? run);
    return { loaded, failed, active: overlay(activeRuns) };
  }, [live, activeRuns, loaded, failed]);
}
