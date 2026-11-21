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

/** The backlogs, loaded again when any backlog's stamp moves. */
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
  return {
    backlogs: query.data ?? [],
    loaded: query.isSuccess,
    error: query.error ? query.error.message : null,
  };
}
