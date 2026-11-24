import { useEffect, useRef } from 'react';
import { useLiveBridge } from './use-live-bridge';

/**
 * Runs `reload` when the socket connects again after it had connected before: a reconnect may follow missed changes, and
 * the first connect reads nothing extra.
 */
export function useOnReconnect(reload: () => void): void {
  const connects = useLiveBridge((snapshot) => snapshot.connects);
  const seen = useRef(connects);
  useEffect(() => {
    if (seen.current >= 1 && connects > seen.current) {
      reload();
    }
    seen.current = connects;
  }, [connects, reload]);
}
