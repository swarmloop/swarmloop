import { useEffect, useMemo, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { RunSummary } from '@contract/api';
import type { Part } from '@contract/run-list';
import { listRuns } from '../../lib/endpoints';
import { useStatsVersion } from '../stats';
import { useLiveBridge } from '../shell';

const KEY = 'overview-runs';

interface OverviewRuns {
  loaded: boolean;
  active: RunSummary[];
  done: RunSummary[];
}

function useFirstPage(part: Part): RunSummary[] | undefined {
  const query = useQuery({ queryKey: [KEY, part], queryFn: () => listRuns({ part, q: '' }) });
  return query.data?.runs;
}

/** The first page of the active and of the done runs, with the live snapshot's rows laid over them by key. */
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
  const active = useFirstPage('active');
  const done = useFirstPage('done');
  return useMemo(() => {
    const rows = new Map(live.map((run) => [run.key, run]));
    const overlay = (runs: RunSummary[] | undefined): RunSummary[] =>
      (runs ?? []).map((run) => rows.get(run.key) ?? run);
    return { loaded: active !== undefined && done !== undefined, active: overlay(active), done: overlay(done) };
  }, [live, active, done]);
}
