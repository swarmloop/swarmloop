'use client';

import type { ReactElement, ReactNode } from 'react';
import { createContext, useContext, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { MachineLoad, ReadinessItem, ReadinessView } from '@contract/readiness';
import { ApiError } from '../../lib/api';
import { getReadiness } from '../../lib/endpoints';

interface Readiness {
  items: ReadinessItem[];
  /** The first item that fails: a run cannot start while there is one. Null when none fails, and when the report cannot be read. */
  blocker: ReadinessItem | null;
  /** The text of a failed request for the report. */
  error: string | null;
  /** True while the first report is still being built or fetched. */
  loading: boolean;
  /** True when a report is held and the last refresh failed. */
  refreshFailed: boolean;
  /** When the held report was built; null when none is held or it has no time yet. */
  checkedAt: string | null;
  /** What heavy work takes of the machine; null when unknown. */
  load: MachineLoad | null;
}

const REFRESH_MS = 60_000;
const BUSY_RETRY_MS = 2_000;
/** The server answers an empty report while it builds the first one: ask again soon. */
const BUILDING_RETRY_MS = 2_000;

/** Without a provider nothing is known, so nothing blocks. */
const ReadinessContext = createContext<Readiness>({
  items: [],
  blocker: null,
  error: null,
  loading: false,
  refreshFailed: false,
  checkedAt: null,
  load: null,
});

/** A minute between refreshes; while the server builds its first report or is busy, a short wait that doubles with each failure. */
function nextRefresh(query: {
  state: { data: ReadinessView | undefined; error: unknown; fetchFailureCount: number };
}): number {
  const { data, error, fetchFailureCount } = query.state;
  if (data?.checkedAt === null && data.items.length === 0) {
    return BUILDING_RETRY_MS;
  }
  if (error instanceof ApiError && error.busy) {
    return Math.min(BUSY_RETRY_MS * 2 ** Math.max(fetchFailureCount - 1, 0), REFRESH_MS);
  }
  return REFRESH_MS;
}

export function ReadinessProvider({ children }: { children: ReactNode }): ReactElement {
  const query = useQuery({
    queryKey: ['readiness'],
    queryFn: getReadiness,
    refetchInterval: nextRefresh,
    refetchOnWindowFocus: true,
  });
  const value = useMemo<Readiness>(() => {
    const report = query.data;
    const items = report?.items ?? [];
    const failed = query.error !== null;
    const message = query.error instanceof Error ? query.error.message : 'api is not reachable';
    return {
      items,
      blocker: items.find((item) => item.status === 'fail') ?? null,
      error: failed && !report ? message : null,
      loading: !failed && (!report || (items.length === 0 && report.checkedAt === null)),
      refreshFailed: failed && report !== undefined,
      checkedAt: report?.checkedAt ?? null,
      load: report?.load ?? null,
    };
  }, [query.data, query.error]);
  return <ReadinessContext.Provider value={value}>{children}</ReadinessContext.Provider>;
}

export function useReadiness(): Readiness {
  return useContext(ReadinessContext);
}
