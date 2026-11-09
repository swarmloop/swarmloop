'use client';

import type { ReactElement, ReactNode } from 'react';
import { createContext, useContext, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { ReadinessItem } from '@contract/api';
import { getReadiness } from '../../lib/endpoints';

interface Readiness {
  items: ReadinessItem[];
  /** The first item that fails: a run cannot start while there is one. Null when none fails, and when the report cannot be read. */
  blocker: ReadinessItem | null;
  /** The text of a failed request for the report. */
  error: string | null;
}

/** Without a provider nothing is known, so nothing blocks. */
const ReadinessContext = createContext<Readiness>({ items: [], blocker: null, error: null });

export function ReadinessProvider({ children }: { children: ReactNode }): ReactElement {
  const query = useQuery({ queryKey: ['readiness'], queryFn: getReadiness });
  const value = useMemo<Readiness>(() => {
    const items = query.data?.items ?? [];
    const error = query.error ? (query.error instanceof Error ? query.error.message : 'api is not reachable') : null;
    return { items, blocker: items.find((item) => item.status === 'fail') ?? null, error };
  }, [query.data, query.error]);
  return <ReadinessContext.Provider value={value}>{children}</ReadinessContext.Provider>;
}

export function useReadiness(): Readiness {
  return useContext(ReadinessContext);
}
