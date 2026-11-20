import { keepPreviousData, useQuery } from '@tanstack/react-query';
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
  const query = useQuery({ queryKey: ['backlogs', stamp], queryFn: listBacklogs, placeholderData: keepPreviousData });
  return {
    backlogs: query.data ?? [],
    loaded: query.isSuccess,
    error: query.error ? query.error.message : null,
  };
}
