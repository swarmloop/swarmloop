import { useCallback, useEffect, useRef, useState } from 'react';
import type { RemoteListView } from '@contract/api';
import { listRemote, refreshRemote } from '../../../lib/endpoints';
import { useCommandEnds, useOnReconnect } from '../../shell';

interface RemoteList {
  remote: RemoteListView | null;
  /** The message of the last read that failed; the last list stays. */
  error: string | null;
  /** Reads the list again. */
  reload: () => void;
  /** Clears the error and asks the server to refresh again. */
  retry: () => void;
}

/** The remote repositories: read when the dialog opens, while the server still loads them, and after a reconnect. */
export function useRemoteList(open: boolean): RemoteList {
  const [remote, setRemote] = useState<RemoteListView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ends = useCommandEnds();
  const loading = useRef(false);
  loading.current = remote?.loading === true;

  const read = useCallback((load: () => Promise<RemoteListView>): void => {
    load()
      .then((view) => {
        setRemote(view);
        setError(null);
      })
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : 'remote list failed'));
  }, []);
  const reload = useCallback(() => read(listRemote), [read]);
  const retry = useCallback(() => {
    setError(null);
    read(refreshRemote);
  }, [read]);

  useEffect(() => {
    if (open) {
      reload();
    }
  }, [open, reload]);
  const seen = useRef(ends);
  useEffect(() => {
    if (seen.current !== ends) {
      seen.current = ends;
      if (open && loading.current) {
        reload();
      }
    }
  }, [open, ends, reload]);
  useOnReconnect(
    useCallback(() => {
      if (open) {
        reload();
      }
    }, [open, reload]),
  );

  return { remote, error, reload, retry };
}
