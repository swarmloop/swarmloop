'use client';

import { useEffect } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import type { StepEvent } from '@contract/step-events';
import { getStepEvents } from '../../../lib/endpoints';

/**
 * Every event of a step (of the run when `step` is null), in `seq` order, as each page arrives. `events` is null while they load, and when there is no cursor yet. A new
 * cursor (new events in the run) is a new query, so the list is read again.
 */
export function useStepEvents(
  runKey: string,
  step: string | null,
  cursor: number | null,
): { events: StepEvent[] | null; error: string | null } {
  const query = useInfiniteQuery({
    queryKey: [runKey, step, cursor],
    queryFn: ({ pageParam }) => getStepEvents(runKey, step, pageParam),
    initialPageParam: 0,
    getNextPageParam: (page) => page.next ?? undefined,
    enabled: cursor !== null,
    // New events of the same step replace the list in place, so the feed keeps its scroll and filter.
    placeholderData: (previous, previousQuery) =>
      previousQuery?.queryKey[0] === runKey && previousQuery.queryKey[1] === step ? previous : undefined,
  });
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = query;
  useEffect(() => {
    if (hasNextPage && !isFetchingNextPage) {
      void fetchNextPage();
    }
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);
  if (query.error) {
    return { events: null, error: query.error.message };
  }
  if (!query.data) {
    return { events: null, error: null };
  }
  return { events: query.data.pages.flatMap((page) => page.events), error: null };
}
