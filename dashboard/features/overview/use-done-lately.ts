'use client';

import { useCallback, useEffect, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { DoneLatelyItem } from '@contract/overview-done';
import { getDoneLately } from '../../lib/endpoints';
import { useLiveBridge, useOnReconnect } from '../shell';

const KEY = ['overview-done'];

interface DoneLately {
  items: DoneLatelyItem[];
  /** The items have arrived, from the read or from the live event; a read that fails afterwards keeps them. */
  loaded: boolean;
  /** The read failed and no items ever arrived. */
  failed: boolean;
}

/**
 * The items of Done lately: read once when the Overview opens, then followed through the live `done` event. They are
 * read again on a reconnect and, after a failed read, on the next live connect.
 */
export function useDoneLately(): DoneLately {
  const client = useQueryClient();
  const live = useLiveBridge((snapshot) => snapshot.done);
  const connects = useLiveBridge((snapshot) => snapshot.connects);
  const query = useQuery({ queryKey: KEY, queryFn: getDoneLately });
  const failed = useRef(false);
  failed.current = query.isError;

  // An answer still on its way is older than the event: drop it before the event's items are set.
  useEffect(() => {
    if (live !== null) {
      void client.cancelQueries({ queryKey: KEY }).then(() => client.setQueryData(KEY, live));
    }
  }, [client, live]);

  const reread = useCallback(() => {
    void client.invalidateQueries({ queryKey: KEY }, { cancelRefetch: false });
  }, [client]);
  useOnReconnect(reread);
  useEffect(() => {
    if (connects > 0 && failed.current) {
      reread();
    }
  }, [connects, reread]);

  return {
    items: query.data ?? [],
    loaded: query.data !== undefined,
    failed: query.isError && query.data === undefined,
  };
}
