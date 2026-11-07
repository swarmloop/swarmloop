'use client';

import { useCallback, useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { StepEvent } from '@contract/step-events';
import { getStepEvents } from '../../../lib/endpoints';
import { useLiveBridge } from '../../shell';

const POLL_MS = 3000;

/**
 * Every event of a step (of the run when `step` is null), in `seq` order. `events` is null while they load, and when there is no cursor yet. The list is read once;
 * after that only the events past the last held `seq` are read and appended. They are read when the cursor moves, when the live socket says the step appended
 * events, and every 3 s while `running` with the socket down.
 */
export function useStepEvents(
  runKey: string,
  step: string | null,
  cursor: number | null,
  running: boolean,
): { events: StepEvent[] | null; error: string | null } {
  const client = useQueryClient();
  const queryKey = [runKey, step];
  const query = useQuery({
    queryKey,
    queryFn: async () => {
      const held = client.getQueryData<StepEvent[]>(queryKey) ?? [];
      const events = [...held];
      let after = events.length > 0 ? events[events.length - 1].seq : 0;
      for (;;) {
        const page = await getStepEvents(runKey, step, after);
        events.push(...page.events.filter((event) => event.seq > after));
        if (page.next === null) {
          return events;
        }
        after = page.next;
      }
    },
    enabled: cursor !== null,
  });
  const { refetch } = query;
  // Nothing held means the first read is still to come (or under way); it needs no refresh.
  const refresh = useCallback((): void => {
    if (client.getQueryData([runKey, step]) !== undefined) {
      void refetch();
    }
  }, [client, runKey, step, refetch]);

  const pushed = useLiveBridge((snapshot) => snapshot.events);
  const connected = useLiveBridge((snapshot) => snapshot.connected);
  useEffect(refresh, [refresh, cursor]);
  useEffect(() => {
    if (pushed && pushed.key === runKey && (step === null || pushed.step === step)) {
      refresh();
    }
  }, [refresh, pushed, runKey, step]);
  useEffect(() => {
    if (!running || connected) {
      return;
    }
    const timer = setInterval(refresh, POLL_MS);
    return () => clearInterval(timer);
  }, [refresh, running, connected]);

  if (query.error) {
    return { events: null, error: query.error.message };
  }
  return { events: query.data ?? null, error: null };
}
