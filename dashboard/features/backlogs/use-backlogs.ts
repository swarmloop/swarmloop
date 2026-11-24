'use client';

import { useEffect, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { BacklogView } from '@contract/backlog';
import { listBacklogs } from '../../lib/backlog-endpoints';
import { useLiveBridge } from '../shell';

interface BacklogsState {
  backlogs: BacklogView[];
  loaded: boolean;
  error: string | null;
}

/** The backlogs, loaded again when any backlog's stamp moves and after a reconnect. */
export function useBacklogs(): BacklogsState {
  const stamp = useLiveBridge((snapshot) =>
    Object.values(snapshot.backlogStamps).reduce((sum, value) => sum + value, 0),
  );
  const client = useQueryClient();
  const query = useQuery({ queryKey: ['backlogs'], queryFn: listBacklogs });
  const seen = useRef(stamp);
  useEffect(() => {
    if (seen.current !== stamp) {
      seen.current = stamp;
      void client.invalidateQueries({ queryKey: ['backlogs'] });
    }
  }, [client, stamp]);
  // A reconnect (the socket connected before) may follow missed changes; the first connect reads nothing extra.
  const connects = useLiveBridge((snapshot) => snapshot.connects);
  const seenConnects = useRef(connects);
  useEffect(() => {
    if (seenConnects.current >= 1 && connects > seenConnects.current) {
      void client.invalidateQueries({ queryKey: ['backlogs'] });
    }
    seenConnects.current = connects;
  }, [client, connects]);
  return {
    backlogs: query.data ?? [],
    loaded: query.data !== undefined,
    error: query.error ? query.error.message : null,
  };
}
